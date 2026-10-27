# WebM 关键帧索引与 recorder 操作体验 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 WebM 拖动落在真实视频关键帧上，窗口/兼容模式从实际采集开始计时，并统一由 recorder 窗口控制录制；同时登记 moov-at-end fMP4 后续待办。

**Architecture:** 保留现有双引擎、经典脚本和保存协议。WebM 在 legacy/streaming 两条等价扫描路径中识别视频轨与块级关键帧；desktop/compat 用显式 preparing 状态等待 `RECORDER_STARTED`，主 popup 改为只读状态和 recorder 窗口入口。

**Tech Stack:** Manifest V3、原生 JavaScript IIFE、Chrome windows/downloads/storage API、Node.js 单元测试、Playwright 真实扩展 E2E。

**Spec:** `docs/superpowers/specs/2026-10-27-keyframe-recorder-ux-design.md`（用户已按该方案的优先级明确要求实施）。

## Global Constraints

- 不新增 ffmpeg.wasm 使用、转码、npm 依赖、网络请求、权限或构建步骤；不实现 `moov-at-end fMP4`。
- `fixWebMBlob(blob, durationMs)`、`_fixWebMFullBuffer()`、`_fixWebMStream()` 签名不变，legacy 与 streaming 逐字节一致，媒体负载不变。
- WebM 内存保持 `O(256KB 扫描窗口 + Cues)`；不得按 Cluster 大小或整文件物化媒体负载。
- 普通 tab 的倒计时、控制与保存行为不变；下载 complete 才写成功历史。
- desktop/compat 唯一录制控制入口为 recorder；主 popup 仅显示状态和聚焦窗口，保存失败处理保持原协议。
- `preparing` 不计入录制时间或定时停止；实际 `RECORDER_STARTED` 后才计时。
- 无法确认的视频帧类型不猜为关键帧；没有有效 Cue 时保留原文件。
- 修改什么文档就由对应实现同步更新；`fix-webm.js` 注释保持英文，其余新增说明以中文为主。

## Review Focus

- 音频先于视频、视频 TrackNumber 非 1、P 帧和 BlockGroup：CueTrack/CueTime 必须对应真实视频关键帧，由 Task 1 的独立校验器钉死。
- unknown-size Cluster 与大音频负载：不得把媒体负载当成头部扫描或整段物化，由 Task 1 的结构与读取范围测试钉死。
- 等待选屏时关闭窗口、取消选择或 STOP：不得提前计时或产生保存历史，由 Task 2 的生命周期测试钉死。
- recorder 本地暂停后重开主 popup：不得继续计时或提供第二套控制，由 Task 3 的真实脚本测试钉死。
- 没有任何可验证视频关键帧：不得制造空 Cues 或破坏原文件，由 Task 1 的原样返回测试钉死。

---

### Task 1: WebM Cues 只指向真实视频关键帧

**Files:**
- Modify: `fix-webm.js`
- Modify: `e2e/lib-webmcheck.mjs`
- Test: `e2e/unit-webmstream.mjs`
- Modify: `e2e/run.mjs`（真实产物沿用同一关键帧校验）

**Interfaces:**
- Consumes: 现有公开修复函数签名及 `clusters` 的相对偏移/绝对偏移模型。
- Produces: `buildCues(points, videoTrack)` 使用真实视频轨号；每个 point 含关键帧的 `timecodeMs` 和相对 Cluster 偏移。公开修复函数签名不变。

- [ ] **Step 1: 写独立的关键帧/Cue 失败测试**

在测试 EBML 构造器中使用合法 Tracks（TrackEntry 的 TrackNumber/TrackType），并让 Cluster 包含实际 Block 头。独立校验器不得调用生产解析逻辑，须验证 CueTrack、CueTime、CueClusterPosition 和目标视频关键帧。

加入夹具：视频轨号 2；音频 SimpleBlock 在视频前；P 帧；SimpleBlock 关键帧（关键帧相对时间码为 20）；无 ReferenceBlock 的 BlockGroup 关键帧（相对时间码为 30）。预期 CueTime 只含该 SimpleBlock 的 `2000+20=2020` 和 BlockGroup 的 `3000+30=3030`，CueTrack=2。另一个没有任何可验证关键帧的输入必须原样返回。

