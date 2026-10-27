# WMP Seek 与可靠保存 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让扩展产出的 WebM/MP4 在 Windows 媒体播放器中可拖动，并让用户在整理、转码、下载落盘、失败等待处理的整个保存期间看到准确状态，降低误关浏览器导致录制丢失的风险。

**Architecture:** 保留现有 offscreen/recorder 双引擎和纯 JS、无构建架构。WebM 在现有流式修复中插入规范 SeekHead；fMP4 只读取 moov/moof 并原位回填真实时长，不做转码或完整重封装。保存改为 background 通过 `chrome.downloads` 确认真实下载结果；标签页模式新增可见保存窗口，桌面模式复用 recorder 窗口，popup、徽章和关闭保护共享同一保存状态。

**Tech Stack:** Manifest V3、经典 JavaScript IIFE、HTML/CSS、Chrome downloads/windows/storage API、Node.js 单元测试、现有 Playwright + X11 E2E。

**Spec:** `origin/docs/wmp-seek-analysis:docs/wmp-seek-2026-10/README.md` 的问题背景；本对话 2026-10-26 已验证的根因、纯 JS 修复方向，以及用户要求的“保存状态必须清晰可见，避免误关浏览器丢文件”。

## Global Constraints

- 不新增 ffmpeg.wasm 调用，不新增 npm 依赖、框架、构建步骤、网络请求、遥测或远程代码。
- 不新增 `host_permissions`、`tabs` 权限或 `web_accessible_resources`；仅为确认下载结果增加 `downloads` 权限；保留现有 CSP 的 `'wasm-unsafe-eval'`。
- WebM 内存保持 `O(扫描窗口 + Cues)`；MP4 修补保持 `O(moov + 单个 moof + 分片元数据)`；不得为了修补元数据把完整 mdat 物化为 ArrayBuffer。
- 只有 `chrome.downloads` 报告 `complete` 后才能显示“已保存”、写成功历史并允许保存窗口自动关闭；`a.click()` 或 `downloads.download()` 启动成功不等于已保存。
- 处理中、下载中及仍可重试的保存失败期间，`START_RECORDING` 必须继续被重入守卫拒绝；重试成功或用户明确丢弃前，关窗保护不得解除。
- 保存失败不得伪造成功历史；引擎上下文仍存在时必须保留最终 Blob 供重试，或让用户明确选择丢弃。若 recorder/offscreen 上下文已销毁，必须标记 `saveCanRetry=false`、提示无法恢复并清除僵尸忙态，不能提供假重试。
- 文件注释风格遵循 `AGENTS.md`：`fix-webm.js`、`mp4-faststart.js` 保持英文注释，其余文件以中文说明“为什么”；同步清理描述旧行为的注释与文档。
- `beforeunload` 只能降低误关概率，不能保证阻止强制退出、系统关机或进程崩溃；不得把本计划描述成崩溃恢复或绝对防丢方案。

## Review Focus

- WebM 同时发生 Duration 插入、Info VINT 加宽、SeekHead 插入和 unknown-size Segment 时，所有 SeekPosition/CueClusterPosition 仍须命中真实元素；由 Task 1 的组合夹具钉死。
- MP4 的 `trun` 缺省 sample duration、多个 `traf/trun`、composition offset、不同 timescale 及 version 0/1 时间字段不能算错时长；由 Task 2 的精确数值夹具钉死。
- popup 已关闭或 MV3 service worker 被回收时，保存状态和下载结果仍须可恢复；由 Task 3 的恢复测试及 Task 5 的 E2E 钉死。
- 下载中断、重试、明确丢弃三条路径不得提前写历史或错误解除忙态；由 Task 4 的受控 Promise 测试和 Task 5 的失败注入 E2E 钉死。
- recorder/offscreen 上下文意外销毁与单纯保存窗口关闭必须区分：前者不可重试但要清除僵尸忙态，后者不影响引擎继续保存；由 Task 5 的生命周期测试钉死。
- 大文件处理不得新增完整媒体扫描或整段 mdat 读取；由 Task 1/2 的读取范围断言和 Task 6 的真实大文件计时复核。
- 用户直接关闭整个 Chrome 时，原生关闭确认是否出现取决于 Chrome 和用户激活状态；Task 6 必须实测并如实记录，不能用单元测试代替这一平台边界。

