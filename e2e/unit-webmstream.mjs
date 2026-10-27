/**
 * e2e/unit-webmstream.mjs — fix-webm 流式实现 vs 全量实现（golden）对照
 *
 * 契约：同一输入下，fixWebMStream（生产路径）与 fixWebM（legacy 全量，
 * e2e 真实录制已验证多年的行为）的输出必须**逐字节一致**。
 *
 * 覆盖形态（每形态 × 多种窗口宽度，小窗口强制跨越窗口边界）：
 *   1. 定长 Segment + 已有 Duration(float64)      → 原位改写路径
 *   2. 定长 Segment + 无 Duration                 → 插入路径（同宽 VINT）
 *   3. 定长 Segment + 无 Duration + 大 Void 填充  → 插入 + Info VINT 加宽
 *   4. unknown Segment + 无 Duration              → 插入且不动 Segment size
 *   5. unknown Segment + Duration(float32)        → 原位改写（float32）
 *   6. 中间夹 unknown-size Cluster                → 逐字节前扫路径
 *   7. TimecodeScale=500000                       → durVal 换算
 *   8. 无 Cluster / 坏魔数                        → 原样返回
 *   9. 大量 Cluster（200 个）+ 极小窗口            → 高频跨窗口
 *  10. 单 Cluster 大负载（200KB）+ 64KB 窗口      → 大元素按 size 跳过
 *  13. 视频轨号非 1 / 音频优先 / P 帧 / BlockGroup → 只索引真实关键帧
 *  14. 无可验证关键帧                              → 原样返回
 *  15. unknown-size Cluster + 大音频负载           → 跳负载且只读头部
 *  16. 尾部 unknown-size Cluster + 追加 Cues       → 元数据不算媒体负载
 *  补充：异常时间顺序、截断块与不可信 Info       → 不猜测、不修改媒体
 *
 * 运行：node e2e/unit-webmstream.mjs
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkWebMSeekStructure, checkWebMKeyframeCues, webMClustersEqual } from './lib-webmcheck.mjs';

globalThis.self = globalThis;   // fix-webm.js 是经典脚本（IIFE on self）
await import(pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fix-webm.js')).href);
const { fixWebMBlob, _fixWebMFullBuffer, _fixWebMStream } = globalThis;

let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`${cond ? '  ✅' : '  ❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed++;
  return cond;
}

/* ── EBML 构造器（与生产 encodeVintSize 阈值一致的最小编码） ── */

function vintSize(v) {
  let len;
  if      (v < 0x7F)       len = 1;
  else if (v < 0x3FFF)     len = 2;
  else if (v < 0x1FFFFF)   len = 3;
  else if (v < 0x0FFFFFFF) len = 4;
  else                     len = 5;
  const b = new Uint8Array(len);
  let x = v;
  for (let i = len - 1; i >= 1; i--) { b[i] = x & 0xFF; x = Math.floor(x / 256); }
  b[0] = x | (1 << (8 - len));
  return b;
}

function el(idBytes, payload) {
  const sz = vintSize(payload.length);
  const out = new Uint8Array(idBytes.length + sz.length + payload.length);
  out.set(idBytes, 0);
  out.set(sz, idBytes.length);
  out.set(payload, idBytes.length + sz.length);
  return out;
}

