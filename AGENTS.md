# AGENTS.md — Tab 录制大师

> 本文面向 AI 编码代理，介绍本项目的架构、约定与工作流程。阅读本文前不需要任何项目背景知识。

## 项目概述

「Tab 录制大师」是一个 **Manifest V3 Chrome 扩展**，核心功能：

- 录制**当前标签页**（画面 + 标签页声音，经 `tabCapture`），Chrome 最小化 / popup 关闭均不中断
- 录制**窗口 / 整个屏幕**（经 `getDisplayMedia`，含系统音频）
- **云桌面兼容模式**：RDP 下 tabCapture 音频劫持失效时，画面走 tabCapture（仅视频）、声音走 getDisplayMedia 系统音频
- 可设定录制时长（定时停止）、分辨率、帧率、比特率、录制前倒计时
- 暂停 / 恢复 / 丢弃；最近 5 次录制历史显示在弹窗
- 输出 **WebM**（内置 EBML 修复使其可拖动进度条），可选 **MP4**（依赖手动放入的 ffmpeg.wasm 内核）

**完全离线，无任何数据上传。无 host_permissions，无 `tabs` 权限。**

## 技术栈与构建

- **纯原生 JavaScript + HTML/CSS**，无任何框架、无 npm 依赖、无打包器、无 `package.json`
- 代码全部是经典脚本（非 ES module）：工具文件用 IIFE 把全局函数挂到 `self` 上（如 `G.fixWebMBlob = ...`），HTML 里按依赖顺序用多个 `<script src>` 加载
- 没有构建步骤。安装 = `chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」，选择本目录
- 改完代码后在该页面点扩展的「重新加载」按钮即可生效（service worker 改动必须重载扩展）
- 可选的 ffmpeg.wasm 内核用 `npm i @ffmpeg/core@0.12.10` 仅为取出 `dist/` 下的两个文件（见下文「MP4 输出」），不构成项目的构建依赖

## 运行时架构

MV3 service worker 会被回收，无法长时间持有 `MediaRecorder`，所以录制引擎放在与 worker 生命周期解耦的上下文里。三个持久上下文 + 一个无状态中转：

```
popup.html/js (UI 薄层)
    │  chrome.runtime.sendMessage: START/STOP/PAUSE/RESUME/DISCARD_RECORDING, GET_STATE
    ▼
background.js (service worker：状态机 + 消息路由，不直接录制)
    │  tab 模式  → chrome.runtime.sendMessage (target:'offscreen')
    │  desktop/兼容模式 → chrome.tabs.sendMessage → recorder 窗口
    ▼
offscreen.html/js          recorder.html/js（独立 popup 窗口）
（标签页录制引擎，无 UI）    （窗口/屏幕/兼容模式，带 UI）
    └────── 两者都基于 core-recorder.js 的 createRecorderEngine ──────┘
```

- **为什么 tab 录制在 offscreen document**：offscreen 独立于任何窗口存活，popup 关闭、Chrome 最小化都不影响其 `MediaRecorder`（`background.js` 中 `ensureOffscreen()` 创建，reasons: `USER_MEDIA, DISPLAY_MEDIA, AUDIO_PLAYBACK`）
- **为什么窗口/屏幕录制必须开可见窗口**：`getDisplayMedia` 要求可见页面内的用户手势；该窗口可最小化，媒体流与可见性无关
- **streamId 跨上下文传递**：`chrome.tabCapture.getMediaStreamId` 只能在 service worker 调用，offscreen 拿到 id 后用 `getUserMedia({ chromeMediaSource: 'tab', chromeMediaSourceId })` 消费
- **防静音回环**：tabCapture 会「劫持」标签页音频导致用户听不到。`offscreen.js` 用 `AudioContext` 把音频接回 `destination`（受 popup 的「录制时保持标签页声音」开关控制）
- **SW 状态持久化**：`background.js` 把 state 镜像到 `chrome.storage.session`（key: `recorderState`），SW 被回收唤醒后先 `await stateReady` 再路由消息。改动 state 必须走 `setState()` 统一入口

## 目录结构与模块划分

```
manifest.json         # MV3 清单（权限、CSP，见「安全注意事项」）
background.js         # service worker：全局状态机 (idle|countdown|recording|paused)、
                      # 消息路由、getMediaStreamId、offscreen/录制窗口生命周期、历史记录
