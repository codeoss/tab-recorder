# WebM 关键帧索引与 recorder 操作体验设计

**状态：已按用户明确指令确定实施顺序。**顺序为“关键帧索引 → 实际开始计时 → 统一 recorder 操作入口”。`moov-at-end fMP4` 仅登记后续待办，不在本设计中实现。

## 背景与证据

PR #19 已合并，真机验证 WebM/MP4 可播放和拖动，但 WebM 拖动后先花屏再恢复。对现有约 190MB 样本的独立二进制检查发现：453 个 Cue 中有 369 个指向没有关键帧标志的视频 SimpleBlock；FFmpeg 对照的 84 个 Cue 中有 82 个指向关键帧。当前 `fix-webm.js` 把全部 Cluster 加入 Cues，没有解析视频轨和帧类型。

窗口/屏幕/兼容模式还有两组体验问题：background 在打开 recorder 窗口时就写入 `startTime`，popup 立即计时；真正选择屏幕/音频并启动 MediaRecorder 后又重置时间。主 popup 与 recorder 都提供停止、暂停等控制，虽然最终调用同一个引擎方法，但用户会面对两个操作中心。

## 目标

1. WebM Cues 只指向真实视频关键帧，拖动后不再从缺少参考帧的视频包直接解码。
2. 选择屏幕和音频期间显示准备状态，不提前累计录制时长或定时停止时间。
3. recorder 窗口成为窗口/屏幕/兼容模式唯一录制控制入口；主 popup 保留状态显示和聚焦入口。
4. 将 `moov-at-end fMP4` 的背景、影响和未来验收要求留在代码库，不在本轮实现。

## 非目标与约束

- 不重编码、不强制关键帧间隔、不新增 ffmpeg.wasm 使用、npm 依赖、网络请求或权限。
- `fixWebMBlob(blob, durationMs)`、`_fixWebMFullBuffer()`、`_fixWebMStream()` 的公开签名不变；legacy 与 streaming 继续逐字节一致。
- 媒体 Cluster 负载逐字节不变；生产 WebM 修复保持 `O(256KB 扫描窗口 + Cues)` 内存，不按 Cluster 大小物化媒体负载。
- 普通标签页录制的倒计时、控制、保存行为不变；真实下载 `complete` 后才写成功历史的规则不变。
- 不实现 `moov-at-end fMP4`，不要求用户安装 wasm，不把强制退出描述为可恢复。

## 方案比较与选择

### 关键帧索引

选择解析现有 EBML/Block，仅给真实视频关键帧建立 Cue。重编码或提高关键帧密度会增加 CPU、耗时和码率，且不能修复已有文件的错误索引，因此不采用。

视频轨从 Tracks 的 TrackEntry 中识别（TrackType=视频），不硬编码 TrackNumber=1。SimpleBlock 使用 keyframe 标志；BlockGroup 中的 Block 在没有 ReferenceBlock 时可作为关键帧。跳过音频负载，只读块头及必要字段；不支持或无法确认的块布局不猜成关键帧。

CueClusterPosition 继续指向 Cluster，CueTrack 使用真实视频轨号。CueTime 使用 `Cluster.Timecode + Block 相对时间码`（同一时间单位），不再一律用 Cluster 起点。每个 Cluster 最多一个视频关键帧 Cue；时间码须非负并保持单调。一个有效 Cue 都没有时返回原文件，不制造空索引或改写媒体。

### 实际开始计时

选择显式 `preparing` 状态，而不是用 `startTime=0` 隐式猜测。desktop/compat 创建 recorder 窗口后进入 `preparing`，收到现有 `RECORDER_STARTED` 才进入 `recording` 并写入实际开始时间。引擎的 `startTs`、定时停止和暂停计时逻辑不变。

`preparing` 不启动 popup 计时器。此阶段收到 STOP 时关闭等待中的 recorder 窗口并归位，不进入保存链。原生选屏取消、窗口关闭和 SW 恢复仍按现有生命周期处理。

### 统一控制入口

选择 recorder 窗口作为唯一控制入口。它本来就承担选屏、录制和保存，关闭主 popup 后仍可使用。主 popup 的录制按钮改为聚焦现有 recorder 窗口，暂停/停止/丢弃录制不再从主 popup 提供第二套入口；保存失败后的明确丢弃仍按现有保存协议处理。

另一种方案是隐藏 recorder 控制、只使用主 popup，但 popup 很容易关闭，停止和保存不直观，因此不采用。普通标签页录制没有 recorder 窗口，仍由主 popup 控制。

新增 `OPEN_RECORDER_WINDOW`，只聚焦 background 已记录的 `recorderWindowId`，不新建窗口或引擎。popup 同时正确处理 recorder 本地暂停/恢复产生的 `paused`/`recording` 状态，避免主界面时间继续走或显示错误。

## 验收

- 含音频优先、视频轨号非 1、P 帧、SimpleBlock 关键帧、BlockGroup 关键帧的夹具中，CueTrack/CueTime/CueClusterPosition 全部精确；非关键帧不进入 Cues。
- 所有既有 WebM golden、幻影防护、组合位移、读取范围断言继续通过；真实样本修复后每个 Cue 的视频帧均为关键帧，Cluster 负载不变。
- desktop/compat 等待选择时 `status=preparing`、`startTime=0`、popup 不启动计时；`RECORDER_STARTED` 后才开始计时。
- 准备阶段 STOP 不产生保存任务或历史；重复聚焦不创建第二个 recorder 窗口或引擎。
- 主 popup 不再停止 desktop/compat 录制，recorder 本地暂停/恢复能正确同步到主界面；普通 tab 场景 A–E 不回归。
- 真实 RDP 的兼容模式音频、真实 Windows 播放器拖动和真实长文件性能需单独验证，不能用单元测试冒充已覆盖。
