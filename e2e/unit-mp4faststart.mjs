/**
 * e2e/unit-mp4faststart.mjs — mp4-faststart.js 的 Node 单元测试
 *
 * 手工构造最小 MP4 结构（ftyp + mdat + moov(stco/co64)），验证：
 *   1. stco：moov 搬到头部、chunk 偏移 +moovSize、负载字节完好
 *   2. co64：同上（64 位路径）
 *   3. 已是 faststart：原样返回
 *   4. stco 32 位溢出：抛错（调用方回退）
 *   5. 无 stco/co64：抛错
 *
 * 运行：node e2e/unit-mp4faststart.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.self = globalThis;   // mp4-faststart.js 是经典脚本（IIFE on self）
await import(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../mp4-faststart.js'));
const { mp4FaststartJs } = globalThis;

let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`${cond ? '  ✅' : '  ❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed++;
}

/* ── 最小 MP4 构造器 ─────────────────────────────────── */

function box(type, payload) {
  const b = new Uint8Array(8 + payload.length);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 8 + payload.length);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  b.set(payload, 8);
  return b;
}
const cat = (...arrs) => {
  const n = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
const str = s => [...s].map(c => c.charCodeAt(0));

/** stco/co64 表：FullBox(version+flags) + count + entries */
function stcoBox(entries, is64) {
  const p = new Uint8Array(8 + entries.length * (is64 ? 8 : 4));
  const dv = new DataView(p.buffer);
  dv.setUint32(4, entries.length);
  entries.forEach((v, i) => {
    if (is64) { dv.setUint32(8 + i * 8, Math.floor(v / 4294967296)); dv.setUint32(12 + i * 8, v >>> 0); }
    else dv.setUint32(8 + i * 4, v);
  });
  return box(is64 ? 'co64' : 'stco', p);
}

/**
 * 造一个 [ftyp][mdat(payload)][moov(stbl 里挂 st/co 表)] 文件。
 * stcoOffsets 为 null 时用指向 mdat 负载的真实偏移。
 */
function makeMp4({ is64 = false, moovFirst = false, payloadSize = 100, entries = null } = {}) {
  const ftyp = box('ftyp', new Uint8Array([...str('isom'), 0, 0, 0, 0, ...str('isom')]));
  const payload = new Uint8Array(payloadSize).map((_, i) => i % 251);
  const mdat = box('mdat', payload);

  // mdat 负载在最终文件里的绝对偏移（moov 在 mdat 前的布局下）
  const payloadOff = ftyp.length + 8;
  const offs = entries ?? [payloadOff, payloadOff + 50];
  const stbl = box('stbl', stcoBox(offs, is64));
  const minf = box('minf', stbl);
  const mdia = box('mdia', minf);
  const trak = box('trak', mdia);
  const moov = box('moov', trak);

  const bytes = moovFirst ? cat(ftyp, moov, mdat) : cat(ftyp, mdat, moov);
  return { bytes, payload, payloadOff, offs };
}

/* ── 辅助解析（验证用）───────────────────────────────── */

function topBoxes(buf) {
  const dv = new DataView(buf);
  const out = [];
  let pos = 0;
  while (pos + 8 <= buf.byteLength) {
    const size = dv.getUint32(pos);
    out.push({ type: String.fromCharCode(dv.getUint8(pos+4), dv.getUint8(pos+5), dv.getUint8(pos+6), dv.getUint8(pos+7)), off: pos, size });
    pos += size;
  }
  return out;
}
function readStco(buf, moovOff, is64) {
  // 简化：直接在 moov 范围里找 stco/co64（测试构造里没有干扰字节）
  const dv = new DataView(buf);
  const tag = is64 ? 'co64' : 'stco';
  for (let i = moovOff; i < buf.byteLength - 8; i++) {
    if (typeAt(dv, i) === tag) {
      const dataStart = i + 4;   // i 指向 type 前 4 字节的 size... 见下
      const boxStart = i - 4;
      const count = dv.getUint32(boxStart + 8 + 4);
      const entries = [];
      for (let j = 0; j < count; j++) {
        entries.push(is64
          ? dv.getUint32(boxStart + 8 + 8 + j * 8) * 4294967296 + dv.getUint32(boxStart + 8 + 12 + j * 8)
          : dv.getUint32(boxStart + 8 + 8 + j * 4));
      }
      return entries;
    }
  }
  function typeAt(dv, o) { return String.fromCharCode(dv.getUint8(o), dv.getUint8(o+1), dv.getUint8(o+2), dv.getUint8(o+3)); }
  return null;
}

/* ── 用例 ────────────────────────────────────────────── */

console.log('mp4-faststart 单元测试');

// 1. stco 常规搬迁
{
  const { bytes, payload, offs } = makeMp4({ is64: false });
  const out = await mp4FaststartJs(new Blob([bytes]));
  const buf = await out.arrayBuffer();
  const boxes = topBoxes(buf);
  ok('stco: box 顺序 ftyp→moov→mdat',
     boxes.map(b => b.type).join(',') === 'ftyp,moov,mdat', boxes.map(b => b.type).join(','));
  const moovSize = bytes.length - (boxes[0].size) - (boxes[2]?.size ?? 0);  // 原 moov 大小
  const origMoov = topBoxes(bytes.buffer)[2];
  const entries = readStco(buf, boxes[1].off, false);
  ok('stco: 偏移全部 +moovSize',
     JSON.stringify(entries) === JSON.stringify(offs.map(v => v + origMoov.size)),
     `${entries} vs ${offs.map(v => v + origMoov.size)}`);
  ok('stco: 总大小不变', buf.byteLength === bytes.length);
  // 负载完好：新偏移处读到的字节 == 原负载对应字节
  const dv = new DataView(buf);
  ok('stco: 负载内容完好',
     offs.every((v, i) => dv.getUint8(entries[i]) === payload[v - offs[0]]),
     '');
}

// 2. co64
{
  const { bytes, offs } = makeMp4({ is64: true });
  const out = await mp4FaststartJs(new Blob([bytes]));
  const buf = await out.arrayBuffer();
  const boxes = topBoxes(buf);
  const origMoov = topBoxes(bytes.buffer)[2];
  const entries = readStco(buf, boxes[1].off, true);
  ok('co64: box 顺序正确且偏移 +moovSize',
     boxes[1].type === 'moov' && JSON.stringify(entries) === JSON.stringify(offs.map(v => v + origMoov.size)),
     `${entries}`);
}

// 3. 已是 faststart → 原样返回
{
  const { bytes } = makeMp4({ moovFirst: true });
  const inBlob = new Blob([bytes]);
  const out = await mp4FaststartJs(inBlob);
  ok('已 faststart: 原样返回', out === inBlob);
}

// 4. stco 32 位溢出 → 抛错
{
  const { bytes } = makeMp4({ entries: [0xFFFFFFF0] });
  let threw = false;
  try { await mp4FaststartJs(new Blob([bytes])); } catch (e) { threw = /溢出/.test(e.message); }
  ok('stco 溢出: 抛错回退', threw);
}

// 5. moov 里没有 stco/co64 → 抛错
{
  const ftyp = box('ftyp', new Uint8Array(16));
  const mdat = box('mdat', new Uint8Array(50));
  const moov = box('moov', box('trak', box('mdia', new Uint8Array(8))));
  let threw = false;
  try { await mp4FaststartJs(new Blob([cat(ftyp, mdat, moov)])); }
  catch (e) { threw = /未找到 stco/.test(e.message); }
  ok('无 chunk 表: 抛错回退', threw);
}

console.log(failed === 0 ? '单元测试全部通过 🎉' : `${failed} 项失败 ❌`);
process.exit(failed ? 1 : 0);
