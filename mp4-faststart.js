/**
 * mp4-faststart.js — 纯 JS 的 MP4 faststart：把 moov 原子搬到文件头部
 *
 * 为什么需要：Chrome MediaRecorder 原生录的 MP4 把 moov（索引/时长元数据）
 * 写在文件末尾，播放器必须读到文件尾才能显示时长和拖动进度条。
 *
 * 为什么不用 ffmpeg.wasm：此前用 wasm 的 `-movflags +faststart` 做这件事，
 * 要把整个文件读进 wasm 虚拟 FS 再写出一份——输入+输出+arrayBuffer 拷贝，
 * GB 级长视频必然超过 wasm32 的 4GB 内存天花板（实测 2.3GB / 2h56m 即 OOM
 * 回退成不可拖动的文件）。而 moov 搬迁本质上只是改几个偏移量：
 *
 *   - 只把 moov（KB~MB 级）读进内存，用 Blob.slice 引用拼装新文件
 *   - 内存占用 O(moov 大小)，与文件大小无关，任意时长都可用
 *
 * 做法：把 moov 移到第一个 mdat 之前（faststart 定义），moov 内 stco/co64
 * 表里的 chunk 绝对偏移统一 +moovSize（其后的 mdat 数据整体后移了这么多）。
 *
 * 适用边界：非分片的常规 MP4（Chrome MediaRecorder 输出即此类）。
 * 分片 MP4（moof/mfra）或 stco 32 位溢出时抛错，调用方自行回退。
 *
 * 暴露全局：mp4FaststartJs(blob) -> Promise<Blob>（已是 faststart 则原样返回）
 */

