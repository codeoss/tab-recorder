# 原生 MP4 的 4 GiB Chrome 崩溃

**状态：根因已定位；Chromium 上游已修复。扩展侧首选升级 Chrome，旧版本长录制使用 WebM。**

## 现象与复现

2026-11-07，在 Linux / Google Chrome 156.0.8078.79 中保留其他扩展，使用 Tab 录制大师 1.3.0 录制 YouTube TV 的 NBC 11 直播，配置为 1080p、30 fps、16 Mbps、原生 MP4：

- 约 52 分钟时，OPFS 暂存停在 **4,294,540,012 字节**，比 `2³² = 4,294,967,296` 少 427,284 字节。
- NBC 播放仍正常，但 offscreen 录制上下文消失，扩展快捷键不再生效。
- `chrome://crashes` 在同一时间留下崩溃记录；本地 minidump 的异常代码为 **5（SIGTRAP）**。
- 这不是内存不足：当时系统可用内存充足，且此前 WebM 连续录制 5 小时 10 分、16.81 GB 正常。

这说明问题与原生 MP4 的累计输出大小直接相关，而不是单纯由录制时长、其他扩展或 OPFS 导致。

## Chromium 根因

受影响版本的 [`media/muxers/output_position_tracker.cc`](https://raw.githubusercontent.com/chromium/chromium/156.0.8078.79/media/muxers/output_position_tracker.cc) 使用 32 位无符号整数累计全部输出字节：

```cpp
uint32_t current_pos_;
CHECK(base::CheckAdd(current_pos_, data.size()).AssignIfValid(&current_pos_));
```

下一批 MP4 数据使累计值超过 `2³²−1` 时，`CHECK` 主动终止 renderer。最后确认文件比边界小约 417 KiB，正是因为本次待写分片不能完整加入该 32 位计数器。

这发生在 Chrome 原生 MP4 封装阶段，扩展的 JS faststart、OPFS 队列和下载逻辑均无法提前阻止。

## 上游修复

Chromium 提交 [`3f057555923e389ec36f92d4658cd3593c0012f4`](https://github.com/chromium/chromium/commit/3f057555923e389ec36f92d4658cd3593c0012f4) 已删除 `OutputPositionTracker`，改为把 MP4 box 数据直接交给写入回调。提交说明确认：

- 超过 4 GiB 会导致 renderer 崩溃；
- WebM 不受影响；
- 该累计位置没有被读取，`trun` 使用相对 `moof` 的偏移，`tfra` 的 `moof_offset` 由 delegate 以 64 位写入；
- 修复前后的 MP4 字节内容不变。

已逐版本读取源码核对：

| Chrome 版本 | 是否含修复 |
|---|---|
| 156.0.8078.79 | 否 |
| 157.0.8079.0 | 否 |
| 158.0.8118.0 | 否 |
| [158.0.8127.18](https://raw.githubusercontent.com/chromium/chromium/158.0.8127.18/media/muxers/mp4_muxer_context.cc) | **是** |
| 159.0.8148.1 | **是** |

**不能只看大版本号；158.0.8118.0 仍含旧实现。升级时应确认构建包含提交 `3f057555`。**

## 扩展侧处理建议

1. **首选：升级 Chrome** 到包含上游修复的构建，然后重新完成超过 4 GiB 的原生 MP4 实测。
2. 旧版本需要长录制时使用 **WebM**，不要依赖 `mp4FaststartJs` 规避；它只在录制结束后处理，无法避免录制中的 SIGTRAP。
3. 必须继续使用旧版 Chrome 和 MP4 时，可增加约 3.5 GiB 的安全停止阈值，明确提示用户升级并先保存当前段。这只是防崩措施，不能让旧版本支持超过 4 GiB。
4. 自动分段虽能绕过边界，但会改变单文件产物，并引入音画间隙及合并成本，不作为默认修复。
5. 旧版 Chrome 也可先录 WebM 再转码，但长视频重编码成本高，不应默认为用户静默执行。

## 崩溃恢复与产物验证

Reload 后，扩展识别出约 4095.6 MiB 的未完成录制，并从 OPFS 成功恢复下载。恢复文件：

- 大小 **4,294,540,012 字节**，时长 **3134.501367 秒**；
- VP9 视频 + Opus 音频；
- `moov` 位于首个 `mdat` 前，faststart 有效；
- 1291 对 `moof/mdat` 均完整，最后一个 `mdat` 正好结束于文件尾；
- 前 / 中 / 后段定位解码退出码均为 0；FFmpeg 仍报告已知的非单调 DTS 警告，与本次崩溃是不同现象。

因此 OPFS 恢复链在该边界下有效，但“恢复成功”不等于“可以继续录制超过 4 GiB”。

## 后续验收

- 使用含修复提交的 Chrome，重复本地 NBC / 16 Mbps / 原生 MP4 测试，目标至少 5 GiB，再验证 faststart、时长及前 / 中 / 后段解码。
- Windows、RDP 和其他编码组合仍需各自环境验证，不能由本次 Linux / VP9-in-MP4 结果直接外推。
- 保留 WebM 的长录制回归，防止把 Chrome 原生 MP4 的问题误归因于 OPFS。
