# 待办：纯 JS 支持 moov-at-end 的分片 MP4

**状态：未实施，保留现有可选 wasm 兜底。**

本文记录该限制的前因后果，避免把“未覆盖一种布局”误解为“MP4 都需要 wasm”或“没有 wasm 会丢视频”。

## 背景

`moov` 保存 MP4 的轨道、时长和索引等元数据，`mdat` 保存编码后的媒体数据，分片 MP4 还包含 `moof` 分片头。普通 MP4 常在录制结束时才写 `moov`，因此它位于文件末尾很常见；分片 MP4 为了流式初始化通常把 `moov` 放在前面，但并非所有封装器都如此。

```text
当前纯 JS 支持：ftyp → moov → moof → mdat → …
待覆盖布局：    ftyp → moof → mdat → … → moov
```

当前实测 Chrome MediaRecorder 的原生分片 MP4 属于第一种。布局由浏览器/封装器决定，`recorder.start(1000)` 只控制数据交付节奏，不指定 moov 位置；扩展的 `new Blob(chunks)` 也不会主动把 moov 移到末尾。

## 当前行为与影响

`mp4-faststart.js` 只在 `moov.off < 第一个 mdat.off` 时进入 `fixFragmentedMp4()`。如果分片 MP4 的 moov 在末尾，代码会走普通 MP4 的 stco/co64 路径；找不到可修正条目时抛错，`core-recorder.js` 再尝试可选的 wasm `mp4Faststart()`。

- 有可用 wasm：尝试用 `-c copy -movflags +faststart` 重排，不重编码，但会加载约 30MB 内核、完整读入并写出文件，耗时和内存随文件增长，GB 级文件可能失败。
- 没有 wasm 或 wasm 失败：保留并下载原始 MP4，不丢录制、不伪造转码结果；但对应布局的时长/索引可能仍未修复，部分播放器可能时长异常或不能正常拖动。
- 普通非分片 MP4 即使 moov 在末尾，现有纯 JS faststart 已能处理；WebM 和当前实测 moov 在前的分片 MP4 不受此限制影响。
- 老 Chrome 需要 WebM→MP4 重编码时，没有 wasm 会回退 WebM；这与“原生 MP4 的特殊布局兜底”是不同路径。

## 为什么暂缓

此项不是当前实测 Chrome 的故障，且不能通过简单搬动 moov 安全完成。错误修改绝对偏移会让播放器读取错误的媒体位置，风险高于保留原始文件和可选兜底。

## 未来实施方案

1. 识别包含 moof 且 moov 在首个 mdat 之后的布局，读取 moov 和各分片头，复用现有分片时间线重建 mvhd/tkhd/mdhd。
2. 将 moov 移到首个 mdat 前，保持总长度和媒体负载不变。
3. 只修正需要修正的绝对偏移，包括但不限于 tfhd base-data-offset、stco/co64、mfra/tfra 的 moof 引用；default-base-is-moof 等相对引用不得一律加同一个位移。
4. 保留 moof/mdat 内容，除确需修正的分片头外不伪造、不重排媒体帧；内存保持 `O(moov + 单个 moof + 分片索引元数据)`，不得把完整 mdat 物化为 ArrayBuffer。
5. 无法确定偏移语义时抛错并保留原文件，继续允许现有 wasm 兜底，不猜测。

## 验收前置条件

- 收集或构造真实等价布局，至少覆盖 moov 在尾、多个 moof/mdat、tfhd 绝对与相对引用、trun data-offset、stco/co64、mfra/tfra、32/64 位字段和截断输入。
- 断言 moov 位置、全部时长、所有相关偏移和 mdat 负载；普通 MP4 与已 faststart fMP4 的既有测试不得回归。
- 用 Blob.slice 记录实际读取范围，证明没有读取完整 mdat。
- 用 Media Foundation 验证非零时长、CAN_SEEK 和有效 seek；用真实播放器复核。
- 对比处理耗时与内存，不能以“避免 wasm”为由引入新的整文件扫描或转码级退化。