(function (G) {
  'use strict';

  // 需要递归进入的容器 box（chunk 偏移表在 moov/trak/mdia/minf/stbl 里）
  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

  function u32(dv, o) { return dv.getUint32(o); }
  function type4(dv, o) {
    return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1),
                               dv.getUint8(o + 2), dv.getUint8(o + 3));
  }

  /** 解析 box 头。返回 { size, type, headerLen } 或 null。 */
  function boxHeader(dv, off, end) {
    if (off + 8 > end) return null;
    const size32 = u32(dv, off);
    const type = type4(dv, off + 4);
    if (size32 === 1) {                      // 64-bit largesize
      if (off + 16 > end) return null;
      const hi = u32(dv, off + 8), lo = u32(dv, off + 12);
      return { size: hi * 4294967296 + lo, type, headerLen: 16 };
    }
    if (size32 === 0) return { size: end - off, type, headerLen: 8 };  // 到末尾
    return { size: size32, type, headerLen: 8 };
  }

  /**
   * 在 moov 数据区内递归找 stco/co64 表并修正 chunk 绝对偏移。
   * 只修正落在 [shiftFrom, shiftTo) 区间的偏移——moov 搬到第一个 mdat
   * 之前后，只有这个区间的数据被挤后移；moov 之后的内容（例如第二个
   * mdat）绝对位置没变，统一 +shift 会改坏多 mdat 布局。
   * 返回 { patched, overflow }：patched=0 说明不是常规 MP4（可能是分片），
   * overflow=true 说明 stco 32 位放不下新偏移，两种都应让调用方回退。
   */
  function patchChunkOffsets(dv, start, end, shift, shiftFrom, shiftTo) {
    let patched = 0, overflow = false;
    let cur = start;
    while (cur + 8 <= end) {
      const h = boxHeader(dv, cur, end);
      if (!h || h.size < h.headerLen || cur + h.size > end && h.size !== end - cur) break;
      const dataStart = cur + h.headerLen;
      const boxEnd = Math.min(cur + h.size, end);

      if (h.type === 'stco' || h.type === 'co64') {
        // FullBox：version(1) + flags(3) + entry_count(4) + entries[]
        const count = u32(dv, dataStart + 4);
        const step = h.type === 'stco' ? 4 : 8;
        let p = dataStart + 8;
        for (let i = 0; i < count && p + step <= boxEnd; i++, p += step) {
          if (h.type === 'stco') {
            const v = u32(dv, p);
            if (v < shiftFrom || v >= shiftTo) continue;   // 不在位移区间，跳过
            const nv = v + shift;
            if (nv > 0xFFFFFFFF) { overflow = true; } else { dv.setUint32(p, nv); patched++; }
          } else {
            const lo = u32(dv, p + 4);
            const hi = u32(dv, p);
            const v = hi * 4294967296 + lo;
            if (v < shiftFrom || v >= shiftTo) continue;   // 同上
            // co64：低 32 位加 shift 并处理进位（shift 为 moov 大小，远小于 2^32）
            const nlo = lo + shift;
            dv.setUint32(p + 4, nlo >>> 0);
            dv.setUint32(p, hi + Math.floor(nlo / 4294967296));
            patched++;
          }
        }
      } else if (CONTAINERS.has(h.type)) {
        const r = patchChunkOffsets(dv, dataStart, boxEnd, shift, shiftFrom, shiftTo);
        patched += r.patched; overflow = overflow || r.overflow;
      }
      if (h.size <= 0) break;
      cur += h.size;
    }
    return { patched, overflow };
  }

  /**
   * @param {Blob} blob  Chrome MediaRecorder 原生录的 MP4（moov 通常在末尾）
   * @returns {Promise<Blob>}  moov 已在 mdat 之前的 MP4；已是 faststart 则原样返回
   * @throws  非常规 MP4（无 moov/mdat、无 chunk 表、32 位偏移溢出）时抛错
   */
  async function mp4FaststartJs(blob) {
    const total = blob.size;

    // 1. 顺序扫描顶层 box 头（每次只读 16 字节），定位 moov / mdat
    //    前置假设（Chrome MediaRecorder 产物满足）：顶层 box 均为定长 size、
    //    单 mdat。即使不满足也做了防御：size==0（延伸到文件尾）的 box 会
    //    用文件剩余长度算出正确 size；多 mdat 由下方的区间修正逻辑覆盖。
    const boxes = [];
    let pos = 0;
    while (pos + 8 <= total) {
      const head = await blob.slice(pos, Math.min(pos + 16, total)).arrayBuffer();
      // end 必须传「文件剩余长度」而非切片长度：size==0 的 box 表示延伸到
      // 文件尾，按切片长度会把它的 size 误判为 16，后续扫描整体错位
      const h = boxHeader(new DataView(head), 0, total - pos);
      if (!h || h.size < h.headerLen) break;
      boxes.push({ type: h.type, off: pos, size: h.size });
      pos += h.size;
    }

    const moov = boxes.find(b => b.type === 'moov');
    const mdat = boxes.find(b => b.type === 'mdat');
    if (!moov || !mdat) throw new Error('未找到 moov/mdat，不是常规 MP4');
    if (moov.off < mdat.off) return blob;   // 已是 faststart，无需处理

    // 2. 读入 moov 全量（KB~MB 级），chunk 偏移统一 +moov.size
    //    （moov 插到第一个 mdat 之前，其后所有数据整体右移 moov.size 字节）
    const moovBuf = await blob.slice(moov.off, moov.off + moov.size).arrayBuffer();
    const dv = new DataView(moovBuf);
    const moovHeader = boxHeader(dv, 0, dv.byteLength);
    if (!moovHeader) throw new Error('moov 头解析失败');
    // moov 自身若写着 size==0（「延伸到文件尾」的合法写法），搬迁后它不再是
    // 最后一个 box，必须把 size 字段回填为真实大小，否则会吞掉后面的 mdat
    if (u32(dv, 0) === 0) dv.setUint32(0, moov.size);
    const { patched, overflow } =
      patchChunkOffsets(dv, moovHeader.headerLen, dv.byteLength, moov.size,
                        mdat.off, moov.off);   // 只修正被挤后移的区段
    if (overflow) throw new Error('stco 32 位偏移溢出，无法纯 JS 重排');
    if (patched === 0) throw new Error('moov 内未找到 stco/co64（可能是分片 MP4）');

    // 3. Blob 引用拼装（O(1)，不产生大内存拷贝）：
    //    [mdat 之前的 box（ftyp 等）] + [补丁后的 moov] + [mdat..moov) + [moov 之后]
    return new Blob([
      blob.slice(0, mdat.off),
      new Uint8Array(moovBuf),
      blob.slice(mdat.off, moov.off),
      blob.slice(moov.off + moov.size),
    ], { type: 'video/mp4' });
  }

  G.mp4FaststartJs = mp4FaststartJs;
})(typeof self !== 'undefined' ? self : globalThis);