/** unknown-size 元素（8 字节 VINT 全 1）——payload 需紧跟其后原样拼入 */
function elUnknown(idBytes) {
  return new Uint8Array([...idBytes, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
}

function uintBytes(v) {
  const bytes = [];
  let x = v;
  while (x > 0) { bytes.unshift(x & 0xFF); x = Math.floor(x / 256); }
  return new Uint8Array(bytes.length ? bytes : [0]);
}

const EBML_HEADER = [0x1A, 0x45, 0xDF, 0xA3];
const SEGMENT     = [0x18, 0x53, 0x80, 0x67];
const INFO        = [0x15, 0x49, 0xA9, 0x66];
const TRACKS      = [0x16, 0x54, 0xAE, 0x6B];
const TRACK_ENTRY = [0xAE];
const TRACK_NUMBER = [0xD7];
const TRACK_TYPE  = [0x83];
const CLUSTER     = [0x1F, 0x43, 0xB6, 0x75];
const TIMESCALE   = [0x2A, 0xD7, 0xB1];
const DURATION    = [0x44, 0x89];
const TIMECODE    = [0xE7];
const SIMPLE_BLOCK = [0xA3];
const BLOCK_GROUP = [0xA0];
const BLOCK       = [0xA1];
const VOID        = [0xEC];

function makeTracks(...entries) {
  return el(TRACKS, cat(...entries.map(({ number, type }) => el(TRACK_ENTRY, cat(
    el(TRACK_NUMBER, uintBytes(number)), el(TRACK_TYPE, new Uint8Array([type])),
  )))));
}

function mediaBlock(idBytes, { track = 1, relative = 0, keyframe = false, payload = new Uint8Array(0) } = {}) {
  const trackId = vintSize(track);
  const head = new Uint8Array(trackId.length + 3);
  head.set(trackId);
  new DataView(head.buffer).setInt16(trackId.length, relative);
  head[head.length - 1] = keyframe ? 0x80 : 0;
  return el(idBytes, cat(head, payload));
}

function simpleBlock(options) { return mediaBlock(SIMPLE_BLOCK, options); }
function blockGroup(options) { return el(BLOCK_GROUP, mediaBlock(BLOCK, options)); }

const hdr = el(EBML_HEADER, new Uint8Array(0));
const tracks = makeTracks({ number: 1, type: 1 }, { number: 2, type: 2 });

function info({ tcs = 1000000, durF64 = null, durF32 = null, voidPad = 0 } = {}) {
  const children = [el(TIMESCALE, uintBytes(tcs))];
  if (durF64 !== null) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, durF64);
    children.push(el(DURATION, b));
  }
  if (durF32 !== null) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, durF32);
    children.push(el(DURATION, b));
  }
  if (voidPad > 0) children.push(el(VOID, new Uint8Array(voidPad)));
  return el(INFO, cat(...children));
}

/** 拼多个 Uint8Array */
function cat(...arrs) {
  const n = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

function cluster(timecodeMs, payloadLen = 20, payloadByte = 0xAB) {
  return el(CLUSTER, cat(
    el(TIMECODE, uintBytes(timecodeMs)),
    simpleBlock({ keyframe: true, payload: new Uint8Array(payloadLen).fill(payloadByte) }),
  ));
}

/** 定长 Segment：children 先拼好，size 按实际长度编码 */
function wrapDefinite(children) {
  const data = cat(...children);
  return cat(hdr, el(SEGMENT, data));
}

/** unknown-size Segment */
function wrapUnknown(children) {
  return cat(hdr, elUnknown(SEGMENT), ...children);
}

/* ── golden 对照 ─────────────────────────────────────── */

async function golden(name, bytes, durationMs) {
  const legacyOut = _fixWebMFullBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), durationMs);
  const legacy = Buffer.from(new Uint8Array(legacyOut));
  const firstDiff = (a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return i;
    return a.length === b.length ? -1 : Math.min(a.length, b.length);
  };
  for (const w of [8, 16, 64, 1 << 18]) {
    const out = await _fixWebMStream(new Blob([bytes], { type: 'video/webm' }), durationMs, w);
    const streamed = Buffer.from(await out.arrayBuffer());
    const eq = streamed.equals(legacy);
    ok(`golden 逐字节一致 [WIN=${w}]`, eq,
      eq ? '' : `首个差异 @${firstDiff(streamed, legacy)}（len ${streamed.length} vs ${legacy.length}）`);
    if (!eq) break;   // 已失败，无需再试更大窗口
  }
  if (Buffer.from(bytes).includes(Buffer.from([0x1F, 0x43, 0xB6, 0x75]))) {
    const report = checkWebMSeekStructure(legacy);
    ok(`${name}：SeekHead/Cue 定位`, report.errors.length === 0, report.errors.join('；'));
    ok(`${name}：真实 Info 位置不被 SeekID 干扰`,
      report.info && report.info.off !== legacy.indexOf(Buffer.from(INFO)) &&
      legacy.subarray(report.info.off, report.info.off + 4).equals(Buffer.from(INFO)));
    ok(`${name}：Cluster 负载不变`, webMClustersEqual(Buffer.from(bytes), legacy));
    const keyframes = checkWebMKeyframeCues(legacy);
    ok(`${name}：Cue 均为视频关键帧`, keyframes.errors.length === 0, keyframes.errors.join('；'));
  }
  return legacy;
}

console.log('fix-webm 流式 golden 对照');

