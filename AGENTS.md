# AGENTS.md — Tab 录制大师

> 本文面向 AI 编码代理，介绍本项目的架构、约定与工作流程。阅读本文前不需要任何项目背景知识。

## 项目概述

「Tab 录制大师」是一个 **Manifest V3 Chrome 扩展**，核心功能：

- 录制**当前标签页**（画面 + 标签页声音，经 `tabCapture`），Chrome 最小化 / popup 关闭均不中断
- 录制**窗口 / 整个屏幕**（经 `getDisplayMedia`，含系统音频）
- **云桌面兼容模式**：RDP 下 tabCapture 音频劫持失效时，画面走 tabCapture（仅视频）、声音走 getDisplayMedia 系统音频
- 可设定录制时长（定时停止）、分辨率、帧率、比特率、录制前倒计时
- 暂停 / 恢复 / 丢弃；最近 5 次录制历史显示在弹窗
- 输出 **WebM**（内置 SeekHead/关键帧 Cues/Duration 修复，Chrome 与 WMP 可拖动），原生 **MP4**（faststart + fMP4 时长重建），老 Chrome 可选 ffmpeg.wasm 转码
- **窗口/屏幕/兼容模式统一在 recorder 操作**：准备阶段不提前计时，实际开始后才计时；主 popup 显示状态并聚焦原窗口
- **保存状态全程可见**：独立保存窗口 / recorder 窗口 / popup 同步；真实下载 complete 后才显示已保存并写历史，失败可重试或明确丢弃

**完全离线，无任何数据上传。无 host_permissions，无 `tabs` 权限。**

## 技术栈与构建

- **纯原生 JavaScript + HTML/CSS**，无任何框架、无 npm 依赖、无打包器、无 `package.json`
- 代码全部是经典脚本（非 ES module）：工具文件用 IIFE 把全局函数挂到 `self` 上（如 `G.fixWebMBlob = ...`），HTML 里按依赖顺序用多个 `<script src>` 加载
- 没有构建步骤。安装 = `chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」，选择本目录
- 改完代码后在该页面点扩展的「重新加载」按钮即可生效（service worker 改动必须重载扩展）
- 可选的 ffmpeg.wasm 内核用 `npm i @ffmpeg/core@0.12.10` 仅为取出 `dist/` 下的两个文件（见下文「MP4 输出」），不构成项目的构建依赖

## 运行时架构

MV3 service worker 会被回收，无法长时间持有 `MediaRecorder`，所以录制引擎放在与 worker 生命周期解耦的上下文里。录制上下文 + 一个下载状态中转：

```
popup.html/js (UI 薄层)
    │  chrome.runtime.sendMessage: START/STOP/PAUSE/RESUME/DISCARD_RECORDING, GET_STATE
    ▼
background.js (service worker：状态机 + 消息路由 + 下载结果对账，不直接录制)
    │  tab 模式  → chrome.runtime.sendMessage (target:'offscreen')
    │  desktop/兼容模式 → chrome.tabs.sendMessage → recorder 窗口
    ▼
offscreen.html/js          recorder.html/js（独立 popup 窗口）
（标签页录制引擎，无 UI）    （窗口/屏幕/兼容模式，带 UI 和保存状态）
    └────── 两者都基于 core-recorder.js 的 createRecorderEngine ──────┘
              │  saveFile(blob, filename) → saveFileViaBackground
              ▼
        save-file.js → background chrome.downloads
