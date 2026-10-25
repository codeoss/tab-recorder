# WMP（Windows 自带媒体播放器）无法拖动录制文件 —— 分析过程全记录

> 日期：2026-10-25｜记录人：Kimi Code｜状态：**未解决，寻求复核**
> 目的：供其他 agent 复核推理链、发现漏洞、或推进剩余的判定性实验。

## 0. TL;DR

- v1.1.2 产出的四个文件**结构全部健康**（逐项二进制验证，见 §1）。
- 对 WMP 不能拖的原因做了三个结构性假设并逐一做成验证文件：**SeekHead 缺失**、**Segment 未知长度被当直播流**、**MP4 缺 mfra 索引**——在 Chrome 里全部验证文件都表现完美，但在 WMP 里**全部依旧不能拖**。
- 当前主判断：**Windows Media Foundation 的 WebM/fMP4 源支持本身就是不可 seek 的**（平台层缺陷，与文件内容无关）。但还缺一个决定性对照实验没做（见 §5）。
- 如果你是接手分析的 agent：请先读 §5 的实验清单，别再重复 §2-§3 已否决的方向。

## 1. 素材与结构体检（实测数据）

四个文件均用扩展 v1.1.2 录制。结构分析脚本逐字节解析，结论：

| 文件 | 录制环境 | 大小 | 结构 |
|---|---|---|---|
| TabRecord_2026-10-25T14-23-28.mp4 | 云电脑 Windows Chrome 156 | 83.8MB | fMP4：ftyp→moov(头)→moof/mdat×116；**无 mfra**；mvhd 时长 0（fMP4 正常） |
| TabRecord_2026-10-25T14-42-52.mp4 | 本机 Linux Chrome 153 | 172.0MB | fMP4：moov 在头；**无 mfra**；77 分片 |
| TabRecord_2026-10-25T14-33-07.webm | 云电脑 Chrome 156 | 347.2MB | Duration=428.0s ✅（v1.1.2 插入生效）；Cues 557 条全覆盖 0~427.6s ✅ |
| TabRecord_2026-10-25T14-38-51.webm | 本机 Linux Chrome 153 | 181.8MB | Duration=376.5s ✅；Cues 453 条全覆盖 ✅ |

WebM 侧两个文件**无任何缺陷**；MP4 侧唯一缺口是 mfra。

## 2. WebM 侧排除法（全部被 WMP 否决）

### 2.1 假设 A：缺 SeekHead

WebM 的 SeekHead（`0x114D9B74`）是"索引的索引"，写在 Segment 开头，告诉播放器 Info/Tracks/Cues 的位置。Chrome 录制不写它，fix-webm 也没补过。

**实验**：写了 `tools/webm-add-seekhead.mjs` 给文件补 SeekHead（插入 50 字节于 Segment 数据开头，既有 Cues 的 CueClusterPosition 全部等宽 +50 修补，453 条逐条验证命中 Cluster 头）。

**踩坑**：SeekPosition 的基准。规范字面写"相对 Segment 数据段"，照做后 Chrome 全部解码失败；改成"相对 Segment 元素头（含 ID+size 字段）"后 Chrome 四个深度点位（60/180/300/370s）全部秒拖成功。**以实测为准**：本工具用元素头基准（`REL_ELEMENT=1`）。

**WMP 结果：❌ 仍不能拖。**

### 2.2 假设 B：unknown-size Segment 被当直播流

Chrome 流式录制时 Segment 的 size 字段写全 1（"长度未知"）。假设 MF 把这类文件识别为直播流（直播流不可拖）。由于保存时真实大小已知，8 字节 VINT 原位回填定长即可（不动任何偏移，最干净）。

**实验**：同一工具，`NO_SEEKHEAD=1`（只回填）与完整版（回填+SeekHead）各一份。Chrome 实测无损。

**WMP 结果：❌ 都不能拖。**

### 2.3 当前结论

SeekHead、定长 Segment、Duration、Cues 全部具备的文件 WMP 仍不可 seek → 结构假设用尽，指向 **MF 的 WebM 源（Web Media Extensions / MFWebM）自身不实现 seek**。注意这是推断，缺决定性对照（§5）。

## 3. MP4 侧：mfra 缺失的机制（这部分是实锤）

### 3.1 为什么所有长录制都没有 mfra

Chromium 源码（`media/muxers/mp4_muxer_delegate.cc`，main 分支）：

```cpp
if (live_mode_) {
  // live mode can not have `mfra` box.
  return;
}
```

mfra 只在「文件模式」（所有分片攒到最后一次性写出）才写。而 `FlushFragment()` 一旦被调用过就进 live 模式永不写 mfra。冲刷触发条件（`mp4_muxer.cc` 的 `MaybeForceFragmentFlush`）：**距上次冲刷超过 `max_data_output_interval` 且新关键帧到达**。该间隔来自 `MediaRecorder.start(timeslice)` —— 本扩展用 `start(1000)`（每秒出分片，防内存膨胀的核心设计）。

