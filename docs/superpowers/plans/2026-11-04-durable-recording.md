# Durable Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让长录制持续写入可恢复的浏览器磁盘暂存，正常停止仍输出单个 WebM/MP4，异常重启后可明确恢复保存。

**Architecture:** `core-recorder.js` 通过有界队列把分片交给 Dedicated Worker，Worker 用 OPFS sync access handle 追加并 flush；background 在 `chrome.storage.local` 保存恢复元数据。正常保存复用现有修复与下载链，异常恢复使用独立入口，并在 WebM 修复前裁剪结构不完整的尾部。

**Tech Stack:** 原生 JavaScript、MV3 offscreen、Dedicated Worker、OPFS、现有 Playwright/Node 测试。

**Spec:** `docs/superpowers/specs/2026-11-04-durable-recording-design.md`

## Global Constraints

- 不自动分段、不重编码，不新增 ffmpeg.wasm、npm 依赖、网络请求或扩展权限。
- 普通 WebM 修复的公开签名和现有输出不变；媒体完整负载不修改，异常恢复只能截去不完整尾部或做经过验证的等宽 EBML 收尾。
- 真实下载 `complete` 前不写成功历史、不删除暂存；失败不得静默退回无保护长录制。
- 所有新异步消息监听 `return true`；Worker 不访问 `chrome.*`；新模块沿用 IIFE 全局风格。
- 不用秒级测试冒充 Linux 数小时验证，不自动提交、推送或发布。

## Review Focus

- 最后一秒分片尚未确认时强杀：恢复只能到最后完整确认点，不伪造缺失媒体；由 Task 1、5 的截断和强杀测试覆盖。
- OPFS 满、Worker 死亡或写入持续落后：停止无保护录制并保留已确认前缀；由 Task 2、3 的故障测试覆盖。
- 下载已开始后浏览器重启：先对账 downloadId，不能重复下载/写历史；由 Task 4、5 覆盖。
- 恢复操作重复点击或两个 UI 同时发起：同一录制只能有一个恢复任务；由 Task 4 的幂等测试覆盖。
- 原生 MP4 与 WebM 尾部结构不同：分别验证，不复用 EBML 截断；由 Task 5 的真实媒体矩阵覆盖。

---

### Task 1: WebM 异常尾部恢复

**Files:**
- Modify: `fix-webm.js`
- Test: `e2e/unit-webmstream.mjs`

**Interfaces:**
- Produces: `fixWebMRecoveryBlob(blob, durationMs, confirmedBytes) → Promise<Blob>`，仅供异常恢复；`fixWebMBlob(blob, durationMs)` 不变。
- Produces: 内部扫描结果包含末尾 Cluster 的完整边界和必要的等宽 size 编辑，不把合法未知长度一律视为损坏。

- [x] **Step 1: 写失败用例。**构造完整 unknown-size Cluster、截断 SimpleBlock、截断 BlockGroup、截断 Cluster 头和末尾完整但未关闭 Cluster；断言恢复保留最后完整媒体、Cue 偏移正确、legacy golden 与 streaming 结果一致，正常 `fixWebMBlob` 输出不变。
- [x] **Step 2: 验证失败。**运行 `node e2e/unit-webmstream.mjs`，预期因缺少 `fixWebMRecoveryBlob` 或尾部断言失败。
- [x] **Step 3: 实现恢复扫描和稀疏编辑。**前向验证 EBML 子元素，`confirmedBytes` 是硬上限；只截断越界/不完整尾部。对完整但未关闭的末尾 Cluster 使用原 size 字段等宽 definite 编码；随后复用现有 Duration/SeekHead/Cues 链，不复制整段媒体。
- [x] **Step 4: 验证通过。**运行 `node e2e/unit-webmstream.mjs`，所有新旧用例通过，完整媒体 Cluster 的逐字节对照不变。

### Task 2: OPFS Worker 与有界暂存适配器

**Files:**
- Create: `durable-writer-worker.js`
- Create: `durable-recorder.js`
- Create: `e2e/unit-durable-writer.mjs`
- Modify: `e2e/run.sh`

**Interfaces:**
- Produces: `createDurableWriter({ id, mime, onMetadata }) → Promise<writer>`。
- `writer.append(blob, mediaTimeMs) → Promise<void>`；`writer.finalize() → Promise<File>`；`writer.discard() → Promise<void>`；`writer.bytes` 为最后确认字节数。
- `onMetadata(patch)` 上送 `id/mime/bytes/mediaTimeMs/phase`；Worker 协议为 `open/append/finalize/discard`，所有 append 带递增序号和偏移确认。
- OPFS 文件名 `tab-record-${id}.media`；最大 4 个未确认分片或 32 MiB，达到上限时 reject，不扩张内存队列。

- [x] **Step 1: 写失败测试。**以 fake OPFS/sync handle 验证顺序写入、每片 flush、短写、4 分片/32 MiB 背压、finalize 幂等、discard 清理和 Worker 错误向上传播。
- [x] **Step 2: 验证失败。**运行 `node e2e/unit-durable-writer.mjs`，预期模块不存在。
- [x] **Step 3: 实现 Worker 与适配器。**append 串行化，ArrayBuffer transferable 转移；完整写入并 flush 后才更新 bytes/元数据。finalize 等队列清空后关闭句柄并返回 File；discard 停止接收新写入并删除对应文件。
- [x] **Step 4: 验证通过。**运行 `node e2e/unit-durable-writer.mjs` 和现有单元测试；将新测试加入 `e2e/run.sh`。

### Task 3: 录制引擎接入持续暂存

