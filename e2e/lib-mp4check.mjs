/**
 * e2e/lib-mp4check.mjs — MP4 产物校验（run.mjs 与 unit-native-mp4.mjs 共用）
 *
 * makeCheckMp4(ok) → checkMp4(file, {minMs, maxMs})
 * 校验项：顶层 box 解析、moov 在 mdat 前（faststart）、avc1/mp4a 轨、mvhd 时长区间
 */

import fs from 'node:fs';

/** 解析顶层 box 列表：[{type, off, size}] */
export function topBoxes(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = [];
  let pos = 0;
  while (pos + 8 <= b.length) {
    let size = dv.getUint32(pos);
    const type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
    let headerLen = 8;
    if (size === 1) {                       // 64-bit largesize
      size = dv.getUint32(pos + 8) * 4294967296 + dv.getUint32(pos + 12);
      headerLen = 16;
    } else if (size === 0) {
      size = b.length - pos;                // 到文件尾
    }
    out.push({ type, off: pos, size, headerLen });
    if (size <= 0) break;
    pos += size;
  }
  return out;
}

/** 从 moov 里读 mvhd 时长（毫秒）。version 0：timescale/duration 为 32 位。 */
export function mvhdDurationMs(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const mv = b.indexOf(Buffer.from('mvhd'));
  if (mv < 0) return null;
  const dataStart = mv + 4;                 // mv 指向 type 字段，数据紧随其后
  const version = b[dataStart];
  if (version === 1) {
    const timescale = dv.getUint32(dataStart + 20);
    const duration = dv.getUint32(dataStart + 24) * 4294967296 + dv.getUint32(dataStart + 28);
    return timescale ? duration / timescale * 1000 : null;
  }
  const timescale = dv.getUint32(dataStart + 12);
  const duration = dv.getUint32(dataStart + 16);
  return timescale ? duration / timescale * 1000 : null;
}

export function makeCheckMp4(ok) {
  return function checkMp4(file, { minMs = 0, maxMs = Infinity } = {}) {
    const b = fs.readFileSync(file);
    const boxes = topBoxes(b);
    const order = boxes.map(x => x.type).join(',');
    ok('MP4 顶层 box 解析', boxes.length >= 3 && boxes[0].type === 'ftyp', order);
    const moovI = boxes.findIndex(x => x.type === 'moov');
    const mdatI = boxes.findIndex(x => x.type === 'mdat');
    ok('moov 在 mdat 之前（faststart 生效）', moovI >= 0 && mdatI >= 0 && moovI < mdatI, order);
    // 编码轨随平台：Windows/macOS 是 avc1+mp4a(H.264/AAC)，Linux 上是 vp09+Opus（MP4 容器不变）
    const hasVideo = b.includes(Buffer.from('avc1')) || b.includes(Buffer.from('vp09'));
    const hasAudio = b.includes(Buffer.from('mp4a')) || b.includes(Buffer.from('Opus'));
    ok('含视频轨（avc1/vp09）', hasVideo);
    ok('含音轨（mp4a/Opus）', hasAudio);
    const durMs = mvhdDurationMs(b);
    if (durMs === null) {
      ok('含 mvhd（时长元数据）', false);
    } else {
      ok(`mvhd 时长在 [${minMs}, ${maxMs}]ms 区间`, durMs >= minMs && durMs <= maxMs,
         `实际 ${Math.round(durMs)}ms`);
    }
  };
}
