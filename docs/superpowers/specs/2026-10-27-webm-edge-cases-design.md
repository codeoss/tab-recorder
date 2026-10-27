# WebM 特殊输入边界修复设计

## 目标与背景

PR #22 的收尾审查确认两个未覆盖边界：负合成时间码的首个关键帧会阻止同 Cluster 后续有效关键帧被索引；缺少 `TimecodeScale` 的 Info 会让 legacy 与 streaming 采取不同编辑策略。

本次按用户要求，先补两个回归用例并观察失败，再最小修复。正常 Chrome 录制的行为、媒体负载、保存链和 MP4 处理不变，不新增 ffmpeg.wasm。

## 方案比较

1. **采用：首个有效关键帧 + 不可信 Info 保守返回。** 两条关键帧扫描路径只跳过负合成时间码候选，继续寻找后续真实关键帧；legacy 也只在 Info 完整校验通过后记录位置。改动小，保持现有每 Cluster 一个 Cue 和流式内存模型。
2. **不采用：收集所有关键帧后全局筛选。** 可以处理更复杂的时间顺序，但会改变当前每 Cluster 一个 Cue 的模型，增加排序、去重和跨 Cluster 状态，超出这两个已确认边界的需要。

不通过删除非负检查、放宽 Info 校验或只修改测试预期来消除失败。

## 具体设计

- `findClusterKeyframeSync` / `findClusterKeyframe` 只在 `Cluster.Timecode + Block.relative >= 0` 时返回候选；SimpleBlock 与 BlockGroup 一致。外层的非负和跨 Cluster 单调检查保留。
- legacy 将 `infoOff = cur` 移到 `clean && sawScale && ic === infoEnd` 分支中，与 streaming 一样在不可信 Info 上返回原文件。
- 测试校验器 `clusterKeyframe` 接收期望 CueTime，必须找到轨号、关键帧语义和绝对时间均匹配的 Block，不能只因 Cluster 中较早的负时间关键帧而误判。
- `AGENTS.md` 同步说明负候选继续扫描和不可信 Info 原样返回。

## 验收

- 新用例先于产品修改，在当前代码上失败。
- 负 SimpleBlock → 有效 BlockGroup、负 BlockGroup → 有效 SimpleBlock 都能得到正确 CueTime `[40,160]`，legacy 与 streaming 逐字节一致，媒体 Cluster 不变。
- Info 含 Duration 但缺 `TimecodeScale` 时，两条路径均逐字节返回输入。
- 既有测试与完整浏览器场景 A–E 通过。

## 非目标与保留验证

不处理所有 EBML 畸形组合、复杂全局时间重排或 moov-at-end fMP4，不重写解析器。RDP 系统音频、原生 WMP GUI 拖动和真实 GB 文件内存/性能仍按既有清单单独验证，不由本次单元测试推断。