save-status.html/js（tab 模式停止后自动打开的可见保存窗口）
```

- **为什么 tab 录制在 offscreen document**：offscreen 独立于任何窗口存活，popup 关闭、Chrome 最小化都不影响其 `MediaRecorder`（`background.js` 中 `ensureOffscreen()` 创建，reasons: `USER_MEDIA, DISPLAY_MEDIA, AUDIO_PLAYBACK`）
- **为什么窗口/屏幕录制必须开可见窗口**：`getDisplayMedia` 要求可见页面内的用户手势；该窗口可最小化，媒体流与可见性无关
- **为什么 tab 停止后还需要 save-status 窗口**：offscreen 没有 UI，仅依赖 popup 会让用户误以为保存结束。background 在 `ENGINE_PROCESSING.active=true` 时打开/聚焦 `save-status.html`；手动关闭只丢 UI 句柄，可用 `OPEN_SAVE_WINDOW` 重开，不影响引擎
- **为什么下载由 background 执行**：offscreen 仅支持 runtime 扩展 API，不能直接调用 `chrome.downloads`。`save-file.js` 创建 Blob URL，background 下载并用 `downloadId`/`storage.session` 对账；complete/interrupted 后才 revoke URL
- **streamId 跨上下文传递**：`chrome.tabCapture.getMediaStreamId` 只能在 service worker 调用。引擎（offscreen / recorder 窗口）在倒计时/选屏结束后发 `GET_STREAM_ID` 现取，background 取好返回，引擎立即用 `getUserMedia({ chromeMediaSource: 'tab', chromeMediaSourceId })` 消费——id 应尽快消费，不要提前取好再等待
- **防静音回环**：tabCapture 会「劫持」标签页音频导致用户听不到。`offscreen.js` 用 `AudioContext` 把音频接回 `destination`（受 popup 的「录制时保持标签页声音」开关控制）
- **SW 状态持久化**：`background.js` 把 state 镜像到 `chrome.storage.session`（key: `recorderState`），包含 `processing`、`savePhase`、`processingStage`、`downloadId`、`saveCanRetry`、`saveReceived/saveTotal` 等；SW 被回收唤醒后先 `await stateReady` 再路由消息。改动 state 必须走 `setState()` 统一入口

## 目录结构与模块划分

```
manifest.json         # MV3 清单（权限、CSP，见「安全注意事项」）
background.js         # service worker：全局状态机、消息路由、getMediaStreamId、下载结果对账、
                      # offscreen/保存窗口生命周期、历史记录
popup.html / popup.js # 主弹窗 UI。薄层：发指令给 background、1.5s 轮询 GET_STATE 同步 UI、
                      # 保存阶段/下载进度/失败重试与「打开保存进度」入口
offscreen.html / offscreen.js   # 标签页录制宿主（无 UI）。OFF_* 消息 → engine 方法；
                                # getStream 用 tabCapture 一次拿视频+音频；AudioContext 回环
recorder.html / recorder.js     # 窗口/屏幕/兼容模式录制窗口。URL hash 传配置；
                                # 三种 getStream 实现；保存阶段显示、失败重试、beforeunload 关窗保护
save-status.html / save-status.js # 标签页专用可见保存窗口：阶段、真实进度、完成、失败重试/丢弃
save-file.js          # Blob URL 适配器：runtime 交 background 下载，轮询终态后才 revoke
core-recorder.js      # 公共录制引擎 createRecorderEngine({ getStream, onEvent, releaseExtra, saveFile })。
                      # MediaRecorder 生命周期、分片累积、定时停止；onStopped 异步链：
                      # fix-webm / MP4 处理 → await 下载 complete → saved/history；
                      # 失败保留最终 Blob，retrySave 只重试下载，明确丢弃才释放
fix-webm.js           # 手写 EBML 解析器：补 SeekHead + 只为真实视频关键帧重建 Cues + 修补 Duration。
                      # 从 Tracks 识别视频轨；SimpleBlock 看 keyframe 位，BlockGroup 看 ReferenceBlock；
                      # CueTime=Cluster.Timecode+Block 相对时间码，CueTrack 为真实视频轨号。
                      # 必须有合法 Cluster.Timestamp；BlockGroup 子元素须完整解析到组尾，
                      # 缺失/晚到时间码前的 Block、截断 ReferenceBlock 均不猜关键帧。
                      # SeekPosition/CueClusterPosition 均相对 Segment 数据区；头部插入统一计位移。
                      # 流式实现（生产路径）：256KB 滑窗扫描 + 稀疏编辑 + Blob.slice 拼装，
                      # 跳过音频/媒体负载，内存 O(窗口+Cues)；legacy 全量实现保留为 golden 对照
                      # （e2e/unit-webmstream.mjs + lib-webmcheck.mjs 校验落点和实际关键帧）。
                      # 幻影防护：只采信第一个解析干净的 Info；Cluster 前扫的候选须过结构校验
                      # （否则负载里的同字节幻影会出轨扫描、把编辑写进媒体数据——真实踩坑）
mp4-faststart.js      # 常规 MP4 faststart + 已 faststart fMP4 的 mvhd/tkhd/mdhd 时长重建。
                      # 只读 moov/moof（tfhd/tfdt/trun/trex），mdat/moof/mfra 原样保留；
                      # 内存 O(moov+单个 moof+分片元数据)，GB 级长视频可用（替代 wasm 方案）
                      # 分片 moov-at-end 的纯 JS 支持仍是待办：docs/todo/moov-at-end-fmp4.md
                      # 注释为英文（移植自 ScreenCap Pro v1.4.1），修改时保持英文注释风格
transcoder.js         # ffmpeg 主线程入口（懒加载）：webmToMp4(blob) / mp4Faststart(blob)，
                      # 内部把任务 postMessage 给 worker；超时随输入大小缩放，超时 terminate 重建