---

### Task 1: WebM 增加规范 SeekHead

**Files:**
- Modify: `fix-webm.js`
- Test: `e2e/unit-webmstream.mjs`
- Test: `e2e/run.mjs`

**Interfaces:**
- Consumes: 现有 `fixWebMBlob(blob, durationMs)`、`_fixWebMFullBuffer()`、`_fixWebMStream()` 签名不变。
- Produces: 输出在 Segment 数据区开头含 `SeekHead{Info, Tracks, Cues}`；`SeekPosition` 和 `CueClusterPosition` 均相对 `segDataStart`。内部扫描结果增加 `infoOff`、`tracksOff`，供定位使用；不改变公开 API。

- [ ] **Step 1: 先写 SeekHead 语义失败测试**

在 `e2e/unit-webmstream.mjs` 增加一个小型 EBML 校验器，不复用生产扫描器作为唯一判据。对现有 Duration 原位改写、Duration 插入、Info VINT 加宽、unknown Segment、unknown-size Cluster、200 Clusters、幻影防护用例逐一断言：

- 恰好一个头部 SeekHead，含 Info/Tracks/Cues 三项。
- 三项 `SeekPosition + segDataStart` 分别精确命中对应元素 ID。
- 所有 Cue 的 `CueClusterPosition + segDataStart` 命中真实 Cluster，首末时间码未丢失。
- 定长 Segment 的声明结束位置等于文件尾；unknown Segment 仍保持 unknown。
- 媒体 Cluster 负载与输入逐字节一致，幻影 Info 负载没有被改写。

在 `e2e/run.mjs` 的真实产物 `checkWebM()` 中增加同样的三项定位断言，而不是只检查字节串存在。

- [ ] **Step 2: 运行测试确认旧实现失败**

Run: `node e2e/unit-webmstream.mjs`

Expected: 现有实现因缺少 SeekHead 而 FAIL；其余既有 golden 断言继续通过，证明新增测试能区分旧行为。

- [ ] **Step 3: 在 legacy 与 streaming 两条路径同步实现**

在 `fix-webm.js` 中：

- 扫描时记录首个干净 Info 和 Tracks 的元素偏移。
- 增加固定宽度无符号整数编码，三个 SeekPosition 都使用 8 字节，使 SeekHead 长度与文件位置无关。
- 在 `segDataStart` 插入含 Info/Tracks/Cues 的 SeekHead；Cues 的最终相对位置按 `total + 全部头部净增量 - segDataStart` 计算。
- 将 SeekHead 长度计入现有 `headDelta`，再构建 Cues；Info 的位置只加 SeekHead 长度，Tracks/Cluster 的位置加全部前置净增量。
- 定长 Segment 的 size 增加 SeekHead、Duration 和 Cues 的净增量；unknown Segment 不回填。
- 保持 `fixWebM()` 与 `fixWebMStream()` 逐字节等价；不得额外做一次完整文件扫描。

- [ ] **Step 4: 运行 WebM 单元测试**

Run: `node e2e/unit-webmstream.mjs`

Expected: 所有既有 golden/窗口宽度/幻影测试与新增 SeekHead/Cue 定位断言 PASS。

- [ ] **Step 5: 做读取范围与语法检查**

Run: `node --check fix-webm.js && node --check e2e/unit-webmstream.mjs && node --check e2e/run.mjs`

Expected: 三个文件均为 exit 0。代码复核确认 SeekHead 构建只操作小数组，没有新增 `blob.arrayBuffer()` 全文件读取。

- [ ] **Step 6: Commit**

```bash
git add fix-webm.js e2e/unit-webmstream.mjs e2e/run.mjs
git commit -m "fix(webm): add standards-based SeekHead for WMP seeking"
```

### Task 2: fMP4 回填真实媒体时长

**Files:**
- Modify: `mp4-faststart.js`
- Modify: `e2e/lib-mp4check.mjs`
- Test: `e2e/unit-mp4faststart.mjs`
- Test: `e2e/unit-native-mp4.mjs`

