# Tab 录制大师 — Chrome 扩展

一个 Manifest V3 的 Chrome 扩展，可录制**当前标签页**（包含标签页播放的声音），**Chrome 最小化后录制不中断**；额外支持录制**窗口 / 整个屏幕**；可设定**录制时长、分辨率、帧率、比特率**；输出 **WebM**，并**可选 MP4 转码**。

> 完全离线，无任何数据上传。

---

## ✨ 功能

| 能力 | 说明 |
|---|---|
| 📑 录制当前标签页 | 通过 `tabCapture` 同时录制画面与标签页声音；录制时标签页仍可发声（音频回环） |
| 🖥️ 录制窗口/屏幕 | 通过 `getDisplayMedia` 录制指定窗口或整个屏幕（含系统音频） |
| 🪟 最小化不中断 | 录制引擎位于 offscreen document（标签页）或独立窗口（桌面），与 Chrome 主窗口可见性解耦 |
| ⏳ 定时停止 | 可设定 时/分/秒，到点自动停止并保存；`0 = 不限` |
| 📐 分辨率/帧率/比特率 | 480p / 720p / 1080p / 1440p / 4K；15/24/30/60 fps；4/8/16 Mbps |
| ⏱️ 倒计时 | 录制前可选 3/5/10 秒倒计时 |
| ⏸️ 暂停 / 恢复 / 丢弃 | 录制中可暂停、恢复或丢弃 |
| 🎬 WebM 输出 | 原生 `MediaRecorder`，并修复 EBML 索引使其可拖动进度条 |
| 📦 可选 MP4 输出 | 新版 Chrome 原生录 H.264/AAC；老版本用 ffmpeg.wasm 转码（内核需自行放入，见下） |
| ☁️ 云桌面兼容模式 | RDP/云桌面下 tabCapture 音频劫持失效时的兜底方案 |
| 📜 历史记录 | 最近 5 次录制展示在弹窗 |

---

## 📁 目录结构

```
tab-recorder-ext/
├── manifest.json         # MV3 清单
├── background.js         # service worker：状态机 + 消息路由 + getMediaStreamId + offscreen 管理
├── offscreen.html        # 标签页录制引擎宿主（无 UI）
├── offscreen.js          # tab 录制：getUserMedia(tab) + 音频回环 + MediaRecorder
├── recorder.html         # 窗口/屏幕/兼容模式录制窗口 UI
├── recorder.js           # getDisplayMedia + 兼容模式 + MediaRecorder
├── popup.html            # 主弹窗 UI
├── popup.js              # UI 控制器 + 状态轮询
├── fix-webm.js           # EBML 修复（补 Cues/Duration，使 WebM 可拖动）
├── transcoder.js         # ffmpeg.wasm 主线程入口：webmToMp4(blob) / mp4Faststart(blob)
├── transcoder-worker.js  # Web Worker 宿主：在独立线程跑 ffmpeg，主线程不阻塞
├── icons/{16,48,128}.png
└── lib/ffmpeg/           # 可选：ffmpeg.wasm 内核（见下）
```

---

## 🚀 安装

1. 打开 `chrome://extensions`
2. 右上角开启 **「开发者模式」**
3. 点 **「加载已解压的扩展程序」**，选择 `tab-recorder-ext/` 目录
4. 工具栏出现 🎬 图标，点击即可使用

---

## 🎬 使用

1. 打开要录制的标签页（如网页视频/会议）
2. 点击扩展图标，选择「当前标签页」
3. 按需设置分辨率、帧率、比特率、定时停止、输出格式
4. 点红色录制按钮 →（倒计时后）开始
5. **此时可关闭弹窗、可最小化 Chrome，录制继续**
6. 停止后文件自动下载到默认下载目录

### 最小化不中断的原理