增加 unknown-size Cluster 与大音频负载用例；记录 Blob.slice 的实际物化范围，不允许整 Cluster 或整文件读取。保留所有既有 golden、SeekHead、组合位移和负载不变断言。

- [ ] **Step 2: 运行测试确认旧实现失败**

Run: `node e2e/unit-webmstream.mjs`

Expected: 新用例因旧实现索引 P 帧、CueTrack=1 或缺少合法轨道/块解析而 FAIL；既有媒体负载断言不应被改写为通过。

- [ ] **Step 3: 在 legacy 与 streaming 同步实现视频轨/关键帧识别**

从 Tracks 读取视频 TrackNumber。解析 Cluster 子块时跳过音频负载，只读必要头部：SimpleBlock 检查 keyframe 位；BlockGroup 读取 Block 及 ReferenceBlock；无法解析的布局不猜测。支持带符号的 Block 相对时间码，CueTime 为 Cluster.Timecode 加该相对值；只保留非负、单调的有效点。

将真实视频轨号传给 `buildCues`，沿用现有 SeekHead/Cue 位移计算。无有效 Cue 时返回原始 Blob/Buffer。两条路径不得新增整 Cluster 或整文件物化。

- [ ] **Step 4: 运行 WebM 全部单元测试**

Run: `node e2e/unit-webmstream.mjs`

Expected: 新旧 golden、CueTrack/CueTime/关键帧、unknown-size、组合位移、读取范围和负载等价断言全部 PASS。

- [ ] **Step 5: 用真实旧样本复核并提交**

Run: 对 Downloads 中既有扩展修复样本执行 `fixWebMBlob`，用独立校验器和 ffprobe 验证全部 Cue 的视频关键帧，且媒体 Cluster 不变；记录处理耗时。

Expected: 旧样本中曾存在的非关键帧 Cue 不再出现；无整文件二次扫描。随后：

```bash
git add fix-webm.js e2e/lib-webmcheck.mjs e2e/unit-webmstream.mjs e2e/run.mjs
git commit -m "fix(webm): index seek points at video keyframes"
```

### Task 2: desktop/compat 从实际开始后才计时

**Files:**
- Modify: `background.js`
- Modify: `popup.js`
- Test: `e2e/unit-save-state.mjs`
- Create: `e2e/unit-popup-recorder.mjs`
- Modify: `e2e/run.sh`

**Interfaces:**
- Consumes: 现有 `RECORDER_STARTED`、窗口关闭和 STOP 生命周期。
- Produces: `state.status` 新增 `preparing`；准备阶段 `startTime=0`。`RECORDER_STARTED` 转为 recording 并写实际时间戳。

- [ ] **Step 1: 写准备态与 popup 计时失败测试**

background 测试断言：desktop 和 compat 创建窗口后为 preparing/startTime=0，START 重入仍被拒绝；RECORDER_STARTED 后才 recording/startTime>0。准备阶段 STOP 关闭已有 recorder 窗口、归 idle、processing=false 且不写历史。

新 popup 脚本测试驱动真实 `start()`/`pollState()`：desktop/compat 开始请求和重新打开 popup 时不启动录制计时、显示准备状态；收到 recording 后才从 background 的实际 startTime 计时。普通 tab 倒计时保持原行为。

- [ ] **Step 2: 运行测试确认旧实现失败**

Run: `node e2e/unit-save-state.mjs && node e2e/unit-popup-recorder.mjs`

Expected: 因旧实现窗口创建即 recording/startTime=Date.now，popup 立即启动计时而 FAIL。

- [ ] **Step 3: 实现准备态和取消生命周期**

`openRecorderWindow()` 写 preparing/startTime=0；RECORDER_STARTED 才写实际时间。准备阶段 STOP 关闭现有 recorder 窗口并归位，不进入保存链；窗口消失和原生选择取消不写历史。popup 在 preparing 阶段停止本地计时并显示选择提示，recording 后才启动计时和定时停止显示。

- [ ] **Step 4: 运行状态与 UI 回归**

Run: `node e2e/unit-save-state.mjs && node e2e/unit-popup-recorder.mjs && node e2e/unit-popup-save.mjs && node e2e/unit-recorder-save.mjs`

Expected: 全部 PASS；既有保存状态机、普通 tab 和 recorder 保存测试不回归。