**Interfaces:**
- Consumes: 现有 `mp4FaststartJs(blob): Promise<Blob>`，签名不变。
- Produces: 对含 moof 的输入返回同长度 Blob，原位修正 `mvhd/tkhd/mdhd` 时长，所有 mdat 字节不变；普通 MP4 的 faststart 行为不变。`e2e/lib-mp4check.mjs` 增加轨道时长与分片读取辅助，供两个 MP4 测试文件使用。

- [ ] **Step 1: 写多分片时长失败测试**

在 `e2e/unit-mp4faststart.mjs` 构造带两轨、至少三个 moof 的最小 fMP4，覆盖并精确断言：

- 视频 timescale=30000、音频 timescale=48000，电影 timescale=1000；最终 mvhd 取最长轨道的真实结束时间。
- `trun` 显式 sample duration、`tfhd` 默认时长、`trex` 回退、同 traf 多 trun。
- `tfdt` version 0 和 version 1；`mvhd/mdhd/tkhd` version 0 和 version 1。
- 视频 composition offset 参与最晚呈现结束时间计算。
- 非分片且已 faststart 的输入仍原样返回；损坏/截断 moof 明确抛错供调用方回退。
- 输出总长度不变，moov 大小不变，所有 mdat payload 与输入逐字节一致，moof/mfra 不被伪造或删除。

- [ ] **Step 2: 运行测试确认旧实现失败**

Run: `node e2e/unit-mp4faststart.mjs`

Expected: 新 fMP4 用例因 mvhd=0 或分片直通而 FAIL；普通 faststart 用例继续 PASS。

- [ ] **Step 3: 实现只读 moov/moof 的时长修补**

在 `mp4-faststart.js` 顶层 box 扫描后，先识别 moof：

- 从 moov 读取 trackID、mdhd timescale、tfhd/trex 默认 sample duration。
- 顺序读取每个完整 moof，跳过其后的 mdat；解析 tfhd/tfdt/trun 的全部 flags 和可选字段。
- 对每轨累加各 trun 的样本时长，结合 tfdt 与 composition offset 求最大结束时间；缺省 duration 按 tfhd→trex 顺序回退。
- 用安全整数/64 位读取，溢出、截断或无法确定时长时抛错，不写猜测值。
- 原位回填 mvhd.duration；tkhd 使用电影 timescale，mdhd 使用各自轨道 timescale。只替换同长度 moov，不搬动媒体数据，不新增 mfra。

- [ ] **Step 4: 更新真实 Chrome 测试以覆盖生产分片方式**

在 `e2e/unit-native-mp4.mjs` 将测试录制改为与生产一致的 `rec.start(1000)`，录制 18 秒后停止（等待产物设明确超时）。若平台产出分片布局，断言：moof≥2、mvhd/mdhd/tkhd 时长合理、总大小不变、mdat 不变；删除“分片产物必须逐字节未改动”的旧断言。经典 moov 在尾布局继续验证 faststart。

- [ ] **Step 5: 运行全部 MP4 测试**

Run: `node e2e/unit-mp4faststart.mjs && node e2e/unit-native-mp4.mjs`

Expected: 手工 fMP4、普通 faststart、真实 Chrome 产物全部 PASS；测试日志明确显示实际布局、分片数和测得时长。

- [ ] **Step 6: Commit**

```bash
git add mp4-faststart.js e2e/lib-mp4check.mjs e2e/unit-mp4faststart.mjs e2e/unit-native-mp4.mjs
git commit -m "fix(mp4): restore duration metadata for fragmented recordings"
```

### Task 3: background 提供可确认的下载 broker

**Files:**
- Modify: `manifest.json`
- Modify: `background.js`
- Create: `save-file.js`
- Modify: `offscreen.html`
- Modify: `recorder.html`
- Test: `e2e/unit-save-state.mjs`
- Modify: `e2e/run.sh`
- Modify: `e2e/run.mjs`（仅把新脚本加入既有语法探针清单）