/* 1. 定长 Segment + Duration float64 → 原位改写 */
{
  const bytes = wrapDefinite([
    info({ tcs: 1000000, durF64: 0 }),
    tracks,
    cluster(0), cluster(1000), cluster(2500),
  ]);
  const legacy = await golden('定长Seg+Duration64 → 改写', bytes, 3300);
  ok('  · 产物含 Cues', Buffer.from(legacy).toString('hex').includes('1c53bb6b'));
  ok('  · 产物含 Duration', Buffer.from(legacy).toString('hex').includes('4489'));
}

/* 2. 定长 Segment + 无 Duration → 插入（同宽 VINT） */
await golden('定长Seg+无Duration → 插入',
  wrapDefinite([info({}), tracks, cluster(0), cluster(700)]), 1500);

/* 3. Info 填 Void 到 120 字节数据（1 字节 VINT）→ 插入后 131 > 126，VINT 加宽 */
{
  // TimecodeScale 元素 7 字节 + Void(2+111)=113 → Info data 120 字节
  const bytes = wrapDefinite([info({ voidPad: 111 }), tracks, cluster(0)]);
  const legacy = await golden('Info VINT 加宽', bytes, 900);
  ok('  · 产物含 Duration（插入成功）', Buffer.from(legacy).toString('hex').includes('4489'));
}

/* 4. unknown Segment + 无 Duration → 插入，且不动 Segment size */
await golden('unknownSeg+无Duration → 插入',
  wrapUnknown([info({}), tracks, cluster(0), cluster(500)]), 1200);

/* 5. unknown Segment + Duration float32 → 原位改写 */
await golden('unknownSeg+Duration32 → 改写',
  wrapUnknown([info({ durF32: 0 }), tracks, cluster(0), cluster(900)]), 1800);

/* 6. 中间夹 unknown-size Cluster → 逐字节前扫 */
{
  // [cluster 定长][cluster unknown-size（含关键帧）][cluster 定长]
  const unkPayload = cat(
    el(TIMECODE, uintBytes(800)),
    simpleBlock({ keyframe: true, payload: new Uint8Array(64) }),
  );
  const bytes = wrapDefinite([
    info({}),
    tracks,
    cluster(0),
    cat(elUnknown(CLUSTER), unkPayload),
    cluster(1600),
  ]);
  await golden('unknown-size Cluster 前扫', bytes, 2000);
}

/* 7. TimecodeScale=500000 → durVal 换算 */
await golden('TimecodeScale=500000',
  wrapDefinite([info({ tcs: 500000, durF64: 0 }), tracks, cluster(0), cluster(400)]), 1000);

/* 8a. 无 Cluster → 原样返回（两侧输出 == 输入） */
{
  const bytes = wrapDefinite([info({ durF64: 0 }), tracks]);
  const legacy = await golden('无 Cluster → 原样', bytes, 500);
  ok('  · 输出 == 输入', legacy.equals(Buffer.from(bytes)));
}

/* 8b. 坏魔数 → 原样返回 */
{
  const bytes = new Uint8Array(64).fill(0x00);
  bytes.set([0xDE, 0xAD], 0);
  const legacy = await golden('坏魔数 → 原样', bytes, 500);
  ok('  · 输出 == 输入', legacy.equals(Buffer.from(bytes)));
}

/* 9. 200 个 Cluster + 极小窗口 → 高频跨窗口 */
{
  const clusters = [];
  for (let i = 0; i < 200; i++) clusters.push(cluster(i * 1000, 12, i % 251));
  await golden('200 Clusters', wrapDefinite([info({}), tracks, ...clusters]), 200000);
}

/* 10. 单 Cluster 大负载（200KB）+ 64KB 窗口 → 大元素按 size 跳过，不读内部 */
await golden('200KB 负载 Cluster',
  wrapDefinite([info({}), tracks, cluster(0, 200 * 1024)]), 4000);

/* 10b. unknown Segment + Duration 插入 + Info 加宽 + SeekHead 同时发生 */
{
  const bytes = wrapUnknown([info({ voidPad: 111 }), tracks, cluster(0), cluster(600)]);
  const legacy = await golden('组合：unknown Segment+Info加宽+插入Duration', bytes, 1200);
  const report = checkWebMSeekStructure(legacy);
  ok('  · 组合位移后 Seek/Cue 仍准确且 Info 已加宽',
    report.segmentUnknown && report.errors.length === 0 &&
    report.info.dataOff - report.info.off === 6 &&
    legacy.subarray(report.info.dataOff, report.info.end).includes(Buffer.from([0x44, 0x89, 0x88])),
    report.errors.join('；'));
}