**Files:**
- Modify: `core-recorder.js`
- Modify: `offscreen.html`
- Modify: `recorder.html`
- Modify: `offscreen.js`
- Modify: `recorder.js`
- Modify: `background.js`
- Modify: `popup.js`
- Test: `e2e/unit-save-engine.mjs`

**Interfaces:**
- Consumes: Task 2 的 writer API。
- Produces: `onEvent('durable', metadataPatch)`，两个宿主统一转成 `DURABLE_UPDATE`；background 用本地 key `durableRecording` 保存。
- Produces: `onEvent('saveerror', { message, canRetry })` 保持现有语义；新增暂存阶段只用已有 processing/save 状态，不引入第二套录制状态机。

- [x] **Step 1: 写引擎失败测试。**模拟 MediaRecorder 分片，断言 chunks 不保留整段、append 顺序正确、stop 等最后分片确认、discard 删除暂存、写入失败触发可见错误且不开始新录制。
- [x] **Step 2: 验证失败。**运行 `node e2e/unit-save-engine.mjs`，预期当前内存 chunks 路径不满足断言。
- [x] **Step 3: 接入 writer。**start 在创建 MediaRecorder 前建立 OPFS；失败释放媒体流并返回错误。dataavailable 不再累积整段 Blob；onStopped await finalize 后把 File 交给现有修复/下载。暂停计时、MP4 格式选择、保存重试与下载确认保持原行为。
- [x] **Step 4: 上送元数据与状态。**background 防止已有 `durableRecording` 被新录制覆盖；录制 UI 显示“已暂存 MB”，并明确这不是已下载。两个 HTML 在 `core-recorder.js` 前加载新模块。
- [x] **Step 5: 验证通过。**运行单元测试和浏览器场景 A–E，正常 WebM/MP4 下载、暂停、定时停止、保存失败重试均通过。

### Task 4: 重启发现、恢复保存与下载对账

**Files:**
- Create: `recovery.js`
- Modify: `offscreen.html`
- Modify: `offscreen.js`
- Modify: `background.js`
- Modify: `save-status.html`
- Modify: `save-status.js`
- Modify: `popup.html`
- Modify: `popup.js`
- Test: `e2e/unit-save-state.mjs`
- Test: `e2e/unit-save-ui.mjs`
- Test: `e2e/unit-popup-save.mjs`

**Interfaces:**
- Produces: `recoverDurableBlob(metadata) → Promise<{ blob, filename, durMs }>`；读取 OPFS，WebM 调用 Task 1 恢复 API，原生 MP4 复用现有 faststart/时长修复。
- Messages: `OFF_RECOVER_RECORDING`、`RECOVER_RECORDING`、`DISCARD_RECOVERY`；回复 `{ ok: 1 }` 或 `{ error }`。
- `durableRecording.phase`: `recording | processing | downloading | error`；恢复期间 background 复用 `processing/savePhase`，并以 `recoveryAvailable/recoveryBusy` 区分来源。

- [x] **Step 1: 写状态/UI 失败测试。**覆盖重启发现、重复 RECOVER 幂等、原下载 complete/in_progress/interrupted 对账、恢复失败保留、明确丢弃清理、恢复期间禁止新录制；文案不把暂存称为已保存。
- [x] **Step 2: 验证失败。**运行上述三个单元测试，预期缺少恢复状态与消息。
- [x] **Step 3: 实现恢复处理。**background 启动时读取本地元数据并打开可见恢复入口；offscreen 单例执行恢复，下载仍由 SAVE_FILE 确认。已有 downloadId 先 search：complete 则写一次历史并清理，进行中则继续观察，interrupted 才重新导出。
- [x] **Step 4: 接入 UI。**save-status 和 popup 显示“发现未完成的录制/正在恢复/恢复失败”，提供恢复保存与确认丢弃；beforeunload 和保存进度沿用现有保护。
- [x] **Step 5: 验证通过。**运行全部保存状态/UI 单元测试，重复操作和下载对账断言通过。

### Task 5: 真实媒体故障 E2E、长录制门槛与文档

**Files:**
- Create: `e2e/run-recovery.mjs`
- Modify: `e2e/run.sh`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-11-04-durable-recording-design.md`

**Interfaces:**
- Consumes: 全部生产 API；测试构建可注入日志/故障，但不得修改媒体语义。
- Produces: 可重复执行的恢复 E2E；可选长压测由 `E2E_RECOVERY_SECONDS` 控制，默认短跑。

- [x] **Step 1: 写真实故障场景。**分别录制 WebM 和原生 MP4，确认暂存增长后强杀测试专用 Chrome，重启恢复并下载；校验时长、流、完整解码、WebM seek/关键帧和无意外 `File ended prematurely`。增加 offscreen 销毁、reload、重复恢复、下载中重启和明确丢弃。
- [x] **Step 2: 验证旧实现失败、新实现通过。**旧实现没有可恢复文件；新实现全部故障场景通过。强杀只针对带测试 profile 的进程，不触碰用户 Chrome。
- [x] **Step 3: 跑完整回归。**运行全部单元测试及浏览器 A–E；再运行 `NATIVE_CHROME_BIN='C:/Program Files/Google/Chrome/Application/chrome.exe' E2E_MANUAL_SHORTCUT=1 npm test` 所代表的原生 MP4 路径，需要快捷键时只操作测试 Chrome。
- [x] **Step 4: 更新文档。**说明 OPFS 存储、磁盘空间、恢复入口和限制；修正“compact 防止内存膨胀”的旧描述，在 AGENTS 记录脚本顺序、Worker 和消息协议。
- [x] **Step 5: 报告未验证边界。**没有真实 Linux 数小时、RDP 或真实播放器证据时明确列出；不以短测宣称长录制已完全可靠。
