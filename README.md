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
| 🎬 WebM 输出 | 原生 `MediaRecorder`，补 SeekHead、关键帧 Cues 和 Duration，拖动时从真实关键帧开始解码，避免先花屏 |
| 📦 可选 MP4 输出 | 新版 Chrome 原生录制（编码随平台：Win/macOS 为 H.264/AAC，Linux 为 VP9/Opus-in-MP4）；老版本用 ffmpeg.wasm 转码 |
| 💾 保存状态可见 | 整理/转码/下载各阶段清晰可见；真实下载完成后才显示已保存，失败可重试或明确丢弃 |
| 🛡️ 长录制异常恢复 | 分片持续写入 OPFS 私有磁盘存储；浏览器异常后仍可恢复到最后确认分片 |
| ☁️ 云桌面兼容模式 | RDP/云桌面下 tabCapture 音频劫持失效时的兜底方案 |
| 📜 历史记录 | 最近 5 次录制展示在弹窗，且只在下载完成后写入 |

---

## 📁 目录结构

```
tab-recorder-ext/
├── manifest.json         # MV3 清单（含 downloads 权限）
├── background.js         # service worker：状态机 + 消息路由 + 下载结果对账 + 保存窗口管理
├── offscreen.html        # 标签页录制引擎宿主（无 UI）
├── offscreen.js          # tab 录制：getUserMedia(tab) + 音频回环 + MediaRecorder
├── recorder.html         # 窗口/屏幕/兼容模式录制窗口 UI
├── recorder.js           # getDisplayMedia + 兼容模式 + 保存状态与关窗保护
├── save-status.html/js   # 标签页专用可见保存窗口（进度、完成、失败重试）
├── save-file.js          # Blob URL 适配器：交给 background 下载并等待真实终态
├── core-recorder.js      # 公共录制引擎：录制、修复、等待下载完成、失败重试
├── durable-recorder.js   # 有界分片队列与恢复元数据上报
├── durable-writer-worker.js # OPFS 同步追加、flush、确认前缀与清理
├── recovery.js           # 异常 WebM/MP4 尾部恢复与暂存读取
├── popup.html            # 主弹窗 UI
├── popup.js              # UI 控制器 + 状态轮询
├── fix-webm.js           # EBML 修复（补 SeekHead/Cues/Duration）
├── mp4-faststart.js      # 常规 MP4 faststart + fMP4 时长重建（只读 moov/moof）
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
6. 停止后等待保存完成，文件自动下载到默认下载目录

### 最小化不中断的原理

- **标签页模式**：录制引擎跑在 [offscreen document](https://developer.chrome.com/docs/extensions/reference/api/offscreen) 内，这是一个独立于任何窗口的后台页面，popup 关闭、Chrome 最小化都不影响其持有的 `MediaRecorder`。
- **窗口/屏幕模式**：扩展会弹出一个独立的 popup 窗口，其副标题写明「此窗口可最小化，录制不会中断」。`getDisplayMedia` / `getUserMedia` 的媒体流与窗口可见性无关。

**窗口/屏幕/兼容模式的控制统一在 recorder 窗口完成**：开始、暂停、停止和丢弃都在该窗口操作；主弹窗只显示状态并提供「打开录制窗口」。选择画面和音频期间处于准备状态，尚未开始录制，实际开始后才显示并累计录制时间。取消选屏后可在原窗口重试；窗口关闭后则可重新开始。

### 防静音（重要）

`tabCapture` 会把标签页音频「劫持」走，导致录制时用户听不到声音。本扩展用 `AudioContext` 把音频接到扬声器做回环，勾选「录制时保持标签页声音」即可在录制时继续听到。

### 💾 保存状态与防误关

- **标签页模式**：停止后自动打开「保存状态」窗口；主弹窗关闭也不会影响保存。手动关闭进度窗口后，可从主弹窗的「打开保存进度」重新打开。
- **窗口/屏幕/兼容模式**：保存阶段继续显示在原 recorder 窗口中。
- 状态依次包括整理/修复、可选转码、下载落盘、保存完成。**只有 Chrome 下载真正完成（`complete`）后才显示“已保存”并写入历史**；开始下载不等于保存完成。
- 下载期间显示真实接收字节数和百分比（总大小未知时显示不确定状态），不会伪造进度。
- 录制分片通过 Dedicated Worker 持续写入 OPFS，并逐个 `flush()`；界面显示“已暂存”不等于已下载。正常停止后仍输出一个完整文件。
- **请在显示保存完成前不要关闭浏览器**。若浏览器或录制上下文异常终止，下次打开扩展会显示「发现未完成的录制」，可选择「恢复保存」或明确丢弃；恢复只到最后完整确认分片，少数尚未确认的数据可能丢失。
- 下载失败时保留最终 Blob 与 OPFS 暂存，可重试或明确丢弃。真实下载 `complete` 后才写历史并清理暂存；重启后会对账已有 downloadId，避免重复下载。
- OPFS 需要足够磁盘空间；系统断电、磁盘损坏、浏览器数据被清除不在绝对保障范围内。保存/恢复/可重试失败期间不能开始新录制，成功或明确丢弃后恢复。

---

## 📦 可选：启用 MP4 输出

「输出格式」选 **MP4** 时，按环境自动走三档之一：

| 环境 | 行为 | 产物 |
|---|---|---|
| 新版 Chrome（原生支持 MP4 录制） | 原生录制，结束后用内置纯 JS 做 faststart，并为分片 MP4 重建 `mvhd/tkhd/mdhd` 真实时长；只读 `moov/moof`，内存占用与文件大小无关 | Windows 媒体播放器可拖动的 `.mp4`，**无需内核** |
| 新版 Chrome 但 JS faststart 不适用（非常规 MP4） | 用 ffmpeg 内核做 faststart 兜底 | 可拖动的 `.mp4` |
| 老版本 Chrome（无原生 MP4） | 先录 WebM，结束后用 ffmpeg 内核转码（慢，长视频可达数十分钟） | 可拖动的 `.mp4`；无内核或转码失败回退 `.webm` |

WebM 保存时也会补规范的 `SeekHead`，并只为真实视频关键帧建立 `Cues`，使 Windows Media Foundation 能从关键帧开始解码，而不是仅让进度条可以拖动。

**MP4 布局边界**：普通 MP4 即使 `moov` 在末尾，纯 JS faststart 也能处理；**分片 MP4 且 `moov` 在末尾**暂未扩展纯 JS 支持，继续走可选 wasm 兜底。没有 wasm 或兜底失败时保留原始 MP4，不丢录制，但时长/索引可能仍未修复。前因后果、偏移风险与后续验收计划见 [`docs/todo/moov-at-end-fmp4.md`](docs/todo/moov-at-end-fmp4.md)。

**原生 MP4 的 4 GiB Chrome 缺陷（已定位）**：受影响的 Chrome 用 `uint32_t` 累计原生 MP4 输出，超过边界会触发 renderer SIGTRAP，并非 OPFS 或扩展 faststart 导致。Chromium 已在上游提交 `3f057555` 修复；158.0.8127.18、159.0.8148.1 已包含，158.0.8118.0 及本次测试的 156.0.8078.79 未包含。长录制请使用含修复的 Chrome；旧版本改用 WebM，或在其安全阈值内停止保存。复现证据、版本对照与恢复结果见 [`docs/todo/native-mp4-4gib-chrome.md`](docs/todo/native-mp4-4gib-chrome.md)。

> **PotPlayer 打开 MP4 很慢？** 不同 Chrome 版本的分片布局和 mfra 情况不同。扩展已补齐 fMP4 时长，但弱 fMP4 播放器仍可能因逐分片建索引而打开较慢，可用 ffmpeg 重封装改善（流复制，不重编码）：
> `ffmpeg -i 录制的.mp4 -c copy -movflags +faststart 修复后.mp4`

可见：新版 Chrome 下 MP4 开箱即用（原生录制 + 内置 JS faststart）；**ffmpeg 内核只用于**老版 Chrome 的整段转码、以及非常规 MP4 的 faststart 兜底。内核体积较大（约 30MB）且为 GPL-2.0-or-later 许可（内含 libx264），故未随扩展打包。两种放入方式任选其一：

**方式 A：npm 下载**

```bash
npm i @ffmpeg/core@0.12.10
```
把 `node_modules/@ffmpeg/core/dist/umd/` 下的（注意是 `umd` 子目录——扩展 worker 用 `importScripts` 加载，需要 UMD 构建）：
- `ffmpeg-core.js`
- `ffmpeg-core.wasm`

复制到 `lib/ffmpeg/`（保持原文件名），然后在弹窗「输出格式」选择 **MP4**，重新加载扩展即可。

**方式 B：直接下载（不装 npm）**

从 CDN 下载这两个文件放入 `lib/ffmpeg/`，与方式 A 完全等价：
- https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js
- https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm

> 详见 `lib/ffmpeg/README.txt`（jsdelivr 镜像、`curl` 一条龙、许可证与常见问题）。

> 只需要这 2 个文件。`ffmpeg-core.worker.js` 不存在于 0.12 单线程版（它是 `@ffmpeg/core-mt` 多线程版的文件）——ffmpeg 现在跑在扩展自带的 `transcoder-worker.js` 里（独立的 Web Worker），转码期间 UI 完全不卡。

> manifest.json 已经配好了 MV3 跑 wasm 必需的 `wasm-unsafe-eval` CSP，无需手动改。不需要 `web_accessible_resources`：worker 与 ffmpeg 内核都由扩展页面同源加载，WAR 只会把资源暴露给任意网页、让扩展可被指纹识别。

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
| `storage` | 保存设置、历史记录及保存状态 |
| `downloads` | 启动下载并监听真实完成/中断状态，完成前不报告已保存 |

**无 host_permissions，无 `tabs` 权限，完全离线。**

---

## 🧪 验证清单

- [ ] 标签页录制 + 最小化 Chrome 30s → 文件正常且可拖动进度
- [ ] WebM 与原生 MP4 均能在 Windows 媒体播放器前/中/后段拖动
- [ ] WebM 反复拖动到不同时间点 → 不先花屏再恢复，能从关键帧正常解码
- [ ] 窗口/兼容模式选择画面和音频时不提前计时，实际开始后才计时；控制只在 recorder 窗口
- [ ] 定时停止 10s → 到点自动保存
- [ ] 停止后立即关闭主弹窗，独立保存窗口仍显示进度；可手动重开
- [ ] 保存期间不出现提前“已保存”，下载完成后才写历史
- [ ] 模拟一次下载失败 → 重试成功；另一次明确丢弃 → 无历史且可重新录制
- [ ] 长录制时确认暂存持续增长、内存不随整段线性增长；强杀测试浏览器后恢复 WebM/MP4
- [x] Linux/CfT 158：真实 tabCapture WebM 4.5 小时、23.66 GB，正常停止与保存通过（2026-11-06）
- [x] Linux/Google Chrome 156（保留其他扩展）：YouTube TV NBC 11 真实直播 WebM 5 小时 10 分、16.81 GB，自动停止、下载与前/中/后段解码通过（2026-11-06）
- [ ] **已复现**：Chrome 156 原生 MP4 在 4,294,540,012 字节（仅比 2³² 少 427,284 字节）处 SIGTRAP，扩展录制上下文消失；OPFS 恢复保存成功，但不能继续超过 4 GiB（2026-11-07）
- [ ] Windows 与 RDP 长录制仍需对应环境验证（自动化短测不替代）
- [ ] 桌面 recorder 最小化后停止 → 保存状态与完成提示正常
- [ ] 切换分辨率 1280×720 → 输出分辨率正确
- [ ] 窗口模式选择某窗口录制成功
- [ ] 勾选 MP4 输出（放入 ffmpeg 内核后）得到 `.mp4`
- [ ] 兼容模式下能采集到系统音频

---

## 🛠 技术要点

- **MV3 + offscreen document**：规避 service worker 被回收导致的录制中断
- **`getMediaStreamId` 跨上下文传递**：worker 取 streamId，offscreen 消费
- **EBML 修复（`fix-webm.js`）**：手写 EBML 解析器补 `SeekHead`、重建 `Cues`、修补 `Duration`；滑窗扫描 + Blob.slice 拼装，内存与文件大小无关
- **fMP4 时长重建（`mp4-faststart.js`）**：只读取 `moov/moof`，从 `tfhd/tfdt/trun/trex` 计算真实轨道时长，不读取完整 `mdat`
- **下载结果确认**：`save-file.js` 创建 Blob URL，background 用 `chrome.downloads` 启动并对账；offscreen 不直接调用不受支持的 downloads API
- **可见保存状态**：标签页有独立保存窗口，桌面复用 recorder；保存失败保留最终 Blob 供重试，成功或明确丢弃前维持关窗保护
- **持续暂存与恢复**：最多 4 个或 32 MiB 待确认分片；Worker 同步追加并 flush，内存不随整段时长线性增长；异常 WebM 截去不完整尾部，MP4 按完整 box 裁剪且没有媒体分片时不伪造成功
- **Track `ended` 监听**：用户点 Chrome「停止共享」条时干净收尾

## 📝 参考致谢

基础架构与 `fix-webm.js` 参考自 ScreenCap Pro v1.4.1（开源录制扩展），并在此基础上聚焦「标签页录制」核心需求，新增分辨率/帧率/比特率显式控制与可选 MP4 转码。