**Interfaces:**
- Produces: `saveFileViaBackground(blob, filename): Promise<{ filename: string, path: string }>`，供 Task 4 注入引擎。
- Message `SAVE_FILE {url, filename}` 返回 `{downloadId}` 或 `{error}`。
- Message `GET_DOWNLOAD_STATUS {downloadId}` 返回 `{state:'in_progress'|'complete'|'interrupted', error?, filename, path, received, total}`。
- background 状态增加 `savePhase:''|'processing'|'downloading'|'complete'|'error'`、`processingStage`、`downloadId`、`saveError`、`saveFilename`、`saveWindowId`、`saveCanRetry`、`saveReceived`、`saveTotal`；保留 `processing` 作为重入守卫。`saveCanRetry` 只在持有最终 Blob 的引擎仍存在时为 true。每次 `GET_DOWNLOAD_STATUS` 对账也更新 `saveReceived/saveTotal`，使保存窗口仅凭 GET_STATE 就能显示真实进度。
- `chrome.downloads` 使用 `conflictAction:'uniquify'`，成功结果返回浏览器最终采用的真实文件名和路径。

- [ ] **Step 1: 用 fake chrome 写下载状态失败测试**

新建 `e2e/unit-save-state.mjs`，以 `vm` 加载 background.js 和可控的 `chrome.downloads/windows/storage` mock，覆盖：

- `SAVE_FILE` 创建下载并进入 downloading；重复未完成任务被拒绝。
- `complete` 返回 uniquify 后的真实文件名/路径；`interrupted` 返回错误且不得进入 complete。
- `GET_DOWNLOAD_STATUS` 能返回 received/total；service worker 状态恢复后可按 downloadId 查询并对账。
- `onChanged` 只处理当前 downloadId，其他扩展或用户下载不能污染本录制状态。
- processing/downloading 期间的 `DISCARD_RECORDING` 返回忙错误且不取消下载；只有 error 且 `saveCanRetry=true` 时才进入 Task 4 的明确丢弃路径。
- 新录制获准启动时清理上一段的 complete/error、downloadId、saveCanRetry 等终态字段。

将新测试加入 `e2e/run.sh`，位于真实 E2E 之前。

- [ ] **Step 2: 运行状态测试确认失败**

Run: `node e2e/unit-save-state.mjs`

Expected: 因 `SAVE_FILE` 路由和 downloads broker 尚不存在而 FAIL。

- [ ] **Step 3: 实现 background 下载 broker**

在 `manifest.json` 只增加 `downloads` 权限。在 `background.js` 顶层注册 `chrome.downloads.onChanged`，使用 downloadId 跟踪当前保存任务；`SAVE_FILE` 启动下载，`GET_DOWNLOAD_STATUS` 查询并对账，`storage.session` 保存足够的恢复信息。未完成保存继续占用重入守卫，错误信息使用 Chrome 给出的 `InterruptReason`，不解析私有错误文案。按上一步测试实现丢弃守卫和开始新录制时的终态清理。

- [ ] **Step 4: 实现引擎侧 Blob URL 适配器**

在 `save-file.js` 用 IIFE 暴露 `self.saveFileViaBackground`：创建 Blob URL，发送 `SAVE_FILE`，每秒轮询 `GET_DOWNLOAD_STATUS` 直到终态，终态后才 `revokeObjectURL`。删除固定 30 秒 revoke 思路；下载进行中不设人为短超时。失败时 reject，成功时返回真实文件名/路径。按 `offscreen.html`/`recorder.html` 的依赖顺序在 `core-recorder.js` 前加载，并把 `save-file.js` 加入 `e2e/run.mjs` 的语法探针清单。

- [ ] **Step 5: 运行 broker 测试与语法检查**

Run: `node e2e/unit-save-state.mjs && node --check background.js && node --check save-file.js && node --check e2e/run.mjs`

Expected: 全部 PASS、exit 0；offscreen 只通过 runtime 与 background 通信，不直接访问不受支持的 `chrome.downloads`。

- [ ] **Step 6: Commit**

```bash
git add manifest.json background.js save-file.js offscreen.html recorder.html e2e/unit-save-state.mjs e2e/run.sh e2e/run.mjs
git commit -m "feat(save): confirm recording downloads in background"
```

### Task 4: 引擎等待真实落盘，并支持失败重试/明确丢弃

**Files:**
- Modify: `core-recorder.js`
- Modify: `offscreen.js`
- Modify: `recorder.js`
- Modify: `e2e/run.mjs`（同步既有保存探针锚点）
- Test: `e2e/unit-save-engine.mjs`
- Modify: `e2e/run.sh`

