# 可选按时间分段录制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加默认关闭的分段开关和可配置分钟数，在同一媒体流上重叠切换独立录制器，并可靠地串行保存与恢复全部分段。

**Architecture:** 新 `segment-recorder.js` 控制器持有共享流，每段仍由 `createRecorderEngine` 完成 OPFS、修复和下载。background 将单条恢复元数据迁移为按 recordingId 管理的集合，实际下载保持串行；旧单文件路径默认不变。

**Tech Stack:** Manifest V3、原生 JavaScript IIFE、MediaRecorder、OPFS Worker、chrome.storage/downloads、Node `node:test`/现有断言风格、Playwright。

**Spec:** `docs/superpowers/specs/2026-11-07-time-segmented-recording-design.md`

## Global Constraints

- 开关默认关闭，`segmentMinutes` 默认 30；只有打开开关才显示分钟输入，不使用 0 表示关闭。
- 分钟输入只接受 1–1440 的整数，非法值在开始时明确报错。
- 先启动下一段再停止上一段；段内停止不得结束共享媒体流或关闭宿主音频回环。
- 下载 complete 后才写该段历史；旧段保存期间总会话保持 recording/paused。
- 已下载文件不因丢弃而删除；失败、转码积压和下一段启动失败不得形成无限队列。
- 兼容既有单个 `chrome.storage.local.durableRecording`，不得丢旧恢复数据。
- 不新增权限、依赖、网络请求或 `web_accessible_resources`，不改变 CSP。
- 未经用户明确要求，不执行 commit、push、PR 或发布。

## Review Focus

- **下一段 writer/recorder 创建失败：** 旧段不能先停止，但最终必须停止会话并保存旧段；Task 3 故障注入覆盖。
- **旧段仍在下载时下一段开始暂存：** 两个 recordingId 都必须保留，旧段清理不得删除新段；Task 5 覆盖。
- **暂停或总停止与分段边界同时发生：** 不多建空段、不重置总计时、不产生孤儿 recorder；Task 3 覆盖。
- **老 Chrome 转码慢于分段：** 最多一个待处理旧段和一个活动段，超过即停止并提示；Task 3 覆盖。
- **崩溃时部分段已下载：** 重启先对账 downloadId，按段号只恢复未完成项且不重复历史；Task 5 覆盖。

---

### Task 1: 分段设置与 popup 交互

**Files:**
- Modify: `popup.html`
- Modify: `popup.js`
- Modify: `background.js`（仅安装默认值）
- Test: `e2e/unit-popup-recorder.mjs`

**Interfaces:**
- `recorderSettings` 新增 `{segmentEnabled: boolean, segmentMinutes: string}`，默认分别为 `false` 和 `'30'`。
- `START_RECORDING` 新增 `segmentEnabled: boolean, segmentMinutes: number`；OFF_START/recorder hash 原样传递。

- [ ] **Step 1: 写失败测试**

在现有 popup VM 中验证：初始无设置时开关关闭且分钟行隐藏；触发开关 change 后分钟行显示；非法 `'0'`、`'1.5'`、空值启动被拒绝且不发送 START；合法 `'30'` 发送 `segmentEnabled:true, segmentMinutes:30`；恢复既有设置不改变其他字段。

- [ ] **Step 2: 运行并确认失败**

Run: `node e2e/unit-popup-recorder.mjs`
Expected: FAIL，缺少分段元素/设置字段。

- [ ] **Step 3: 实现最小 UI 与配置链**

在定时停止区域前新增 `segmentEnabled` 开关和 `segmentMinutes` number 行；在 `events/save/restore/start` 接入上述接口，非法值用现有状态栏报错。background 安装默认值补这两个字段，window/compat 的 URLSearchParams 同步携带。

- [ ] **Step 4: 验证**

Run: `node e2e/unit-popup-recorder.mjs && node e2e/unit-save-state.mjs`
Expected: PASS。

### Task 2: 核心引擎的资源所有权与 MediaRecorder 错误

**Files:**
- Modify: `core-recorder.js`
- Test: `e2e/unit-save-engine.mjs`

**Interfaces:**
- `createRecorderEngine` 新增可选 `manageResources`（默认 `true`）。
- `manageResources:false` 时，`releaseAll()` 不停止 activeStream、不调用 releaseExtra；资源由 Task 3 控制器最终释放。
- 其余现有接口不变。

- [ ] **Step 1: 写失败测试**

覆盖：默认停止仍停止轨道；`manageResources:false` 停止后共享轨道和 releaseExtra 均未释放；`recorder.onerror({error:{message:'MEDIA_FATAL'}})` 发可见 saveerror 并停止当前 recorder，不能留下活动状态。

- [ ] **Step 2: 运行并确认失败**

