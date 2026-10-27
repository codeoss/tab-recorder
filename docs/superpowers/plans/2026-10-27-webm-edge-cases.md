# WebM Edge Cases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 先用两个回归用例证明 WebM 边界缺陷，再以最小改动修复候选关键帧扫描和 Info 信任策略。

**Architecture:** 保留 streaming 生产路径与 legacy golden 对照。关键帧扫描跳过负合成时间候选但不放松真实关键帧判断；不可信 Info 在两条路径上都原样返回。

**Tech Stack:** 原生 JavaScript、Node.js Blob/Buffer、现有 Playwright E2E；无新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-27-webm-edge-cases-design.md`

## Global Constraints

- 基线为 `main` 的 `5f7e9d08dadf3fac117d6a6e350d52d49e2930cb`，工作区为 `.worktrees/fix-webm-edge-cases`。
- 用户要求测试先于产品修复；必须保存 RED→GREEN 的真实命令输出。
- 不伪造 Cue，不修改媒体负载，不放宽 Info 校验，不引入 ffmpeg.wasm。
- 不改录制、保存、MP4、权限或发布版本；不自行推送、合并或发布。

## Review Focus

- 负 SimpleBlock 和负 BlockGroup 不得遮住后续有效关键帧：Task 2 的 `[40,160]` 用例。
- Info 缺 `TimecodeScale` 不得触发两条路径不同的编辑：Task 2 的 `expectOriginal` 用例。
- 正常非负关键帧不得改变：Task 3 的全部 golden 对照。
- 晚到 Timestamp、截断 ReferenceBlock 不得重新被猜测：Task 3 的既有第 18/19 项用例。
- 媒体负载不得改变：Task 2 的 `webMClustersEqual` 与 Task 4 的真实下载校验。

---

### Task 1: 基线与测试环境

**Files:**
- Modify: 无产品文件。

**Interfaces:**
- Consumes: `main` 的 v1.2.1 文件树。
- Produces: 可运行 `npm test` 的隔离工作区。

- [x] 在 `e2e/` 运行 `npm install --no-audit --no-fund`。
- [x] 运行 `NATIVE_CHROME_BIN='C:/Program Files/Google/Chrome/Application/chrome.exe' E2E_MANUAL_SHORTCUT=1 npm test`，确认基线退出码 0；失败则不进入产品修改。

### Task 2: 两个回归用例先失败

**Files:**
- Modify: `e2e/lib-webmcheck.mjs:167-220`
- Modify: `e2e/unit-webmstream.mjs:474-501`

**Interfaces:**
- Consumes: 既有 `clusterKeyframe(b, cluster, trackNumber, mediaEnd)` 内部函数。
- Produces: `clusterKeyframe(b, cluster, trackNumber, mediaEnd, expectedTime = null)`，传入时间时只返回该时间的真实视频关键帧；`checkWebMKeyframeCues` 传入 `cue.time`。

- [x] **Step 1: 只修改测试校验器和两个用例。** 在 SimpleBlock/BlockGroup 候选返回处增加 `expectedTime === null || block.time === expectedTime`。新用例一使用 `info({})`、`tracks`、两个定长 Cluster：`Cluster.Timecode=0` 依次放 `simpleBlock({track:1,relative:-20,keyframe:true})` 和 `blockGroup({track:1,relative:40})`；`Cluster.Timecode=100` 依次放 `blockGroup({track:1,relative:-120})` 和 `simpleBlock({track:1,relative:60,keyframe:true})`。经 `golden()` 后断言 `checkWebMKeyframeCues(fixed).cueTimes` 精确等于 `[40,160]`。
- [x] **Step 2: 添加缺少 TimecodeScale 用例。** 向 `expectOriginal` 传入 `wrapDefinite([el(INFO, el(DURATION, new Uint8Array(8))), tracks, cluster(0)])`，要求 legacy 和 streaming 都逐字节返回输入。
- [x] **Step 3: 验证 RED。** 运行 `node e2e/unit-webmstream.mjs`。预期退出码 1；用例一当前没有期望的 `[40,160]`，用例二的 legacy 原样返回断言失败。不得修改产品代码或降低断言来取得 GREEN。

### Task 3: 最小产品修复

**Files:**
- Modify: `fix-webm.js:264-304,391-434,750-790`
- Modify: `AGENTS.md:75-85`

**Interfaces:**
- Consumes: Task 2 的两个失败用例。
- Produces: 两个关键帧查找函数返回首个非负合成时间的真实视频关键帧；Info 不可信时 legacy 与 streaming 都原样返回。

- [x] **Step 1: 修复候选筛选。** SimpleBlock 中仅当 `clusterTime + block.relative >= 0` 时返回该值；BlockGroup 中仅当 `clusterTime + candidate >= 0` 时返回。两个实现同步，保留外层单调检查。
- [x] **Step 2: 对齐 Info 信任策略。** 将 legacy 的 `infoOff = cur` 移入 `clean && sawScale && ic === infoEnd` 分支，其他字段和 streaming 行为不变。
- [x] **Step 3: 更新项目说明。** 记录负候选继续扫描与不可信 Info 原样返回，不改动无关架构说明。
- [x] **Step 4: 验证 GREEN。** 运行 `node e2e/unit-webmstream.mjs` 和 `node --check fix-webm.js`，预期退出码均为 0，两个新用例和所有既有用例通过。

### Task 4: 完整验证与交付

**Files:**
- Modify: 无新增产品改动。

**Interfaces:**
- Consumes: Task 3 的 GREEN 结果。
- Produces: 最终 diff 和完整测试证据。

- [x] 运行完整 `NATIVE_CHROME_BIN='C:/Program Files/Google/Chrome/Application/chrome.exe' E2E_MANUAL_SHORTCUT=1 npm test`，确认全部单元测试及真实浏览器 A–E 通过，退出码 0。
- [x] 运行 `git diff --check`、检查 `git diff --stat` 和最终差异，确认只有两个目标行为变化及相应测试/文档。
- [x] 汇报 RED→GREEN 的实测输出、完整回归结果及未覆盖的手工环境；保留工作区供用户审阅，不自行推送或发布。

## Self-review

- 两个用户指定用例均先于产品代码，且断言包含精确数值和媒体不变约束。
- `expectedTime` 的测试接口与调用一致；生产函数签名不变。
- 不通过删除安全校验或接受 legacy/streaming 差异来消除 RED。
- 计划仅覆盖本次两个边界，其他环境限制明确保留。