**Interfaces:**
- Consumes: Task 3 的 `saveFileViaBackground(blob, filename)`。
- `createRecorderEngine({getStream, onEvent, releaseExtra, saveFile})` 新增必填 `saveFile(blob, filename)`。
- `engine.retrySave(): Promise<boolean>` 重试最后一次失败的最终 Blob；`engine.discard()` 在保存失败态明确表示用户放弃并释放 Blob。
- `engine.isBusy()` 在整理、下载、保存失败待处理期间均为 true。
- `processing` 事件扩展为 `{active, stage:'webm-fix'|'mp4-fix'|'transcode'|'download'}`；新增 `saveerror:{message}`，宿主以 `ENGINE_SAVE_ERROR {message, canRetry:true}` 上行。
- `RECORDING_STOPPED/RECORDER_STOPPED` 增加可选 `discarded` 字段；saved/stopped 只在成功或明确丢弃后上报，成功历史使用下载 broker 返回的真实文件名。

- [ ] **Step 1: 用可控 saveFile 写引擎失败测试**

新建 `e2e/unit-save-engine.mjs`，以 fake MediaRecorder/stream 和可控 Promise 驱动真实 `createRecorderEngine`：

- stop 后先进入 processing，saveFile Promise 未 resolve 时不得发 saved、成功 stopped/history 或 processing=false。
- resolve 后才发 saved、成功 history 并解除忙态；uniquify 后的文件名同时用于 saved 和 history。
- reject 时发 saveerror、不写历史、`isBusy()` 保持 true；`retrySave()` 使用同一最终 Blob 重试并成功，不重复执行修复/转码。
- 失败后选择 `discard()` 时释放 pending Blob、发 `discarded:true` 的 stopped、解除忙态；不得再触发下载。
- 保存期间重复 stop/start 不会创建第二条保存链。

将测试加入 `e2e/run.sh`。

- [ ] **Step 2: 运行引擎测试确认失败**

Run: `node e2e/unit-save-engine.mjs`

Expected: 旧实现因立即 `a.click()`、提前 saved/stopped 或缺少 retrySave 而 FAIL。

- [ ] **Step 3: 重构 onStopped 为可等待的保存链**

在 `core-recorder.js` 中保留最终 Blob 到保存终态：依次发出 webm-fix/mp4-fix/transcode 阶段，`await saveFile(finalBlob, filename)` 时才进入 download；成功后再写 saved/stopped/history。失败保留 pending Blob 和忙态并发出 saveerror；`retrySave()` 只重试下载，不重新扫描或转码；`discard()` 是失败态唯一解除忙态的放弃路径。

- [ ] **Step 4: 接入两个宿主并转发事件**

在 `offscreen.js` 与 `recorder.js` 创建引擎时注入 `saveFile: saveFileViaBackground`，转发 processing stage 和 `ENGINE_SAVE_ERROR`；offscreen 增加 `OFF_RETRY_SAVE`，recorder 的本地重试直接调用 `engine.retrySave()`。两个宿主的 stopped 上行都携带 discarded；offscreen 不需另发 saved，background 已由下载 broker 和 stopped 知道结果。移除 core 内的 `<a download>` 和固定 revoke 逻辑，并把 `e2e/run.mjs` 中 `dl(finalBlob, filename)` 探针锚点改为新的 saveFile 调用点。

- [ ] **Step 5: 运行引擎与既有单元测试**

Run: `node e2e/unit-save-engine.mjs && node e2e/unit-webmstream.mjs && node e2e/unit-mp4faststart.mjs && node --check e2e/run.mjs`

Expected: 全部 PASS，尤其确认成功事件顺序、真实文件名与失败忙态没有回归。

- [ ] **Step 6: Commit**

```bash
git add core-recorder.js offscreen.js recorder.js e2e/unit-save-engine.mjs e2e/run.sh e2e/run.mjs
git commit -m "fix(recorder): keep recordings busy until download completes"
```

### Task 5: 全程可见的保存状态与关闭保护

**Files:**
- Create: `save-status.html`
- Create: `save-status.js`
- Modify: `background.js`
- Modify: `popup.html`
- Modify: `popup.js`
- Modify: `recorder.html`
- Modify: `recorder.js`
- Test: `e2e/run.mjs`
- Test: `e2e/unit-save-state.mjs`