/* 10c. 记录实际物化的读取范围：滑窗有界，不能因修复再整文件扫描一遍 */
{
  const bytes = wrapDefinite([info({}), tracks, cluster(0, 200 * 1024), cluster(1000)]);
  const source = new Blob([bytes]);
  const reads = [];
  const readAll = source.arrayBuffer.bind(source);
  source.arrayBuffer = async () => { reads.push([0, source.size]); return readAll(); };
  const slice = source.slice.bind(source);
  source.slice = (start = 0, end = source.size) => {
    const part = slice(start, end);
    const readPart = part.arrayBuffer.bind(part);
    part.arrayBuffer = async () => { reads.push([start, end]); return readPart(); };
    return part;
  };
  await _fixWebMStream(source, 4000, 65536);
  ok('WebM 单次读取不超过滑窗', reads.every(([start, end]) => end - start <= 65536),
    JSON.stringify(reads));
  ok('WebM 不新增第二次全文件扫描', reads.reduce((sum, [start, end]) => sum + end - start, 0) <=
    bytes.length + 2 * 65536, JSON.stringify(reads));
}

/* 11. 公开 API 路由：fixWebMBlob 走流式并与直接调用等价 */
{
  const bytes = wrapDefinite([info({}), tracks, cluster(0), cluster(600)]);
  const viaPublic = await fixWebMBlob(new Blob([bytes], { type: 'video/webm' }), 1300);
  const direct = await _fixWebMStream(new Blob([bytes], { type: 'video/webm' }), 1300);
  const a = Buffer.from(await viaPublic.arrayBuffer());
  const b = Buffer.from(await direct.arrayBuffer());
  ok('fixWebMBlob 路由到流式实现', a.equals(b));
}

/* 12. 幻影防护回归（对应真实踩坑：632MB 文件的负载里埋了 1549A966 幻影，
   旧扫描器出轨 → Duration 插进媒体数据、Cues 偏移错位、覆盖截断）：
   负载里埋幻影 Info + 假 Cluster 头（首子非 E7），扫描不得出轨 */
{
  const phantomInfo = new Uint8Array([0x15, 0x49, 0xA9, 0x66, 0x3D, 0x4F, 0xCB, 0xDE, 0xAD]);
  const fakeCluster = cat(
    new Uint8Array([0x1F, 0x43, 0xB6, 0x75, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]),
    new Uint8Array([0x99, 0x99]),   // 首子不是 Timecode(E7) → 假 Cluster
  );
  const payload = cat(new Uint8Array(64), phantomInfo, new Uint8Array(64), fakeCluster, new Uint8Array(64));
  const bytes = wrapUnknown([
    info({}), tracks,
    cat(elUnknown(CLUSTER), cat(el(TIMECODE, uintBytes(0)), payload)),
    cluster(1000), cluster(2000),
  ]);
  const legacy = await golden('幻影防护（Info/假Cluster）', bytes, 2500);
  const hex = Buffer.from(legacy).toString('hex');
  ok('  · Duration 插在真实 Info（文件头 128 字节内）', hex.slice(0, 256).includes('4489'));
  ok('  · 末簇时间码 2000ms 被收录（扫描未出轨）', hex.includes('b38207d0'));
}

/* 13. 视频轨号非 1、音频优先、P 帧与两种关键帧 Block */
{
  const videoTracks = makeTracks({ number: 1, type: 2 }, { number: 2, type: 1 });
  const bytes = wrapUnknown([
    info({}), videoTracks,
    el(CLUSTER, cat(
      el(TIMECODE, uintBytes(0)),
      simpleBlock({ track: 1, keyframe: true }),
      simpleBlock({ track: 2, relative: 0 }),
    )),
    el(CLUSTER, cat(el(TIMECODE, uintBytes(1000)), simpleBlock({ track: 2, relative: 10 }))),
    el(CLUSTER, cat(
      el(TIMECODE, uintBytes(2000)),
      simpleBlock({ track: 1, relative: 0, keyframe: true }),
      simpleBlock({ track: 2, relative: 20, keyframe: true }),
    )),
    el(CLUSTER, cat(
      el(TIMECODE, uintBytes(3000)),
      blockGroup({ track: 2, relative: 30 }),
    )),
    el(CLUSTER, cat(el(TIMECODE, uintBytes(4000)), simpleBlock({ track: 2, relative: 40 }))),
  ]);
  const fixed = await golden('关键帧索引（音频优先/视频轨2）', bytes, 4500);
  const report = checkWebMKeyframeCues(fixed);
  ok('  · 只保留关键帧且 CueTime 含 Block 相对时间',
    JSON.stringify(report.cueTimes) === JSON.stringify([2020, 3030]), JSON.stringify(report.cueTimes));
  ok('  · CueTrack 使用真实视频轨 2',
    report.cues.length === 2 && report.cues.every(x => x.track === 2), JSON.stringify(report.cues));
}

