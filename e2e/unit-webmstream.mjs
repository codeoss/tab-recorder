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
 *
 * 运行：node e2e/unit-webmstream.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.self = globalThis;   // fix-webm.js 是经典脚本（IIFE on self）
await import(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fix-webm.js'));
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
const CLUSTER     = [0x1F, 0x43, 0xB6, 0x75];
const TIMESCALE   = [0x2A, 0xD7, 0xB1];
const DURATION    = [0x44, 0x89];
const TIMECODE    = [0xE7];
const VOID        = [0xEC];

const hdr = el(EBML_HEADER, new Uint8Array(0));
const tracks = el(TRACKS, new Uint8Array(8).fill(0x11));   // 内容任意，扫描器只跳过

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
    new Uint8Array(payloadLen).fill(payloadByte),
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
  // [cluster 定长][cluster unknown-size（payload 全 0，不会误命中顶层 ID）][cluster 定长]
  const unkPayload = cat(el(TIMECODE, uintBytes(800)), new Uint8Array(64));
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

/* 11. 公开 API 路由：fixWebMBlob 走流式并与直接调用等价 */
{
  const bytes = wrapDefinite([info({}), tracks, cluster(0), cluster(600)]);
  const viaPublic = await fixWebMBlob(new Blob([bytes], { type: 'video/webm' }), 1300);
  const direct = await _fixWebMStream(new Blob([bytes], { type: 'video/webm' }), 1300);
  const a = Buffer.from(await viaPublic.arrayBuffer());
  const b = Buffer.from(await direct.arrayBuffer());
  ok('fixWebMBlob 路由到流式实现', a.equals(b));
}

console.log(failed ? `\n${failed} 项失败 ❌` : '\n全部通过 🎉');
process.exit(failed ? 1 : 0);
