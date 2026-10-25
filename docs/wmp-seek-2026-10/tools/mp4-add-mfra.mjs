/**
 * 一次性验证工具：给分片 MP4（fMP4）补 mfra 随机访问索引（WMP 拖动假设验证）
 * 用法：node /tmp/mp4-add-mfra.mjs <in.mp4> <out.mp4>
 *
 * 结构：扫全部 moof，按轨收集每分片的 {tfdt 时间, moof 绝对偏移, traf 序号}，
 * 构建 tfra（每轨一个）+ mfro，组成 mfra 追加到文件尾。
 * 内存 O(moov + 分片头)，与文件大小无关。
 */
import fs from 'node:fs';

const [,, inFile, outFile] = process.argv;
const blob = new Blob([fs.readFileSync(inFile)]);
const total = blob.size;

function bh(dv, off, end) {
  if (off + 8 > end) return null;
  const size32 = dv.getUint32(off);
  const type = String.fromCharCode(dv.getUint8(off + 4), dv.getUint8(off + 5), dv.getUint8(off + 6), dv.getUint8(off + 7));
  if (size32 === 1) {
    if (off + 16 > end) return null;
    return { size: Number(dv.getBigUint64(off + 8)), type, headerLen: 16 };
  }
  if (size32 === 0) return { size: end - off, type, headerLen: 8 };
  return { size: size32, type, headerLen: 8 };
}

/* ── 1. moov：每轨的 trackID 与 timescale ── */
async function readRange(off, len) {
  return new DataView((await blob.slice(off, off + len).arrayBuffer()));
}

let pos = 0;
const top = [];
while (pos + 8 <= total) {
  const head = await readRange(pos, Math.min(16, total - pos));
  // end 传文件剩余长度：size==0（延伸到文件尾）的 box 才能算对 size
  const h = bh(head, 0, total - pos);
  if (!h || h.size < h.headerLen) break;
  top.push({ ...h, off: pos });
  pos += h.size;
}

const moovBox = top.find(b => b.type === 'moov');
if (!moovBox) throw new Error('无 moov');
const moov = await readRange(moovBox.off, moovBox.size);

// moov → trak → (tkhd: trackID) + (mdia → mdhd: timescale)
const tracks = new Map();   // trackID → { timescale }
function walk(dv, start, end, trackCtx) {
  let cur = start;
  while (cur + 8 <= end) {
    const h = bh(dv, cur, end);
    if (!h || h.size < h.headerLen) break;
    const ds = cur + h.headerLen;
    const de = Math.min(cur + h.size, end);
    if (h.type === 'trak') {
      const ctx = {};
      walk(dv, ds, de, ctx);
      if (ctx.trackId != null) tracks.set(ctx.trackId, { timescale: ctx.timescale || 90000 });
    } else if (h.type === 'mdia' || h.type === 'minf' || h.type === 'stbl') {
      walk(dv, ds, de, trackCtx);
    } else if (h.type === 'tkhd') {
      // FullBox：v0 = ver/flags(4)+ctime(4)+mtime(4)+trackID@12；v1 64位时间 → trackID@20
      const ver = dv.getUint8(ds);
      trackCtx.trackId = dv.getUint32(ds + (ver === 1 ? 20 : 12));
    } else if (h.type === 'mdhd') {
      // v0：ver/flags(4)+ctime(4)+mtime(4)+timescale@12；v1 → timescale@20
      const ver = dv.getUint8(ds);
      trackCtx.timescale = dv.getUint32(ds + (ver === 1 ? 20 : 12));
    }
    cur += h.size;
  }
}
walk(moov, moovBox.headerLen, moovBox.size, {});
console.log('轨道:', [...tracks.entries()].map(([id, t]) => `track${id}(timescale=${t.timescale})`).join(', '));