Run: `node e2e/unit-save-engine.mjs`
Expected: FAIL，新资源选项和 onerror 尚未实现。

- [ ] **Step 3: 实现**

仅在 `releaseAll` 统一判断 `manageResources`；不增加第二种资源清理路径。安装 `recorder.onerror`，提取脱敏前由既有 UI 使用的错误 message，发 saveerror，并在非 inactive 时调用 stop。

- [ ] **Step 4: 验证**

Run: `node e2e/unit-save-engine.mjs && node e2e/unit-durable-writer.mjs`
Expected: PASS。

### Task 3: 同流重叠分段控制器

**Files:**
- Create: `segment-recorder.js`
- Test: `e2e/unit-segment-recorder.mjs`

**Interfaces:**
- 暴露 `createSegmentedRecorderEngine({getStream,onEvent,releaseExtra,saveFile})`，返回与核心相同的 `start/stop/pause/resume/discard/retrySave/isRecording/isBusy/isPaused`。
- `start(opts)` 消费 `segmentMinutes`、既有输出参数；内部每段调用 `createRecorderEngine({manageResources:false})`。
- 新增 onEvent：`segment`，数据为 `{phase:'started'|'saved', recordingId, segmentIndex}`；`processing` 增加 `scope:'segment'`。
- 段级 stopped 不直接作为总会话 stopped；只有全部保存完成才发 stopped/saved。

- [ ] **Step 1: 写重叠顺序和文件命名失败测试**

用可控 MediaRecorder、真实 Blob、fake writer 和可控 saveFile 验证：下一段 start 先于旧段 stop；段号从 1 递增；文件名 `_part001`；旧段停止不停止共享流；saveFile 最大并发为 1。

- [ ] **Step 2: 写控制与故障失败测试**

覆盖暂停排除分段时间、总限时不多开段、手动停止等待队列、下一段创建失败会停止旧段、下载失败不重开新段、旧段转码到下一边界仍未完成会停止并提示、空段不写历史、丢弃只清未保存项。

- [ ] **Step 3: 运行并确认失败**

Run: `node e2e/unit-segment-recorder.mjs`
Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现控制器**

仅取流一次；每段独立 writer/recorder；保存 Promise 按 segmentIndex 串行；控制器维护总开始/暂停/限时、当前段和停止/错误状态。切换先启动下一段，再停止旧段；所有资源最终由控制器统一释放。不要引入框架或新依赖。

- [ ] **Step 5: 验证与重构**

Run: `node e2e/unit-segment-recorder.mjs && node e2e/unit-save-engine.mjs`
Expected: PASS；随后消除重复事件转发但不改变测试行为。

### Task 4: 宿主接入与段级保存状态

**Files:**
- Modify: `offscreen.html`
- Modify: `recorder.html`
- Modify: `offscreen.js`
- Modify: `recorder.js`
- Modify: `popup.js`
- Modify: `save-status.js`
- Modify: `background.js`
- Modify: `save-file.js`
- Test: `e2e/unit-recorder-save.mjs`
- Test: `e2e/unit-popup-save.mjs`
- Test: `e2e/unit-save-state.mjs`

**Interfaces:**
- 宿主在 `segmentEnabled:true` 时使用 Task 3 控制器，否则保持原引擎。
- `saveFileViaBackground(blob, filename, extra={})` 把 extra 加入 SAVE_FILE；至少支持 `{recordingId, segmentIndex}`。
- background 处理 `SEGMENT_STARTED` 和 `SEGMENT_SAVED`；段级保存不把 status 改成 idle，complete 后由 SEGMENT_SAVED 写历史并去重。
- state 增加 `segmented:false, segmentIndex:0, savedSegments:0, savingSegments:0`。

- [ ] **Step 1: 写失败测试**

验证两种宿主开关路由；段级 processing 保持 recording；下载进度显示「正在保存第 N 段，录制继续」；每段 SAVE_FILE 带正确 recordingId；上一段 complete 后下一段可创建新下载且旧事件不能覆盖新 downloadId；SEGMENT_SAVED 只在 complete 后写历史。

- [ ] **Step 2: 运行并确认失败**

Run: `node e2e/unit-recorder-save.mjs && node e2e/unit-popup-save.mjs && node e2e/unit-save-state.mjs`
Expected: FAIL，段级路由/字段尚未实现。

- [ ] **Step 3: 实现宿主和 background 接入**

HTML 在 core-recorder 后加载 segment-recorder；控制器过滤段级 started/stopped，宿主只转发会话级事件。background 以 recordingId 找到对应恢复项并保存 downloadIntent/downloadId；新段下载递增 saveGeneration，旧轮询结果不得污染新段。保存状态沿用现有可见窗口，不重开或抢占焦点。