- [ ] **Step 5: Commit**

```bash
git add background.js popup.js e2e/unit-save-state.mjs e2e/unit-popup-recorder.mjs e2e/run.sh
git commit -m "fix(recorder): start timing after capture starts"
```

### Task 3: 统一 recorder 窗口操作入口

**Files:**
- Modify: `background.js`
- Modify: `popup.js`
- Test: `e2e/unit-save-state.mjs`
- Test: `e2e/unit-popup-recorder.mjs`
- Modify: `README.md`（用户操作说明）

**Interfaces:**
- Consumes: Task 2 的 preparing/recording/paused 状态和 `recorderWindowId`。
- Produces: `OPEN_RECORDER_WINDOW` → `{ok:1,windowId}` 或 `{error}`；只聚焦已存在窗口，不创建引擎。

- [ ] **Step 1: 写唯一控制入口失败测试**

background 测试验证 OPEN_RECORDER_WINDOW 聚焦原 ID、不新增窗口，tab/失效窗口返回错误。popup 测试覆盖 preparing/recording/paused：主按钮只发 OPEN_RECORDER_WINDOW，不发 STOP/PAUSE/DISCARD；录制控制区隐藏，recorder 本地暂停时主 popup 停止计时并显示暂停，恢复后从 background 时间继续。普通 tab 仍发送原控制命令。

- [ ] **Step 2: 运行测试确认旧实现失败**

Run: `node e2e/unit-save-state.mjs && node e2e/unit-popup-recorder.mjs`

Expected: 旧实现缺少聚焦消息，主 popup 仍停止/暂停 desktop，且不处理后台 paused，因而 FAIL。

- [ ] **Step 3: 实现聚焦协议与只读 popup 状态**

新增 OPEN_RECORDER_WINDOW 路由。popup 根据 background 的 mode=desktop 和实际状态调整主按钮为“打开录制窗口”，隐藏第二套录制控制；保留普通 tab 的原控制和保存失败操作。补齐 paused→recording 同步，README 说明窗口/兼容模式在 recorder 中操作。

- [ ] **Step 4: 运行 UI/状态回归和真实 tab E2E**

Run: `node e2e/unit-save-state.mjs && node e2e/unit-popup-recorder.mjs && node e2e/unit-popup-save.mjs && node e2e/unit-recorder-save.mjs`

Expected: 全部 PASS；普通 tab 场景继续由后续完整套件验证。

- [ ] **Step 5: Commit**

```bash
git add background.js popup.js e2e/unit-save-state.mjs e2e/unit-popup-recorder.mjs README.md
git commit -m "fix(recorder): centralize capture controls"
```

### Task 4: 待办文档、真实样本与整体验证

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `mp4-faststart.js`（仅增加指向待办文档的注释，不改变布局行为）
- Reference: `docs/todo/moov-at-end-fmp4.md`（已在计划阶段登记，保持未实施）

- [ ] **Step 1: 同步架构和待办说明**

记录关键帧 Cues、preparing、OPEN_RECORDER_WINDOW 和 recorder 单一入口；链接 `docs/todo/moov-at-end-fmp4.md`，明确普通 moov-at-end 已支持、分片 moov-at-end 未实现、没有 wasm 保留原文件的影响。代码注释只指向待办，不添加未经测试的 MP4 行为。

- [ ] **Step 2: 静态检查和完整标准测试**

Run:

```bash
for f in background.js fix-webm.js mp4-faststart.js popup.js recorder.js; do node --check "$f" || exit 1; done
cd e2e && NATIVE_CHROME_BIN='C:/Program Files/Google/Chrome/Application/chrome.exe' E2E_MANUAL_SHORTCUT=1 npm test
```

Expected: 全部语法 exit 0；单元测试和真实扩展场景 A–E PASS。

- [ ] **Step 3: 真机/播放器边界与最终复核**

对真实 WebM 样本验证全部 Cue 关键帧及媒体不变；记录处理耗时。尝试真实 Windows 播放器拖动和兼容模式实际选屏/音频，不能执行的项明确写出，不用模拟测试代替。核对无内核、录制产物或临时工具进入提交。

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md README.md mp4-faststart.js docs/todo/moov-at-end-fmp4.md
git commit -m "docs: document recorder controls and fMP4 follow-up"
```