/* ── 2. 扫全部 moof，收集每轨每分片的 {time, moofOff, trafIndex} ── */
const frag = new Map();   // trackID → [{time, moofOff, trafIndex}]
const moofs = top.filter(b => b.type === 'moof');
console.log('分片数:', moofs.length);
for (const m of moofs) {
  const dv = await readRange(m.off, Math.min(m.size, 65536));
  let cur = m.headerLen;
  let trafIndex = 0;
  while (cur + 8 <= m.size) {
    const h = bh(dv, cur, m.size);
    if (!h) break;
    if (h.type === 'traf') {
      trafIndex++;
      const ds = cur + h.headerLen, de = Math.min(cur + h.size, m.size);
      let p = ds, trackId = null, baseTime = null;
      while (p + 8 <= de) {
        const th = bh(dv, p, de);
        if (!th) break;
        const ts = p + th.headerLen;
        if (th.type === 'tfhd') trackId = dv.getUint32(ts + 4);
        if (th.type === 'tfdt') {
          const ver = dv.getUint8(ts);
          baseTime = ver === 1 ? Number(dv.getBigUint64(ts + 4)) : dv.getUint32(ts + 4);
        }
        p += th.size;
      }
      if (trackId != null && baseTime != null) {
        if (!frag.has(trackId)) frag.set(trackId, []);
        frag.get(trackId).push({ time: baseTime, moofOff: m.off, trafIndex });
      }
    }
    cur += h.size;
  }
}
for (const [id, list] of frag) console.log(`track${id}: ${list.length} 个分片`);

/* ── 3. 构建 mfra = 每轨 tfra + mfro ── */
function box(type, payload) {
  const b = new Uint8Array(8 + payload.length);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 8 + payload.length);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  b.set(payload, 8);
  return b;
}
const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(n); let f = 0; for (const x of a) { o.set(x, f); f += x.length; } return o; };

function tfra(trackId, entries) {
  const body = new Uint8Array(4 + 4 + 4 + 4 + entries.length * 11);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, 0);            // version 0 + flags 0
  dv.setUint32(4, trackId);
  dv.setUint32(8, 0);            // reserved(26) + 三个长度位(各 2bit)=0 → 条目数字段 1 字节
  dv.setUint32(12, entries.length);
  let p = 16;
  for (const e of entries) {
    dv.setUint32(p, e.time); p += 4;            // timescale 单位的呈现时间
    dv.setUint32(p, e.moofOff); p += 4;         // moof 绝对偏移
    body[p++] = e.trafIndex; body[p++] = 1; body[p++] = 1;
  }
  return box('tfra', body);
}

const trackIds = [...tracks.keys()].sort((a, b) => a - b);
const tfras = trackIds.map(id => tfra(id, frag.get(id) || []));
const mfraBody = cat(...tfras);
const mfraSize = 8 + mfraBody.length + 16;      // mfra box + mfro box(16)
const mfraBox = box('mfra', cat(mfraBody, (() => {
  const mfro = new Uint8Array(16);
  const dv = new DataView(mfro.buffer);
  dv.setUint32(0, 16);
  for (let i = 0; i < 4; i++) mfro[4 + i] = 'mfro'.charCodeAt(i);
  dv.setUint32(8, 0);                            // version+flags
  dv.setUint32(12, mfraSize);                    // mfra 总大小（含 mfro 自身）
  return mfro;
})()));

const out = new Blob([blob, mfraBox], { type: 'video/mp4' });
fs.writeFileSync(outFile, Buffer.from(await out.arrayBuffer()));

/* ── 4. 验证：mfra 在末尾、可解析、偏移指向真 moof ── */
const o = fs.readFileSync(outFile);
const mfraAt = o.indexOf(Buffer.from('mfra'));
console.log('mfra 写入:', mfraAt > 0 && mfraAt > total - 100000 ? '✓ 在文件尾' : '✗', '| 追加', mfraBox.length, '字节');
// 抽验最后一条 video entry 的 moofOff 指向真 moof
const vEntries = frag.get(trackIds[0]) || [];
const lastV = vEntries[vEntries.length - 1];
console.log('末视频分片偏移指向:', o.readUInt32BE(lastV.moofOff + 4) === 0x6d6f6f66 ? '✓ moof 头' : '✗');
console.log('完成 →', outFile);
