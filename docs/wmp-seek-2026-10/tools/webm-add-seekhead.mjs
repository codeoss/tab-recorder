/**
 * 一次性验证工具：给 WebM 补 SeekHead（WMP 拖动假设验证）
 * 用法：node /tmp/webm-add-seekhead.mjs <in.webm> <out.webm>
 *
 * SeekHead = Segment 开头的"索引的索引"，告诉播放器 Info/Tracks/Cues 在哪。
 * 插入后其后所有字节后移 → 既有 Cues 的 CueClusterPosition 需等宽 +shift。
 */
import fs from 'node:fs';

const [,, inFile, outFile] = process.argv;
const b = fs.readFileSync(inFile);
const total = b.length;

function rid(o) { const x = b[o]; const len = x&0x80?1:x&0x40?2:x&0x20?3:x&0x10?4:0; if (!len) return null; let id=0; for (let i=0;i<len;i++) id=(id<<8)|b[o+i]; return {id:id>>>0,len}; }
function rsz(o) { const x=b[o]; const len=x&0x80?1:x&0x40?2:x&0x20?3:x&0x10?4:x&8?5:x&4?6:x&2?7:x&1?8:0; if (!len) return null; const mask=[0,0x7F,0x3F,0x1F,0x0F,0x07,0x03,0x01,0][len]; let v=x&mask; for (let i=1;i<len;i++) v=v*256+b[o+i]; return {val:v,len}; }
function vint(v) { let len = v < 0x7F ? 1 : v < 0x3FFF ? 2 : 3; const out = new Uint8Array(len); let x = v; for (let i = len-1; i >= 1; i--) { out[i] = x & 0xFF; x = Math.floor(x/256); } out[0] = x | (1 << (8-len)); return out; }
function el(idBytes, payload) { const s = vint(payload.length); return new Uint8Array([...idBytes, ...s, ...payload]); }
function uint(v) { const bytes = []; let x = v; while (x > 0) { bytes.unshift(x & 0xFF); x = Math.floor(x/256); } return new Uint8Array(bytes.length ? bytes : [0]); }

/* ── 解析头：Segment → Info / Tracks；尾：Cues ── */
let pos = 0;
let h = rid(pos); pos += h.len; const hs = rsz(pos); pos += hs.len + hs.val;   // EBML
h = rid(pos); if (!h || h.id !== 0x18538067) throw new Error('缺 Segment');
pos += h.len; const ss = rsz(pos); pos += ss.len;
const segDataStart = pos;

let infoAt = -1, tracksAt = -1;
let cur = segDataStart;
while (cur < segDataStart + 65536 && cur < total - 4) {   // 只在头部小范围找
  const id = rid(cur); if (!id) break;
  const sz = rsz(cur + id.len); if (!sz) break;
  if (id.id === 0x1549A966) infoAt = cur;
  if (id.id === 0x1654AE6B) { tracksAt = cur; break; }
  if (sz.unknown) break;
  cur = cur + id.len + sz.len + sz.val;
}
if (infoAt < 0 || tracksAt < 0) throw new Error('Info/Tracks 没找到');

// Cues 在文件尾
const cuesAt = b.indexOf(Buffer.from([0x1c, 0x53, 0xbb, 0x6b]), total - 8 * 1048576);
if (cuesAt < 0) throw new Error('缺 Cues');

/* ── 解析既有 Cues 的 CueClusterPosition 值位置（等宽修补用）── */
const posRefs = [];
{
  let p = cuesAt + 4; const cz = rsz(p); p += cz.len; const end = p + cz.val;
  while (p < end) {
    const cp = rid(p); if (!cp || cp.id !== 0xBB) break;
    const cs = rsz(p + cp.len);
    let q = p + cp.len + cs.len; const qEnd = q + cs.val;
    while (q < qEnd) {
      const qid = rid(q); const qz = rsz(q + qid.len); const qd = q + qid.len + qz.len;
      if (qid.id === 0xB7) {
        let r = qd; const rEnd = qd + qz.val;
        while (r < rEnd) {
          const r2 = rid(r); const s2 = rsz(r + r2.len); const rd = r + r2.len + s2.len;
          if (r2.id === 0xF1) posRefs.push({ off: rd, len: s2.val });
          r = rd + s2.val;
        }
      }
      q = qd + qz.val;
    }
    p = qEnd;
  }
}
console.log('Cues 条目:', posRefs.length, '| Cues 偏移:', cuesAt);