transcoder-worker.js  # Web Worker 宿主：importScripts 加载 ffmpeg-core.js、callMain 跑转码、
                      # 单例 core 实例跨任务复用。worker 内无 chrome.* API，coreURL 由主线程传入
lib/ffmpeg/           # ffmpeg.wasm 内核存放处（默认只有 README.txt，内核不进版本库）
icons/                # 16/48/128 PNG 图标
```

**HTML 脚本加载顺序是硬性依赖**（offscreen.html 与 recorder.html 一致）：
`fix-webm.js` → `mp4-faststart.js` → `transcoder.js` → `save-file.js` → `core-recorder.js` → 上下文脚本（`offscreen.js` / `recorder.js`）。core-recorder 运行期依赖前两者暴露的全局 `fixWebMBlob` / `mp4FaststartJs` / `webmToMp4` / `mp4Faststart`，并由宿主注入 `saveFile: saveFileViaBackground`。

## 消息协议（改代码时保持兼容）

- `state.status`：`idle | preparing | countdown | recording | paused`。desktop/compat 创建 recorder 窗口后是 `preparing` 且 `startTime=0`，选择期间不累计录制时长；原生取流取消/失败（`captureFailed:true`）保持 preparing 和原窗口 ID，支持同窗口重试。`RECORDER_STARTED` 仅接受当前 desktop 窗口的 preparing→recording 转换，重复/错误来源不重置计时。准备中 STOP 关闭等待窗口，不进入保存链；聚焦失效经 `windows.get` 确认后清理并允许重开
- popup → background：`START_RECORDING`（带 `source: 'tab'|'window'|'screen'`、`compatMode`、分辨率/fps/quality/timeLimit/outputFormat/countdownSec 等；非 idle 或保存处理中时会被拒绝——重入守卫）、`STOP/PAUSE/RESUME/DISCARD_RECORDING`、`GET_STATE`（1.5s 轮询）、`OPEN_SAVE_WINDOW`、`RETRY_SAVE`、**desktop/compat 只用 `OPEN_RECORDER_WINDOW` 聚焦原 recorder 窗口，不重复提供停止/暂停入口**
- background → 录制引擎：`OFF_START`（仅 offscreen，带 `tabId`）、`OFF_STOP`、`OFF_PAUSE`、`OFF_RESUME`、`OFF_DISCARD`、`OFF_RETRY_SAVE`。tab 模式经 `chrome.runtime.sendMessage`（带 `target: 'offscreen'` 过滤）；desktop 模式经 `chrome.tabs.sendMessage(recorderTabId, ...)`。streamId 不随 OFF_START 下发：`getMediaStreamId` 的 id 应尽快消费，引擎在倒计时/选屏结束后才发 `GET_STREAM_ID`（带 tabId）现取现用
- 引擎保存文件：`save-file.js` 创建 Blob URL 并发 `SAVE_FILE {url, filename}` 给 background，随后每秒 `GET_DOWNLOAD_STATUS {downloadId}` 直到 complete/interrupted；background 返回真实文件名、路径和 received/total
- 引擎 → background：offscreen 发 `RECORDING_STOPPED`、`FILE_SIZE_UPDATE`、`COUNTDOWN_TICK`、`ENGINE_PROCESSING`（含 stage）、`ENGINE_SAVE_ERROR`；recorder 窗口发 `RECORDER_STARTED`、`RECORDER_STOPPED`、`FILE_SIZE_UPDATE`、`ENGINE_PROCESSING`、`ENGINE_SAVE_ERROR`、`ENGINE_PAUSED`/`ENGINE_RESUMED`。停止时带 `historyEntry`（仅在下载 complete 后）与可选 `discarded`；取流取消/失败另带 `captureFailed:true`，与最终 stopped 区分

引擎内部事件（`onEvent` 回调）：`started / paused / resumed / tick / size / processing({active,stage}) / saveerror / stopped / saved`。

## MP4 输出（可选，三档自动降级）

`lib/ffmpeg/` 默认不含内核（约 30MB，不随扩展打包，`.gitignore` 中有对应注释掉的规则）。启用：

```bash
npm i @ffmpeg/core@0.12.10
cp node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.{js,wasm} lib/ffmpeg/
```

只需这 2 个文件；`ffmpeg-core.worker.js` 是多线程版 `@ffmpeg/core-mt` 的文件，0.12 单线程版不存在也不需要（ffmpeg 跑在扩展自带的 `transcoder-worker.js` 里）。

「输出格式 = MP4」时的行为：
1. 新版 Chrome 原生支持 MP4 录制 → 原生编码（Windows/macOS 多为 H.264/AAC，Linux 可为 VP9/Opus），结束后 `mp4FaststartJs`：常规 MP4 搬 moov，已 faststart 的 fMP4 则从 moof/trun/tfdt 重建 `mvhd/tkhd/mdhd` 真实时长；非常规布局或 stco 溢出才兜底 wasm `mp4Faststart`。**此路径不需要内核**
2. 老 Chrome 无原生 MP4 → 先录 WebM，结束后 `webmToMp4`（libx264 重编码，慢）；无内核或失败自动回退 `.webm`

即：内核只服务老版 Chrome 转码与兜底。WebM 输出与全部录制功能**不依赖**该内核；WebM 还会补规范 SeekHead，不能只验证 Chrome 播放，必须验证 Windows Media Foundation / WMP seek。

## 测试与验证

**E2E 测试在 `e2e/`**（Playwright + 系统 X11 + xdotool）：`cd e2e && npm i && npm test`。
- 单元：`unit-webmstream.mjs`（SeekHead/Cue 落点与实际视频关键帧）、`unit-mp4faststart.mjs`、`unit-native-mp4.mjs`、`unit-save-state.mjs`、`unit-save-engine.mjs`、`unit-save-ui.mjs`、`unit-popup-save.mjs`、`unit-popup-recorder.mjs`（准备态/实际计时/单一入口）、`unit-recorder-save.mjs`。
- 场景 A–E：完整录制、倒计时取消竞态、暂停中停止、原生 MP4、保存状态可见（延迟下载、popup 关闭、失败重试、明确丢弃）。
- Windows 没有 xdotool/WSL 时，可用 `E2E_MANUAL_SHORTCUT=1` 留出真实 Ctrl+Shift+E 按键窗口；`NATIVE_CHROME_BIN` 指定品牌 Chrome 做原生 MP4 测试。默认 Linux 路径与行为不变。
- 品牌版 Chrome ≥137 禁用 `--load-extension`（E2E 用 Playwright 自带 Chromium/CfT）；CfT 上 offscreen 偶发被提前回收（rig 局限，生产无此问题）。详见 `e2e/run.mjs` 头部注释。

**手工验证仍不可替代**（云桌面兼容模式等需要真实 RDP 环境）：
- 静态检查：改完 JS 可用 `node --check <file>` 验证语法（注意 worker/offscreen 里的 `chrome.*` API 在 node 下不存在，仅做语法检查）
- 功能验证按 README 的「🧪 验证清单」逐项手工过，必须包含：
  - WebM/MP4 在 Windows 媒体播放器前中后段拖动；WebM 不应先花屏。可用 Media Foundation 的 `CAN_SEEK`、`MF_PD_DURATION` 和 seek 后样本时间作客观对照，并用独立校验器检查全部 Cue 的视频关键帧
  - desktop/compat 选择画面和音频期间不提前计时；控制只在 recorder 窗口；定时停止、切换分辨率、兼容模式系统音频
  - 停止后关闭 popup 的保存可见性、失败重试、明确丢弃、service worker 回收后恢复
  - 尝试关闭保存窗口/Chrome，确认 beforeunload 边界；强制退出仍可能丢文件，不承诺绝对防丢

## 代码风格约定

- **注释与文档主语言为中文**；代码标识符（变量、函数、消息类型）用英文。例外：`fix-webm.js` 为英文注释（移植代码），保持其原风格
- 每个 JS 文件开头有块注释说明职责与设计理由（「为什么」多于「做什么」）；较长的文件用 `/* ═══...═══ 分节标题 ═══...═══ */` 风格的横幅注释分节
- 不用框架、不引依赖、不用构建工具；新功能优先写成小型 IIFE 全局模块，沿用现有的 `chrome.runtime.onMessage` 路由模式
- 异步消息监听一律 `return true` 表示异步回复；`chrome.*` 回调式 API 按需包成 Promise
- 错误处理偏防御式：跨上下文通信包 `try/catch` 静默兜底（对方可能已销毁），媒体/转码失败要优雅降级（如 MP4 失败回退 WebM）而不是炸掉录制
- 修改录制流程时注意：`onStopped` 是异步链，整理、下载及失败待处理期间 `isBusy()` 均为 true，关窗会丢视频（recorder.js 的 beforeunload 依赖它）；只有下载 complete 或明确丢弃才能解除

## 安全注意事项

- **权限最小化**：`tabCapture`（录标签页画面与声音）、`activeTab`（取当前活动标签，不枚举）、`offscreen`（创建 offscreen document）、`storage`（设置/历史/保存状态）、`downloads`（启动下载并确认 complete/interrupted）。**不要新增 host_permissions 或 `tabs` 权限，也不要增加其他非必要权限**
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