/* 14. 没有可验证的视频关键帧时，legacy/streaming 都保留原文件 */
{
  const bytes = wrapDefinite([
    info({}), tracks,
    el(CLUSTER, cat(el(TIMECODE, uintBytes(0)), simpleBlock({ track: 1, relative: 0 }))),
    el(CLUSTER, cat(el(TIMECODE, uintBytes(1000)), new Uint8Array([0x99, 0x99]))),
  ]);
  const raw = _fixWebMFullBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 1500);
  const legacy = Buffer.from(new Uint8Array(raw));
  const streamed = Buffer.from(await (await _fixWebMStream(new Blob([bytes]), 1500, 64)).arrayBuffer());
  ok('无可验证关键帧：legacy 原样返回', legacy.equals(Buffer.from(bytes)));
  ok('无可验证关键帧：streaming 原样返回', streamed.equals(Buffer.from(bytes)));
}

/* 15. unknown-size Cluster 内跳过音频，且大音频负载不整段物化 */
{
  const bytes = wrapUnknown([
    info({}), tracks,
    cat(elUnknown(CLUSTER), cat(
      el(TIMECODE, uintBytes(800)),
      simpleBlock({ track: 2, payload: new Uint8Array(32) }),
      simpleBlock({ track: 1, relative: 20, keyframe: true }),
    )),
    cluster(1600),
  ]);
  const fixed = await golden('unknown-size Cluster 音频优先', bytes, 2200);
  const report = checkWebMKeyframeCues(fixed);
  ok('  · unknown-size Cluster 的关键帧时间正确', report.cueTimes.includes(820), JSON.stringify(report.cueTimes));

  const largeAudio = new Uint8Array(400 * 1024).fill(0x5A);
  const largeBytes = wrapDefinite([
    info({}), tracks,
    el(CLUSTER, cat(
      el(TIMECODE, uintBytes(0)),
      simpleBlock({ track: 2, payload: largeAudio }),
      simpleBlock({ track: 1, relative: 20, keyframe: true }),
    )),
    cluster(4000),
  ]);
  const source = new Blob([largeBytes]);
  const reads = [];
  const slice = source.slice.bind(source);
  source.slice = (start = 0, end = source.size) => {
    const part = slice(start, end);
    const readPart = part.arrayBuffer.bind(part);
    part.arrayBuffer = async () => { reads.push([start, end]); return readPart(); };
    return part;
  };
  await _fixWebMStream(source, 4500, 65536);
  ok('大音频负载：单次读取不超过窗口且不整段读取',
    reads.every(([start, end]) => end - start <= 65536 && end - start < largeBytes.length),
    JSON.stringify(reads));
}

/* 16. 尾部 unknown-size Cluster 后已有 Cues，再追加 Cues 也不能算成媒体 */
{
  const bytes = wrapUnknown([
    info({}), tracks,
    cat(elUnknown(CLUSTER), cat(
      el(TIMECODE, uintBytes(800)), simpleBlock({ track: 1, relative: 20, keyframe: true }),
    )),
  ]);
  const fixed = await golden('尾部 unknown-size Cluster', bytes, 1200);
  const cuesAt = fixed.lastIndexOf(Buffer.from([0x1C, 0x53, 0xBB, 0x6B]));
  const withAppendedCues = Buffer.from(cat(fixed, fixed.subarray(cuesAt)));
  ok('已有 Cues 不计入 unknown-size Cluster 负载',
    webMClustersEqual(fixed, withAppendedCues));
}