本机 Chrome 153 实测（品牌版、canvas+WebAudio 录制）：

| 录制 | 分片数 | mfra |
|---|---|---|
| 2.5s（无 timeslice） | 1 | ✅ 有 |
| 8s（start(1000)） | 1 | ✅ 有 |
| 16s（start(1000)） | 2（关键帧触发冲刷） | ❌ 无 |

**即：本扩展任何超过约一个关键帧间隔（实测 8~16s）的 MP4 都没有 mfra。与 Chrome 版本无关。**

### 3.2 mfra 追加实验

`tools/mp4-add-mfra.mjs`：扫全部 moof（每 moof 内视频 traf + 音频 traf），按轨收集 `{tfdt 解码时间, moof 绝对偏移, traf 序号}`，构建 tfra×2 + mfro 追加文件尾。回读校验：77/116 条/轨、时间单调、偏移全部命中真 moof；Chrome 播放+拖动无损。

**WMP 结果：❌ 仍不能拖**（用户实测，`TabRecord_2026-10-25T14-42-52_mfra.mp4` / `...14-23-28_mfra.mp4`）。

→ 这说明 WMP/MF 对分片 MP4 即使有 mfra 也不建索引，或我的 mfra 有 WMP 层面不接受的细节（未排除）。

## 4. 文件清单与复现

工具（本目录 `tools/`）：

```bash
# WebM 补 SeekHead（+回填定长 Segment）：
node tools/webm-add-seekhead.mjs in.webm out.webm
#   环境变量：NO_SEEKHEAD=1 只回填 size；SEG_UNKNOWN=1 只加 SeekHead 不回填；
#   NO_CUES_ENTRY=1 SeekHead 不含 Cues 条目；SEG_DATA_BASE=1 用规范字面的
#   「相对数据段」基准（默认是实测正确的「相对 Segment 元素头」基准）
```

```bash
# MP4 补 mfra：
node tools/mp4-add-mfra.mjs in.mp4 out.mp4
```

验证文件（用户云电脑实测过 WMP 均不能拖）：
- `~/Downloads/TabRecord_2026-10-25T14-38-51_{defsize,full}.webm`
- `~/Downloads/TabRecord_2026-10-25T14-33-07_full.webm`
- `~/Downloads/TabRecord_2026-10-25T14-{23-28,42-52}_mfra.mp4`

## 5. 给其他 agent 的判定性实验（按优先级）

1. **ffmpeg 对照组（最关键）**：
   - `ffmpeg -i 14-38-51.webm -c copy webm-ffmpeg.webm`（ffmpeg 产出的 WebM：定长 Segment + 完整 SeekHead + Cues）
   - `ffmpeg -i 14-42-52.mp4 -c copy -movflags +faststart mp4-ffmpeg.mp4`（去分片成经典 MP4）
   - 两个都在 WMP 里试。
   - **能拖** → 文件结构差异仍有未发现的点，继续二进制 diff 对照组与本扩展产物的区别（重点：ffmpeg 的 Cues 在文件头还是尾、SeekHead 的基准、stco/stbl 细节）。
   - **不能拖** → WMP 平台层不支持的结论坐实，产品侧不用再投入，文档写"WMP 用户请转 PotPlayer 或 ffmpeg 重封装"。
2. WMP 里拖一个**第三方正常下载的 WebM**（非本扩展产物）：不能拖 → 平台缺陷；能拖 → 继续 diff。
3. 若有人能读 MF 的 WebM 源实现（或 Web Media Extensions 的行为文档）：确认其 seek 支持矩阵（vp9+opus、unknown-size segment、Cues at end 各自的支持情况）。
4. 我的 mfra 构造若被怀疑：用 ffmpeg `-movflags +faststart` 的重封装产物 diff 我的 tfra 字段（length_size_of_traf_num 等三个位段、entry 字段宽度）。

## 6. 本仓库相关产品代码状态（v1.1.2 已含）

- fix-webm.js：Cues 重建、Duration 修补/插入、流式实现、幻影防护（详见仓库 git log）
- mp4-faststart.js：纯 JS moov 搬迁（对 fMP4 直通）
- ffmpeg.wasm 仅用于老 Chrome（<126 无原生 MP4）的转码；它有 wasm32 4GB 内存天花板，GB 级文件会 OOM——不是本问题的解法

## 7. 诚实声明

- §2 的 WMP 失败是**用户实测**，我没有 Windows 环境无法亲测。
- §3.1 的机制有 Chromium 源码 + 本机实测双证据，可信。
- 本文未排除"我的 SeekHead/mfra 构造有 WMP 不接受的细节错误"——§5.1 的 ffmpeg 对照组就是为了区分这一点。