- [ ] **Step 4: 验证**

Run: 上述三个测试及 `node e2e/unit-segment-recorder.mjs`
Expected: PASS。

### Task 5: 多分段持久化与顺序恢复

**Files:**
- Create: `durable-store.js`
- Modify: `background.js`
- Modify: `popup.js`
- Modify: `save-status.js`
- Test: `e2e/unit-durable-store.mjs`
- Test: `e2e/unit-save-state.mjs`
- Test: `e2e/run-recovery.mjs`

**Interfaces:**
- `createDurableStore(chrome.storage.local)` 返回 `{list(), upsert(patch), remove(id), clear()}`；所有写操作串行。
- 新 key `durableRecordings` 保存数组；首次读取合并旧 `durableRecording`，下一次写入迁移并删除旧 key。
- 恢复 API 消息名保持 `RECOVER_RECORDING/DISCARD_RECOVERY/OFF_RECOVER_RECORDING/OFF_DISCARD_RECOVERY/RECOVERY_COMPLETE`。

- [ ] **Step 1: 写存储失败测试**

覆盖旧单对象迁移、不同 id upsert 共存、同 id 更新不重复、remove 只删目标、并发写不覆盖、clear 清理新旧 key。

- [ ] **Step 2: 写恢复失败测试**

覆盖三个分段部分已下载、按 segmentIndex 顺序恢复、每项 complete 后才删除、重复恢复互斥、历史去重、全部完成才清 recoveryAvailable、明确丢弃只删未下载项。

- [ ] **Step 3: 运行并确认失败**

Run: `node e2e/unit-durable-store.mjs && node e2e/unit-save-state.mjs`
Expected: FAIL，多单段存储/恢复尚不存在。

- [ ] **Step 4: 实现**

background 顶层 import durable-store；所有 durable 读取/更新/删除改经同一串行 store。恢复先对账现有下载，再按 sessionId/segmentIndex/startedAt 逐项处理；UI 显示未完成段数和合计确认字节。不要修改现有 OPFS Worker 文件格式。

- [ ] **Step 5: 验证**

Run: `node e2e/unit-durable-store.mjs && node e2e/unit-save-state.mjs && node e2e/unit-recovery.mjs`
Expected: PASS。

### Task 6: 真实媒体、完整回归与文档

**Files:**
- Modify: `e2e/run.mjs`
- Modify: `e2e/run.sh`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/todo/native-mp4-4gib-chrome.md`（只更新分段实测状态）

**Interfaces:**
- E2E 测试副本可缩短分段间隔，生产 UI 仍只接受分钟整数；测试注入不得覆盖生产 recorder.onerror。

- [ ] **Step 1: 新增真实浏览器失败场景**

测试构建把分段间隔缩短到秒级，分别让 WebM 和原生 MP4 至少产生 3 段。断言所有文件含音视频、可完整解码、时长合理、文件名段号连续；WebM 验证关键帧 Cues，MP4 验证 moov/faststart。覆盖分段中 popup 关闭、暂停/恢复、最终停止和强杀后两段以上恢复。

- [ ] **Step 2: 运行并确认测试能失败**

Run: `E2E_MANUAL_SHORTCUT=1 node e2e/run.mjs`
Expected: 新场景在缺少真实分段行为时 FAIL；不得只靠静态源码断言。

- [ ] **Step 3: 修正实现并更新文档**

补 README 开关、分钟数、命名、保存/丢弃语义与 4GiB 注意事项；AGENTS 更新模块、消息协议和测试入口。根因文档只记录实际做过的分段验证，不把短测写成 4GiB 通过。

- [ ] **Step 4: 完整验证**

Run: `cd e2e && NATIVE_CHROME_BIN='C:/Program Files/Google/Chrome/Application/chrome.exe' E2E_MANUAL_SHORTCUT=1 npm test`
Expected: exit 0；既有真实 reload 在 CfT 上的既有 SKIP 单独注明。

- [ ] **Step 5: 真实 Chrome 验证**

加载独立测试构建，确认默认关闭、打开后显示 30 分钟、非法值提示、段级保存可见。用真实页面完成至少一次多分段 WebM 与 MP4；没有真实长录制/4GiB 证据时明确保留该限制，不声称已覆盖。

## Self-Review

- Spec coverage：设置、重叠切换、保存队列、多分段恢复、控制语义和验证分别由 Task 1–6 覆盖。
- Type consistency：会话/段级事件、recordingId、segmentIndex、manageResources 和 durable store 接口在任务间保持一致。
- Proportion：计划不给出控制器或恢复算法全文，由失败测试和接口约束实现。
- Delivery safety：每个任务都先红后绿；默认关闭的旧路径必须持续通过原测试，不提交或发布未验证代码。