/* ── 构造 SeekHead：Info / Tracks / Cues 三条 ── */
function seekEntry(idBytes, relPos) {
  return el([0x4D, 0xBB], Buffer.concat([el([0x53, 0xAB], new Uint8Array(idBytes)), el([0x53, 0xAC], uint(relPos))]));
}
// 先假定长度算一轮（SeekHead 自身长度影响其后所有偏移）
// NO_CUES_ENTRY=1 时不写 Cues 条目；REL_ELEMENT=1 时 SeekPosition 相对
// Segment 元素头（含 ID+size）而非数据段——两种约定实测定夺
// SeekPosition 基准：实测 Chrome 按「相对 Segment 元素头（含 ID+size）」解析——
// 规范字面写「相对数据段」但实现不认（实测拖不动）。默认用元素头基准；
// SEG_DATA_BASE=1 可退回规范字面基准（留作对照）
const seekBase = process.env.SEG_DATA_BASE ? segDataStart : (segDataStart - 12);  // 元素头起点 = 48-12=36
// 回填定长 Segment size（默认开；SEG_UNKNOWN=1 关闭）：
// Chrome 流式写出时 Segment size 是全 1「未知」，WMP/MF 很可能因此当直播流处理（不可拖）。
// 8 字节 VINT 容量 2^56，原位重写不移位
const segSzOff = segDataStart - 8;   // 8 字节 unknown size 字段的位置
function buildSeekHead(shift) {
  const entries = [
    seekEntry([0x15, 0x49, 0xA9, 0x66], infoAt + shift - seekBase),      // Info 相对 segDataStart
    seekEntry([0x16, 0x54, 0xAE, 0x6B], tracksAt + shift - seekBase),   // Tracks
  ];
  if (!process.env.NO_CUES_ENTRY) {
    entries.push(seekEntry([0x1C, 0x53, 0xBB, 0x6B], cuesAt + shift - seekBase));
  }
  return el([0x11, 0x4D, 0x9B, 0x74], Buffer.concat(entries));
}
let sh = process.env.NO_SEEKHEAD ? new Uint8Array(0) : buildSeekHead(0);
let shift = sh.length;
if (!process.env.NO_SEEKHEAD) {
  sh = buildSeekHead(shift);          // 二轮：长度稳定（本文件结构下长度不会变）
  if (sh.length !== shift) { shift = sh.length; sh = buildSeekHead(shift); }
}
console.log('SeekHead 长度:', shift, '字节，插入于', segDataStart);

/* ── 既有 Cues 的簇偏移等宽 +shift ── */
for (const r of posRefs) {
  let v = 0;
  for (let i = 0; i < r.len; i++) v = v * 256 + b[r.off + i];
  const nv = v + shift;
  if (nv >= Math.pow(256, r.len)) throw new Error('等宽放不下');
  for (let i = r.len - 1; i >= 0; i--) b[r.off + i] = nv >>> ((r.len - 1 - i) * 8) & 0xFF;
}

/* ── 拼装输出 ── */
// 回填定长 Segment size（默认开；SEG_UNKNOWN=1 关闭）
if (!process.env.SEG_UNKNOWN) {
  // Segment 数据真实大小 = 原文件从 segDataStart 起 + SeekHead 插入长度
  const segDataSize = (total - segDataStart) + shift;
  // 8 字节 VINT：marker 0x01 + 7 字节值（56 位容量）
  const szBytes = new Uint8Array(8);
  let v = segDataSize;
  for (let i = 7; i >= 1; i--) { szBytes[i] = v & 0xFF; v = Math.floor(v / 256); }
  szBytes[0] = 0x01;
  for (let i = 0; i < 8; i++) b[segSzOff + i] = szBytes[i];
  console.log('Segment size 回填为定长:', segDataSize);
}
fs.writeFileSync(outFile, Buffer.concat([
  b.subarray(0, segDataStart), Buffer.from(sh), b.subarray(segDataStart),
]));

/* ── 验证：SeekHead 可解析、首簇偏移指向真 Cluster ── */
const o = fs.readFileSync(outFile);
const shAt = o.indexOf(Buffer.from([0x11, 0x4d, 0x9b, 0x74]));
console.log('验证 SeekHead 存在:', shAt >= 0);
const firstClusterOff = 48 + shift + 0;   // 相对 segDataStart 修正
// 读修补后首条 CueClusterPosition
const firstPosOff = posRefs[0].off + shift;
let fp = 0; for (let i = 0; i < posRefs[0].len; i++) fp = fp * 256 + o[firstPosOff + i];
console.log('首簇指向:', o.readUInt32BE(48 + fp) === 0x1F43B675 ? '✓ Cluster 头' : '✗', '(pos=' + fp + ')');
console.log('完成 →', outFile);