popup.html / popup.js # 主弹窗 UI。薄层：发指令给 background、1.5s 轮询 GET_STATE 同步 UI、
                      # 读写 chrome.storage.local 的 recorderSettings / recordingHistory
offscreen.html / offscreen.js   # 标签页录制宿主（无 UI）。OFF_* 消息 → engine 方法；
                                # getStream 用 tabCapture 一次拿视频+音频；AudioContext 回环
recorder.html / recorder.js     # 窗口/屏幕/兼容模式录制窗口。URL hash 传配置；
                                # 三种 getStream 实现；beforeunload 关窗保护（录制中关窗丢视频）
core-recorder.js      # 公共录制引擎 createRecorderEngine({ getStream, onEvent, releaseExtra })。
                      # MediaRecorder 生命周期、分片累积（60s compact 一次）、定时停止、
                      # onStopped 异步链：fix-webm → 可选 MP4 处理 → 触发下载 → 上报历史
fix-webm.js           # 手写 EBML 解析器：重建 Cues 索引 + 修补 Duration，纯 JS 无依赖。
                      # 注释为英文（移植自 ScreenCap Pro v1.4.1），修改时保持英文注释风格
transcoder.js         # ffmpeg 主线程入口（懒加载）：webmToMp4(blob) / mp4Faststart(blob)，
                      # 内部把任务 postMessage 给 worker；超时随输入大小缩放，超时 terminate 重建
transcoder-worker.js  # Web Worker 宿主：importScripts 加载 ffmpeg-core.js、callMain 跑转码、
                      # 单例 core 实例跨任务复用。worker 内无 chrome.* API，coreURL 由主线程传入