**Interfaces:**
- Consumes: Task 3 的状态字段和 Task 4 的引擎事件/重试接口，尤其用 `saveCanRetry` 区分可恢复下载失败与引擎上下文已销毁。
- Message `OPEN_SAVE_WINDOW` 打开或聚焦标签页保存窗口；`RETRY_SAVE` 转发为 `OFF_RETRY_SAVE`；明确丢弃继续复用 `DISCARD_RECORDING`。
- 保存窗口显示 processing/downloading/complete/error；下载进度使用 `received/total`，total 不可用时显示不确定进度，不伪造百分比。

- [ ] **Step 1: 写“popup 已关闭且下载被延迟”的 E2E 失败场景**

在 `e2e/run.mjs` 用现有测试构建 `patch()` 注入一个可控下载门闩，新增场景 E：

1. 标签页录制后停止并关闭 popup，保存未结束时必须出现独立 `save-status.html` 窗口。
2. 依次看到“正在整理/修复视频”和“正在保存到下载目录”，徽章为 SAVE；此期间不能出现“录制完成/已保存”，历史中不能有该文件，`START_RECORDING` 必须被拒绝。
3. 对保存窗口派发 `beforeunload`，未结束时返回值非空；对任务显式 `OPEN_SAVE_WINDOW` 能恢复手动关闭的进度窗口，且不会新建第二引擎。
4. 放行下载后才出现真实文件名、成功历史和 complete，保存窗口随后自动关闭，徽章清空，新录制重新可用。
5. 另做一次首下载 interrupted：显示失败和“文件仍在内存”，无成功历史；点击重试后成功；独立覆盖明确丢弃后解除忙态。
6. 既有场景 A–D 的停止等待条件改为真实下载 complete，不再用固定 600ms 或文件大小稳定作为成功口径。

同时在 `e2e/unit-save-state.mjs` 增加生命周期断言：关闭 saveWindowId 只丢 UI 句柄；保存中关闭 recorderWindowId 或发现 offscreen 上下文消失则设置 `saveCanRetry=false`、error、清除僵尸忙态且不写成功历史。

- [ ] **Step 2: 运行场景 E 和生命周期测试确认旧实现失败**

Run: `cd e2e && node run.mjs && node unit-save-state.mjs`

Expected: 因标签页保存窗口不存在、popup 提前显示完成、历史提前写入或上下文关闭后状态残留而 FAIL；若受既有 CfT offscreen 回收限制，必须保留状态失败日志，不能把它改写为通过。

- [ ] **Step 3: 实现标签页专用可见保存窗口及上下文对账**

`save-status.html/js` 使用静态扩展页面，每秒轮询 GET_STATE：显示阶段、明确的“请勿关闭浏览器”、真实下载进度、完成文件名和错误详情。processing/downloading 及可重试 error 期间启用 beforeunload；`saveCanRetry=true` 时显示“文件仍在内存”、重试和需二次确认的丢弃按钮，false 时明确提示上下文已关闭、无法重试。成功后保留完成文案 2 秒再关闭。

background 在 tab 模式 `ENGINE_PROCESSING.active=true` 时创建或聚焦保存窗口并记录 saveWindowId；窗口被手动关闭只清除 saveWindowId，不清除 processing/引擎状态。recorderWindowId 在保存中消失，或 GET_STATE 对账发现 tab 引擎 offscreen 已消失且下载尚未 complete 时，按上一步测试标记不可恢复错误并清除僵尸忙态。下载中徽章显示 SAVE，错误显示 `!`，成功后才清空。

- [ ] **Step 4: 修正 popup 和 recorder 的状态文案/控制**

- `popup.js::stop()` 非取消路径改为“录制已停止，正在保存…”，删除立即“录制完成”和 600ms 历史刷新；restore/poll 在 status=idle 但 processing=true 时也立即渲染保存态。
- popup 显示保存阶段、错误和“打开保存进度”入口；处理中禁用开始/设置；只有 saveCanRetry=true 才提供重试/明确丢弃，致命上下文错误允许开始新录制并清除旧终态。
- `recorder.html/js` 复用现有窗口显示相同阶段和真实进度，处理中禁用暂停/停止；可重试失败时保留窗口和 beforeunload，提供重试/丢弃；只有 saved 后才显示“已保存”并自动关闭。
- 所有 beforeunload 使用同步可读的本地 unsaved 标记；文案不写“保证不会丢失”。