- **标签页模式**：录制引擎跑在 [offscreen document](https://developer.chrome.com/docs/extensions/reference/api/offscreen) 内，这是一个独立于任何窗口的后台页面，popup 关闭、Chrome 最小化都不影响其持有的 `MediaRecorder`。
- **窗口/屏幕模式**：扩展会弹出一个独立的 popup 窗口，其副标题写明「此窗口可最小化，录制不会中断」。`getDisplayMedia` / `getUserMedia` 的媒体流与窗口可见性无关。

### 防静音（重要）

`tabCapture` 会把标签页音频「劫持」走，导致录制时用户听不到声音。本扩展用 `AudioContext` 把音频接到扬声器做回环，勾选「录制时保持标签页声音」即可在录制时继续听到。

---

## 📦 可选：启用 MP4 输出

「输出格式」选 **MP4** 时，按环境自动走三档之一：

| 环境 | 行为 | 产物 |
|---|---|---|
| 新版 Chrome（原生支持 MP4 录制）＋ 已放入内核 | 原生录 H.264/AAC，结束后用 ffmpeg 做 **faststart**（流复制搬 moov，不重编码，秒级） | 可拖动的 `.mp4` |
| 新版 Chrome 但未放入内核 | 原生录制，但无法修 moov 位置 | 能播放、**进度条拖不动**的 `.mp4` |
| 老版本 Chrome（无原生 MP4） | 先录 WebM，结束后用 ffmpeg 转码（慢，长视频可达数十分钟） | 可拖动的 `.mp4`；无内核或转码失败回退 `.webm` |

可见无论哪条路径，想要「可用的 MP4」都离不开 ffmpeg 内核（faststart 或转码），建议按下文放入。内核体积较大（约 30MB），故未随扩展打包：

```bash
npm i @ffmpeg/core@0.12.10
```
把 `node_modules/@ffmpeg/core/dist/` 下的：
- `ffmpeg-core.js`
- `ffmpeg-core.wasm`

复制到 `lib/ffmpeg/`，然后在弹窗「输出格式」选择 **MP4**，重新加载扩展即可。

> 只需要这 2 个文件。`ffmpeg-core.worker.js` 不存在于 0.12 单线程版（它是 `@ffmpeg/core-mt` 多线程版的文件）——ffmpeg 现在跑在扩展自带的 `transcoder-worker.js` 里（独立的 Web Worker），转码期间 UI 完全不卡。

> manifest.json 已经配好了 MV3 必需的 `wasm-unsafe-eval` CSP 和 `web_accessible_resources`，无需手动改。

> 即便不放入内核、也不选 MP4，WebM 输出与全部录制功能均正常工作。

---

## ☁️ 云桌面兼容模式

在 RDP / 虚拟化 Chrome 环境下，`tabCapture` 的音频劫持可能静音。勾选「云桌面兼容模式」后：
- **画面**仍用 tabCapture 精确录制标签页（仅视频，不劫持音频 → 标签页仍可发声）
- **声音**改用 `getDisplayMedia` 从系统音频采集

开始时会弹出控制窗口，请在屏幕选择器中选择「整个屏幕」并勾选「分享系统音频」。

---

## 🔐 权限说明

| 权限 | 用途 |
|---|---|
| `tabCapture` | 录制标签页画面与声音 |
| `activeTab` | 获取当前活动标签页（不枚举任意标签） |
| `offscreen` | 创建 offscreen document 承载录制引擎 |
| `storage` | 保存设置与历史记录 |

**无 host_permissions，无 `tabs` 权限，完全离线。**

---

## 🧪 验证清单

- [ ] 标签页录制 + 最小化 Chrome 30s → 文件正常且可拖动进度
- [ ] 定时停止 10s → 到点自动保存
- [ ] 切换分辨率 1280×720 → 输出分辨率正确
- [ ] 窗口模式选择某窗口录制成功
- [ ] 勾选 MP4 输出（放入 ffmpeg 内核后）得到 `.mp4`
- [ ] 兼容模式下能采集到系统音频

---

## 🛠 技术要点

- **MV3 + offscreen document**：规避 service worker 被回收导致的录制中断
- **`getMediaStreamId` 跨上下文传递**：worker 取 streamId，offscreen 消费
- **EBML 修复（`fix-webm.js`）**：手写 EBML 解析器重建 `Cues` 索引、修补 `Duration`，纯 JS 无依赖
- **分片压缩**：每 60s 合并一次 `chunks`，防止长时间录制内存膨胀
- **Track `ended` 监听**：用户点 Chrome「停止共享」条时干净收尾

## 📝 参考致谢

基础架构与 `fix-webm.js` 参考自 ScreenCap Pro v1.4.1（开源录制扩展），并在此基础上聚焦「标签页录制」核心需求，新增分辨率/帧率/比特率显式控制与可选 MP4 转码。