lib/ffmpeg/           # ffmpeg.wasm 内核存放处（默认只有 README.txt，内核不进版本库）
icons/                # 16/48/128 PNG 图标
```

**HTML 脚本加载顺序是硬性依赖**（offscreen.html 与 recorder.html 一致）：
`fix-webm.js` → `transcoder.js` → `core-recorder.js` → 上下文脚本（`offscreen.js` / `recorder.js`）。core-recorder 运行期依赖前两者暴露的全局 `fixWebMBlob` / `webmToMp4` / `mp4Faststart`。

## 消息协议（改代码时保持兼容）

- popup → background：`START_RECORDING`（带 `source: 'tab'|'window'|'screen'`、`compatMode`、分辨率/fps/quality/timeLimit/outputFormat/countdownSec 等）、`STOP/PAUSE/RESUME/DISCARD_RECORDING`、`GET_STATE`（1.5s 轮询）
- background → 录制引擎：`OFF_START`（仅 offscreen，带 streamId）、`OFF_STOP`、`OFF_PAUSE`、`OFF_RESUME`、`OFF_DISCARD`。tab 模式经 `chrome.runtime.sendMessage`（带 `target: 'offscreen'` 过滤）；desktop 模式经 `chrome.tabs.sendMessage(recorderTabId, ...)`
- 引擎 → background：offscreen 发 `RECORDING_STOPPED`、`FILE_SIZE_UPDATE`、`COUNTDOWN_TICK`；recorder 窗口发 `RECORDER_STARTED`、`RECORDER_STOPPED`、`FILE_SIZE_UPDATE`。停止时带 `historyEntry` 供 background 存历史

引擎内部事件（`onEvent` 回调）：`started / paused / resumed / tick / size / processing / stopped / saved`。

## MP4 输出（可选，三档自动降级）

`lib/ffmpeg/` 默认不含内核（约 30MB，不随扩展打包，`.gitignore` 中有对应注释掉的规则）。启用：

```bash
npm i @ffmpeg/core@0.12.10
cp node_modules/@ffmpeg/core/dist/ffmpeg-core.{js,wasm} lib/ffmpeg/
```

只需这 2 个文件；`ffmpeg-core.worker.js` 是多线程版 `@ffmpeg/core-mt` 的文件，0.12 单线程版不存在也不需要（ffmpeg 跑在扩展自带的 `transcoder-worker.js` 里）。

「输出格式 = MP4」时的三档行为：
1. Chrome 130+ 原生支持 MP4 录制 + 有内核 → 原生录 H.264/AAC，结束后 `mp4Faststart`（`-c copy` 流复制搬 moov，不重编码）
2. Chrome 130+ 但无内核 → 原生录制，但 moov 在文件尾，**进度条拖不动**
3. 老 Chrome 无原生 MP4 → 先录 WebM，结束后 `webmToMp4`（libx264 重编码，慢）；无内核或失败自动回退 `.webm`

WebM 输出与全部录制功能**不依赖**该内核。

## 测试与验证

**项目没有自动化测试、lint 或 CI。** 验证方式为手工测试：

- 静态检查：改完 JS 可用 `node --check <file>` 验证语法（注意 worker/offscreen 里的 `chrome.*` API 在 node 下不存在，仅做语法检查）
- 功能验证按 README 的「🧪 验证清单」逐项手工过：
  - 标签页录制 + 最小化 Chrome 30s → 文件正常且进度条可拖
  - 定时停止 10s → 到点自动保存
  - 切换分辨率 → 输出分辨率正确
  - 窗口模式录制成功
  - 放入 ffmpeg 内核后 MP4 输出得到 `.mp4`
  - 兼容模式能采集到系统音频

## 代码风格约定

- **注释与文档主语言为中文**；代码标识符（变量、函数、消息类型）用英文。例外：`fix-webm.js` 为英文注释（移植代码），保持其原风格
- 每个 JS 文件开头有块注释说明职责与设计理由（「为什么」多于「做什么」）；较长的文件用 `/* ═══...═══ 分节标题 ═══...═══ */` 风格的横幅注释分节
- 不用框架、不引依赖、不用构建工具；新功能优先写成小型 IIFE 全局模块，沿用现有的 `chrome.runtime.onMessage` 路由模式
- 异步消息监听一律 `return true` 表示异步回复；`chrome.*` 回调式 API 按需包成 Promise
- 错误处理偏防御式：跨上下文通信包 `try/catch` 静默兜底（对方可能已销毁），媒体/转码失败要优雅降级（如 MP4 失败回退 WebM）而不是炸掉录制
- 修改录制流程时注意：`onStopped` 是异步链，期间 `isBusy()` 为 true，关窗会丢视频（recorder.js 的 beforeunload 依赖它）

## 安全注意事项

- **权限最小化**：仅 `tabCapture`（录标签页画面与声音）、`activeTab`（取当前活动标签，不枚举）、`offscreen`（创建 offscreen document）、`storage`（设置与历史）。**不要新增 host_permissions 或 `tabs` 权限**
- **绝不添加 `web_accessible_resources`**：worker 与 ffmpeg 内核均由扩展页面同源加载，WAR 只会把资源暴露给任意网页、让扩展可被指纹识别
- `manifest.json` 的 CSP 必须保留 `'wasm-unsafe-eval'`（MV3 下跑 ffmpeg wasm 必需）：`script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`
- 扩展完全离线：不要引入任何网络请求、遥测或远程代码
- `*.pem`（扩展签名私钥）、`.env*` 等凭证文件已在 `.gitignore` 中，切勿提交

## 部署 / 发布

- 开发态：chrome://extensions → 开发者模式 → 加载已解压目录
- 发布打包：把目录压成 zip 上传 Chrome Web Store（`dist/`、`*.zip`、`*.crx` 已被 gitignore）；发布前确认 `lib/ffmpeg/` 里没有误打入 30MB 内核（按设计内核由用户自行放置）
- 版本号在 `manifest.json` 的 `version` 字段维护

## 参考致谢

基础架构与 `fix-webm.js` 参考自 ScreenCap Pro v1.4.1（开源录制扩展），本项目在其上聚焦「标签页录制」，新增分辨率/帧率/比特率显式控制与可选 MP4 转码。