async function expectOriginal(name, bytes) {
  const raw = _fixWebMFullBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 1500);
  const legacy = Buffer.from(new Uint8Array(raw));
  const streamed = Buffer.from(await (await _fixWebMStream(new Blob([bytes]), 1500, 64)).arrayBuffer());
  ok(`${name}：legacy 原样返回`, legacy.equals(Buffer.from(bytes)));
  ok(`${name}：streaming 原样返回`, streamed.equals(Buffer.from(bytes)));
}

/* 17. 缺少 Cluster Timestamp 不得用默认 0 猜测 CueTime */
await expectOriginal('缺少 Cluster Timestamp', wrapDefinite([
  info({}), tracks,
  el(CLUSTER, simpleBlock({ track: 1, relative: 20, keyframe: true })),
]));

/* 18. Timestamp 晚到时只能使用其后 Block 的实际时间 */
{
  const bytes = wrapDefinite([
    info({}), tracks,
    el(CLUSTER, cat(
      simpleBlock({ track: 1, relative: 20, keyframe: true }),
      el(TIMECODE, uintBytes(1000)),
      simpleBlock({ track: 1, relative: 30, keyframe: true }),
    )),
  ]);
  const fixed = await golden('晚到的 Cluster Timestamp', bytes, 1500);
  const report = checkWebMKeyframeCues(fixed);
  ok('  · 晚到时间码前的 Block 不参与猜测', JSON.stringify(report.cueTimes) === '[1030]',
    JSON.stringify(report.cueTimes));
}

/* 19. BlockGroup 尾部截断，不能凭前半段猜关键帧 */
await expectOriginal('截断的 ReferenceBlock', wrapDefinite([
  info({}), tracks,
  el(CLUSTER, cat(
    el(TIMECODE, uintBytes(0)),
    el(BLOCK_GROUP, cat(
      mediaBlock(BLOCK, { track: 1, relative: 20, keyframe: true }),
      new Uint8Array([0xFB]),
    )),
  )),
]));

/* 20. unknown-size Cluster 与大音频负载同时出现时，读取仍有界 */
{
  const bytes = wrapUnknown([
    info({}), tracks,
    cat(elUnknown(CLUSTER), cat(
      el(TIMECODE, uintBytes(0)),
      simpleBlock({ track: 2, payload: new Uint8Array(400 * 1024).fill(0x5A) }),
      simpleBlock({ track: 1, relative: 20, keyframe: true }),
    )),
    cluster(4000),
  ]);
  const source = new Blob([bytes]);
  const reads = [];
  const slice = source.slice.bind(source);
  source.slice = (start = 0, end = source.size) => {
    const part = slice(start, end);
    const readPart = part.arrayBuffer.bind(part);
    part.arrayBuffer = async () => { reads.push([start, end]); return readPart(); };
    return part;
  };
  await _fixWebMStream(source, 4500, 65536);
  const total = reads.reduce((sum, [start, end]) => sum + end - start, 0);
  ok('unknown-size Cluster 大音频不整段物化或重复全扫',
    reads.every(([start, end]) => end - start <= 65536 && end - start < bytes.length) &&
    total <= bytes.length + 2 * 65536, JSON.stringify(reads));
}

/* 21. 负时间码的首个候选不得遮住同 Cluster 后续有效关键帧 */
{
  const bytes = wrapDefinite([
    info({}), tracks,
    el(CLUSTER, cat(
      el(TIMECODE, uintBytes(0)),
      simpleBlock({ track: 1, relative: -20, keyframe: true }),
      blockGroup({ track: 1, relative: 40 }),
    )),
    el(CLUSTER, cat(
      el(TIMECODE, uintBytes(100)),
      blockGroup({ track: 1, relative: -120 }),
      simpleBlock({ track: 1, relative: 60, keyframe: true }),
    )),
  ]);
  const fixed = await golden('负时间码首个候选后继续扫描', bytes, 1000);
  const report = checkWebMKeyframeCues(fixed);
  ok('  · 负时间候选不遮住后续有效关键帧',
    JSON.stringify(report.cueTimes) === '[40,160]', JSON.stringify(report.cueTimes));
}

/* 22. Info 缺少 TimecodeScale 时不得猜测 Duration 或接受不同的编辑策略 */
await expectOriginal('Info 缺少 TimecodeScale', wrapDefinite([
  el(INFO, el(DURATION, new Uint8Array(8))), tracks, cluster(0),
]));

console.log(failed ? `\n${failed} 项失败 ❌` : '\n全部通过 🎉');
process.exit(failed ? 1 : 0);