- [ ] **Step 5: 运行完整 E2E 与状态测试**

Run: `cd e2e && node run.mjs && node unit-save-state.mjs`

Expected: 场景 A–E 和生命周期断言全部 PASS；popup 关闭、延迟落盘、失败重试、明确丢弃及上下文销毁后的状态顺序与历史写入时刻均符合断言。

- [ ] **Step 6: Commit**

```bash
git add save-status.html save-status.js background.js popup.html popup.js recorder.html recorder.js e2e/run.mjs e2e/unit-save-state.mjs
git commit -m "feat(save): keep saving status visible until files are safe"
```

### Task 6: 文档、真实播放器、关闭流程与性能验收

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: 相关源码文件头部及过时注释（仅限前述任务已改文件）
- Test: 真实录制产物，不提交 Downloads 中的大文件

**Interfaces:**
- Consumes: Tasks 1–5 的最终行为。
- Produces: 与新 SeekHead/fMP4 修复、downloads 权限、save-status 窗口、消息协议、失败重试和验证方式一致的文档；不改变运行接口。

- [ ] **Step 1: 更新架构与用户文档**

在 `AGENTS.md` 更新目录结构、脚本加载顺序、`saveFileViaBackground`、downloads 权限、保存状态/重试协议和测试命令；删除“offscreen 无 UI 所以保存无需可见状态”“触发下载即 saved”等旧描述。在 `README.md` 说明保存窗口各阶段、完成前不要关闭浏览器、失败如何处理、强制退出仍可能丢失，以及 WMP 修复行为。同步源码头部注释和 e2e 注释。

- [ ] **Step 2: 执行静态检查与完整标准测试**

Run:

```bash
for f in background.js core-recorder.js fix-webm.js mp4-faststart.js offscreen.js popup.js recorder.js save-file.js save-status.js; do node --check "$f" || exit 1; done
cd e2e && npm test
```

Expected: 所有语法检查 exit 0；WebM/MP4/下载状态/保存引擎单元测试和 Playwright 场景 A–E 全部 PASS，无跳过的新断言。

- [ ] **Step 3: 用扩展真实录制验证 WMP，而非只修旧样本**

分别生成至少一个多分片 WebM 和一个多分片 MP4。用 Media Foundation 或等价诊断程序断言：WebM `CAN_SEEK=1`，MP4 能读取非零 `MF_PD_DURATION`，两者跳到 60 秒后都能读到邻近时间点的样本；再在 Windows 媒体播放器中手动拖动前/中/后段。FFmpeg 转换文件只作对照，不能替代扩展新产物验收。

- [ ] **Step 4: 手工验证保存 UI 与浏览器关闭边界**

逐项覆盖：tab 停止后立即关闭 popup、定时自动停止、桌面 recorder 最小化后停止、兼容模式、保存中重开 popup、service worker 回收后恢复、一次下载失败重试、一次明确丢弃。尝试关闭保存窗口和整个 Chrome，记录原生确认是否出现；确认未落盘前任何 UI 都不显示已保存，强制结束进程只作为不可消除风险记录而非通过项。

- [ ] **Step 5: 验证保存性能和媒体数据未变**

在现有约 364MB WebM、180MB fMP4 以及可用的 GB 级文件上记录整理与下载阶段耗时。代码/测试复核：WebM 不新增第二次全文件扫描，MP4 不读取 mdat 负载，下载期间不提前 revoke Blob URL；媒体 payload 校验保持一致。对比修复前基线并记录实测值，若出现额外全文件物化或转码级回退则不得验收。

- [ ] **Step 6: 最终复核与 Commit**

核对 git diff：没有 ffmpeg 内核、录制产物、临时诊断程序或凭证进入提交；没有新增 host/tabs/WAR/网络能力。确认本计划每项均有对应测试结果或明确的手工结果，再执行：

```bash
git add AGENTS.md README.md fix-webm.js mp4-faststart.js core-recorder.js offscreen.js recorder.js e2e
git commit -m "docs: document reliable saving and WMP verification"
```
