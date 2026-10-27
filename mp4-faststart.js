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
 * Scope: classic MP4 faststart and already-faststart fragmented MP4.
 * For fMP4, only moov/moof headers are read; mvhd/tkhd/mdhd durations are
 * rebuilt from fragment timelines while mdat and fragment boxes stay untouched.
 * Fragmented files with moov at EOF and stco overflow still fall back.
 *
 * 暴露全局：mp4FaststartJs(blob) -> Promise<Blob>
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

  function childBoxes(dv, start, end) {
    const out = [];
    let cur = start;
    while (cur < end) {
      const h = boxHeader(dv, cur, end);
      if (!h || h.size < h.headerLen || cur + h.size > end) {
        throw new Error('MP4 box 截断或尺寸非法');
      }
      out.push({ ...h, off: cur, dataOff: cur + h.headerLen, end: cur + h.size });
      cur += h.size;
    }
    return out;
  }

  function safeInteger(value) {
    if (!Number.isSafeInteger(value)) throw new Error('MP4 时间值超出安全整数范围');
    return value;
  }

  function readUint64(dv, off) {
    const hi = dv.getUint32(off);
    const lo = dv.getUint32(off + 4);
    return safeInteger(hi * 4294967296 + lo);
  }

  function writeDuration(dv, off, version, value) {
    safeInteger(value);
    if (value < 0) throw new Error('MP4 时长不能为负数');
    if (version === 1) {
      dv.setBigUint64(off, BigInt(value));
    } else {
      if (value > 0xFFFFFFFF) throw new Error('MP4 version 0 时长溢出');
      dv.setUint32(off, value);
    }
  }

  function parseFmp4Moov(dv) {
    const root = boxHeader(dv, 0, dv.byteLength);
    if (!root) throw new Error('moov 头解析失败');
    const top = childBoxes(dv, root.headerLen, dv.byteLength);
    const mvhd = top.find(x => x.type === 'mvhd');
    if (!mvhd) throw new Error('fMP4 缺 mvhd');
    const mvVersion = dv.getUint8(mvhd.dataOff);
    const movie = {
      timescale: u32(dv, mvhd.dataOff + (mvVersion === 1 ? 20 : 12)),
      durationOff: mvhd.dataOff + (mvVersion === 1 ? 24 : 16),
      version: mvVersion,
    };
    if (!movie.timescale) throw new Error('MP4 电影 timescale 为 0');

    const tracks = new Map();
    for (const trak of top.filter(x => x.type === 'trak')) {
      const children = childBoxes(dv, trak.dataOff, trak.end);
      const tkhd = children.find(x => x.type === 'tkhd');
      const mdia = children.find(x => x.type === 'mdia');
      if (!tkhd || !mdia) throw new Error('fMP4 轨道缺 tkhd/mdia');
      const mdhd = childBoxes(dv, mdia.dataOff, mdia.end).find(x => x.type === 'mdhd');
      if (!mdhd) throw new Error('fMP4 轨道缺 mdhd');
      const tkVersion = dv.getUint8(tkhd.dataOff);
      const mdVersion = dv.getUint8(mdhd.dataOff);
      const id = u32(dv, tkhd.dataOff + (tkVersion === 1 ? 20 : 12));
      const track = {
        id,
        tkhdDurationOff: tkhd.dataOff + (tkVersion === 1 ? 28 : 20),
        tkhdVersion: tkVersion,
        mdhdDurationOff: mdhd.dataOff + (mdVersion === 1 ? 24 : 16),
        mdhdVersion: mdVersion,
        timescale: u32(dv, mdhd.dataOff + (mdVersion === 1 ? 20 : 12)),
      };
      if (!track.timescale) throw new Error('MP4 轨道 timescale 为 0');
      tracks.set(id, track);
    }
    if (!tracks.size) throw new Error('fMP4 没有可修补的轨道');

    const defaults = new Map();
    for (const mvex of top.filter(x => x.type === 'mvex')) {
      for (const trex of childBoxes(dv, mvex.dataOff, mvex.end).filter(x => x.type === 'trex')) {
        defaults.set(u32(dv, trex.dataOff + 4), u32(dv, trex.dataOff + 12));
      }
    }
    return { movie, tracks, defaults };
  }

  function parseTfhd(dv, box) {
    const flags = u32(dv, box.dataOff) & 0xFFFFFF;
    const trackId = u32(dv, box.dataOff + 4);
    let pos = box.dataOff + 8;
    if (flags & 0x000001) pos += 8;
    if (flags & 0x000002) pos += 4;
    let defaultDuration = 0;
    if (flags & 0x000008) {
      defaultDuration = u32(dv, pos);
      pos += 4;
    }
    return { trackId, defaultDuration };
  }

  function parseTfdt(dv, box) {
    const version = dv.getUint8(box.dataOff);
    return version === 1 ? readUint64(dv, box.dataOff + 4) : u32(dv, box.dataOff + 4);
  }

  function parseTrun(dv, box, baseTime, defaultDuration) {
    const version = dv.getUint8(box.dataOff);
    const flags = u32(dv, box.dataOff) & 0xFFFFFF;
    const count = u32(dv, box.dataOff + 4);
    let pos = box.dataOff + 8;
    if (flags & 0x000001) pos += 4;
    if (flags & 0x000004) pos += 4;
    let decodeTime = baseTime;
    let maxEnd = 0;
    for (let i = 0; i < count; i++) {
      let duration = defaultDuration;
      if (flags & 0x000100) {
        duration = u32(dv, pos);
        pos += 4;
      }
      if (flags & 0x000200) pos += 4;
      if (flags & 0x000400) pos += 4;
      let compositionOffset = 0;
      if (flags & 0x000800) {
        compositionOffset = version === 1 ? dv.getInt32(pos) : u32(dv, pos);
        pos += 4;
      }
      if (!duration) throw new Error('MP4 trun 缺 sample duration 且没有默认值');
      if (pos > box.end) throw new Error('MP4 trun 样本字段截断');
      maxEnd = Math.max(maxEnd, decodeTime + compositionOffset + duration);
      decodeTime += duration;
      safeInteger(decodeTime);
    }
    return { maxEnd, decodeTime };
  }

  function parseMoof(dv, meta, ends) {
    const root = boxHeader(dv, 0, dv.byteLength);
    if (!root) throw new Error('moof 头解析失败');
    for (const traf of childBoxes(dv, root.headerLen, dv.byteLength).filter(x => x.type === 'traf')) {
      const children = childBoxes(dv, traf.dataOff, traf.end);
      const tfhd = children.find(x => x.type === 'tfhd');
      const tfdt = children.find(x => x.type === 'tfdt');
      if (!tfhd || !tfdt) throw new Error('MP4 traf 缺 tfhd/tfdt');
      const { trackId, defaultDuration } = parseTfhd(dv, tfhd);
      if (!meta.tracks.has(trackId)) throw new Error('MP4 分片包含未知轨道');
      const baseTime = parseTfdt(dv, tfdt);
      const fallback = defaultDuration || meta.defaults.get(trackId) || 0;
      let decodeTime = baseTime;
      for (const trun of children.filter(x => x.type === 'trun')) {
        const result = parseTrun(dv, trun, decodeTime, fallback);
        decodeTime = result.decodeTime;
        ends.set(trackId, Math.max(ends.get(trackId) || 0, result.maxEnd));
      }
    }
  }

  function rescaleTime(value, fromScale, toScale) {
    const scaled = value * toScale;
    safeInteger(scaled);
    return Math.round(scaled / fromScale);
  }

  async function fixFragmentedMp4(blob, boxes, moov) {
    const total = blob.size;
    const moofs = boxes.filter(x => x.type === 'moof');
    const moovBuf = await blob.slice(moov.off, moov.off + moov.size).arrayBuffer();
    const dv = new DataView(moovBuf);
    const meta = parseFmp4Moov(dv);
    const ends = new Map();

    for (const moof of moofs) {
      if (moof.off + moof.size > total) throw new Error('MP4 moof 截断');
      const buf = await blob.slice(moof.off, moof.off + moof.size).arrayBuffer();
      parseMoof(new DataView(buf), meta, ends);
    }

    let movieDuration = 0;
    for (const [trackId, track] of meta.tracks) {
      if (!ends.has(trackId)) throw new Error(`MP4 轨道 ${trackId} 没有可计算的媒体时长`);
      const end = ends.get(trackId);
      const inMovieScale = rescaleTime(end, track.timescale, meta.movie.timescale);
      movieDuration = Math.max(movieDuration, inMovieScale);
      writeDuration(dv, track.tkhdDurationOff, track.tkhdVersion, inMovieScale);
      writeDuration(dv, track.mdhdDurationOff, track.mdhdVersion, end);
    }
    writeDuration(dv, meta.movie.durationOff, meta.movie.version, movieDuration);

    return new Blob([
      blob.slice(0, moov.off),
      new Uint8Array(moovBuf),
      blob.slice(moov.off + moov.size),
    ], { type: blob.type || 'video/mp4' });
  }

  /**
   * @param {Blob} blob  Chrome MediaRecorder 原生录的 MP4（moov 通常在末尾）
   * @returns {Promise<Blob>} faststart MP4 with valid duration metadata;
   *   non-fragmented faststart input is returned unchanged
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
    // TODO: fMP4 with moov after the first mdat needs dedicated relocation
    // and fragment-offset repair. See docs/todo/moov-at-end-fmp4.md.
    if (moov.off < mdat.off) {
      if (boxes.some(b => b.type === 'moof')) return await fixFragmentedMp4(blob, boxes, moov);
      return blob;   // 已是 faststart 且非分片，无需处理
    }

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
