/**
 * fix-webm.js — v4
 *
 * Chrome's MediaRecorder outputs WebM files that:
 *   1) Have Duration = 0 or absent  → player shows "unknown length"
 *   2) Have NO Cues element         → player CANNOT seek/drag progress bar
 *
 * This module fixes BOTH by:
 *   1) Scanning all Cluster elements to read their Timecodes + byte offsets
 *   2) Building a proper Cues element (seek index)
 *   3) Appending Cues at the end of the file
 *   4) Patching Duration in the Info element — or INSERTING one when Chrome
 *      never wrote it (Info grows; cluster offsets in Cues shift accordingly)
 *
 * All of the above is STREAMING: the file is never fully materialized.
 * A 256KB sliding window scans sequentially (fixWebMStream), and the output
 * is assembled from Blob.slice references plus small in-memory patches
 * (sparse edits). Peak memory is O(window + Cues), independent of file size
 * — the legacy full-buffer implementation (fixWebM) is kept as the golden
 * reference for byte-equality tests and is NOT used in production.
 *
 * After fixing, the file is fully seekable in Chrome, Firefox, VLC, etc.
 */

(function (G) {
  'use strict';

  /* ═══════════════════════════════════════════════════════
     EBML Binary Read Helpers
     ═══════════════════════════════════════════════════════ */

  /** Read EBML Element ID (1–4 bytes, raw bits kept). */
  function readId(dv, off) {
    if (off >= dv.byteLength) return null;
    const b = dv.getUint8(off);
    let len;
    if      (b & 0x80) len = 1;
    else if (b & 0x40) len = 2;
    else if (b & 0x20) len = 3;
    else if (b & 0x10) len = 4;
    else return null;
    if (off + len > dv.byteLength) return null;
    let id = 0;
    for (let i = 0; i < len; i++) id = (id << 8) | dv.getUint8(off + i);
    // Handle negative from signed 32-bit shift
    id = id >>> 0;
    return { id, len };
  }

  /** Read EBML Data Size VINT (strips leading marker bit). */
  function readSize(dv, off) {
    if (off >= dv.byteLength) return null;
    const b = dv.getUint8(off);
    let len = 0, mask = 0;
    if      (b & 0x80) { len = 1; mask = 0x7F; }
    else if (b & 0x40) { len = 2; mask = 0x3F; }
    else if (b & 0x20) { len = 3; mask = 0x1F; }
    else if (b & 0x10) { len = 4; mask = 0x0F; }
    else if (b & 0x08) { len = 5; mask = 0x07; }
    else if (b & 0x04) { len = 6; mask = 0x03; }
    else if (b & 0x02) { len = 7; mask = 0x01; }
    else if (b & 0x01) { len = 8; mask = 0x00; }
    else return null;
    if (off + len > dv.byteLength) return null;

    let val = b & mask;
    for (let i = 1; i < len; i++) val = val * 256 + dv.getUint8(off + i);

    // Detect "unknown size" (all value bits = 1)
    let allOnes = mask;
    for (let i = 1; i < len; i++) allOnes = allOnes * 256 + 0xFF;
    const unknown = (val === allOnes);

    return { val, len, unknown };
  }

  /** Read an unsigned int of `n` bytes at `off`. */
  function readUint(dv, off, n) {
    let val = 0;
    for (let i = 0; i < n; i++) val = val * 256 + dv.getUint8(off + i);
    return val;
  }

  /* ═══════════════════════════════════════════════════════
     EBML Binary Write Helpers
     ═══════════════════════════════════════════════════════ */

  /** Encode a VINT size value. Returns Uint8Array. */
  function encodeVintSize(value) {
    // Determine minimum bytes needed
    let len;
    if      (value < 0x7F)             len = 1;   // 2^7 - 1
    else if (value < 0x3FFF)           len = 2;   // 2^14 - 1
    else if (value < 0x1FFFFF)         len = 3;   // 2^21 - 1
    else if (value < 0x0FFFFFFF)       len = 4;   // 2^28 - 1
    else if (value < 0x07FFFFFFFF)     len = 5;
    else if (value < 0x03FFFFFFFFFF)   len = 6;
    else if (value < 0x01FFFFFFFFFFFF) len = 7;
    else                               len = 8;

    const bytes = new Uint8Array(len);
    let v = value;
    for (let i = len - 1; i >= 1; i--) {
      bytes[i] = v & 0xFF;
      v = Math.floor(v / 256);
    }
    bytes[0] = v | (1 << (8 - len));  // set VINT marker
    return bytes;
  }

  /** Encode a VINT size value at an exact byte width (for in-place rewrites). */
  function encodeVintSizeFixed(value, width) {
    const bytes = new Uint8Array(width);
    let v = value;
    for (let i = width - 1; i >= 1; i--) {
      bytes[i] = v & 0xFF;
      v = Math.floor(v / 256);
    }
    bytes[0] = (v & ((1 << (8 - width)) - 1)) | (1 << (8 - width));
    return bytes;
  }

  /** Encode an unsigned integer in minimum bytes. Returns Uint8Array. */
  function encodeUint(value) {
    if (value === 0) return new Uint8Array([0]);
    const bytes = [];
    let v = value;
    while (v > 0) {
      bytes.unshift(v & 0xFF);
      v = Math.floor(v / 256);
    }
    return new Uint8Array(bytes);
  }

  /** Encode an EBML element: ID bytes + VINT size + data. */
  function encodeElement(idBytes, data) {
    const id = new Uint8Array(idBytes);
    const size = encodeVintSize(data.byteLength);
    const out = new Uint8Array(id.length + size.length + data.byteLength);
    out.set(id, 0);
    out.set(size, id.length);
    out.set(new Uint8Array(data.buffer || data), id.length + size.length);
    return out;
  }

  /** Concatenate multiple Uint8Arrays. */
  function concat(...arrays) {
    const total = arrays.reduce((s, a) => s + a.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) {
      out.set(a, off);
      off += a.byteLength;
    }
    return out;
  }

  /* ═══════════════════════════════════════════════════════
     EBML Element IDs (as byte arrays for writing)
     ═══════════════════════════════════════════════════════ */

  const ID = {
    EBML_HEADER:  0x1A45DFA3,
    SEGMENT:      0x18538067,
    INFO:         0x1549A966,
    TIMESCALE:    0x2AD7B1,
    DURATION:     0x4489,
    TRACKS:       0x1654AE6B,
    CLUSTER:      0x1F43B675,
    TIMECODE:     0xE7,
    CUES:         0x1C53BB6B,
    CUE_POINT:    0xBB,
    CUE_TIME:     0xB3,
    CUE_TRACK_POS:0xB7,
    CUE_TRACK:    0xF7,
    CUE_CLUSTER:  0xF1,
  };

  // Byte representations for writing
  const ID_BYTES = {
    CUES:          [0x1C, 0x53, 0xBB, 0x6B],
    CUE_POINT:     [0xBB],
    CUE_TIME:      [0xB3],
    CUE_TRACK_POS: [0xB7],
    CUE_TRACK:     [0xF7],
    CUE_CLUSTER:   [0xF1],
    DURATION:      [0x44, 0x89],
  };

  /* ═══════════════════════════════════════════════════════
     LEGACY full-buffer implementation — golden reference only.

     把整个文件物化成 ArrayBuffer（2× 内存放大），仅由
     e2e/unit-webmstream.mjs 做逐字节 golden 对照用；生产路径走下面的
     fixWebMStream（流式）。等价性验证一个版本周期后可整体删除。
     ═══════════════════════════════════════════════════════ */

  function fixWebM(buf, durationMs) {
    const dv = new DataView(buf);
    const total = buf.byteLength;
    let pos = 0;

    /* ── Step 1: Skip EBML Header ── */
    const hdrId = readId(dv, pos);
    if (!hdrId || hdrId.id !== ID.EBML_HEADER) return buf;
    pos += hdrId.len;
    const hdrSz = readSize(dv, pos);
    if (!hdrSz) return buf;
    pos += hdrSz.len + hdrSz.val;

    /* ── Step 2: Enter Segment ── */
    const segId = readId(dv, pos);
    if (!segId || segId.id !== ID.SEGMENT) return buf;
    pos += segId.len;
    const segSz = readSize(dv, pos);
    if (!segSz) return buf;
    const segSzOff = pos;            // where Segment size VINT starts
    const segSzLen = segSz.len;
    pos += segSz.len;

    const segDataStart = pos;         // Segment data begins here
    const segEnd = segSz.unknown ? total : Math.min(segDataStart + segSz.val, total);

    /* ── Step 3: Scan Segment children ── */
    let infoOff = -1, infoLen = 0;    // Info element (header + data)
    let infoSzOff = 0, infoSzLen = 0; // where Info's size VINT is, and its width
    let infoDataStart = 0;            // Info data begin
    let infoDataEnd = -1;             // Info data end (-1 if unknown size)
    let infoDefinite = false;         // Info written with a definite size
    let durationDataOff = -1;         // where Duration float is
    let durationDataLen = 0;
    let timecodeScale = 1000000;
    const clusters = [];              // { absoluteOff, timecodeMs }
    let cur = segDataStart;

    while (cur < segEnd - 4) {
      const elId = readId(dv, cur);
      if (!elId) break;
      const szOff = cur + elId.len;
      const elSz = readSize(dv, szOff);
      if (!elSz) break;
      const dataOff = szOff + elSz.len;

      if (elId.id === ID.INFO) {
        infoOff = cur;
        infoLen = elId.len + elSz.len + (elSz.unknown ? 0 : elSz.val);
        infoSzOff = szOff;
        infoSzLen = elSz.len;
        infoDefinite = !elSz.unknown;
        infoDataStart = dataOff;
        infoDataEnd = infoDefinite ? Math.min(dataOff + elSz.val, total) : -1;

        // Parse Info children
        const infoEnd = elSz.unknown ? segEnd : Math.min(dataOff + elSz.val, total);
        let ic = dataOff;
        while (ic < infoEnd - 2) {
          const cId = readId(dv, ic);
          if (!cId) break;
          const cSzOff = ic + cId.len;
          const cSz = readSize(dv, cSzOff);
          if (!cSz || cSz.unknown) break;
          const cData = cSzOff + cSz.len;

          if (cId.id === ID.TIMESCALE && cSz.val <= 4) {
            timecodeScale = readUint(dv, cData, cSz.val);
          }
          if (cId.id === ID.DURATION) {
            durationDataOff = cData;
            durationDataLen = cSz.val;
          }
          ic = cData + cSz.val;
        }
      }

      if (elId.id === ID.CLUSTER) {
        // Read Timecode (first child, ID = 0xE7)
        let tc = dataOff;
        const clusterEnd = elSz.unknown ? segEnd : Math.min(dataOff + elSz.val, total);

        // Look for Timecode in first few bytes of cluster
        const tcId = readId(dv, tc);
        let timecodeMs = 0;
        if (tcId && tcId.id === ID.TIMECODE) {
          const tcSz = readSize(dv, tc + tcId.len);
          if (tcSz) {
            const tcData = tc + tcId.len + tcSz.len;
            timecodeMs = readUint(dv, tcData, tcSz.val);
          }
        }

        clusters.push({
          absoluteOff: cur,
          relativeOff: cur - segDataStart,
          timecodeMs: timecodeMs,
        });

        // For unknown-size clusters, scan forward to find next top-level element
        if (elSz.unknown) {
          // Scan byte by byte for next Cluster or known top-level ID
          let scan = dataOff + 1;
          while (scan < segEnd - 4) {
            const peekId = readId(dv, scan);
            if (peekId && (
              peekId.id === ID.CLUSTER ||
              peekId.id === ID.CUES ||
              peekId.id === ID.INFO ||
              peekId.id === ID.TRACKS
            )) {
              break;
            }
            scan++;
          }
          cur = scan;
          continue;
        }
      }

      if (elSz.unknown) {
        // Can't skip unknown-size non-cluster element reliably
        cur = dataOff + 1;
        continue;
      }
      cur = dataOff + elSz.val;
    }

    if (clusters.length === 0) return buf;

    /* ── Step 4: Duration — patch in place, or INSERT into Info ──

       Chrome's MediaRecorder sometimes writes no Duration element at all.
       In that case we append an 8-byte Duration at the end of Info's data
       and grow Info's size VINT (rewritten in place when its capacity
       suffices, widened by one byte otherwise). The insertion shifts every
       byte after Info right by insertLen, so each Cluster's Segment-relative
       offset recorded for Cues must shift right by the same amount. ── */
    const durVal = (durationMs * 1000000) / timecodeScale;
    let insertLen = 0;
    let newInfoVint = null;
    let durEl = null;

    if (durationDataOff < 0 && infoDefinite && infoDataEnd > 0) {
      const dv8 = new Uint8Array(8);
      new DataView(dv8.buffer).setFloat64(0, durVal);
      durEl = concat(new Uint8Array(ID_BYTES.DURATION), new Uint8Array([0x88]), dv8);

      const newInfoSize = (infoDataEnd - infoDataStart) + durEl.byteLength;
      // An n-byte VINT carries 7n payload bits; all-ones is "unknown size".
      const capacity = Math.pow(2, 7 * infoSzLen) - 2;
      const newVintLen = newInfoSize <= capacity ? infoSzLen : infoSzLen + 1;
      newInfoVint = encodeVintSizeFixed(newInfoSize, newVintLen);
      insertLen = durEl.byteLength + (newVintLen - infoSzLen);

      for (const c of clusters) { c.relativeOff += insertLen; c.absoluteOff += insertLen; }
    }

    /* ── Step 5: Build Cues element (offsets must be final by now) ── */
    const cuesData = buildCues(clusters);

    /* ── Step 6: Build new file ── */
    let newBuf;
    if (insertLen > 0) {
      // [.. Info size VINT) + new VINT + Info data + Duration + rest + Cues
      newBuf = concat(
        new Uint8Array(buf, 0, infoSzOff),
        newInfoVint,
        new Uint8Array(buf, infoSzOff + infoSzLen, infoDataEnd - (infoSzOff + infoSzLen)),
        durEl,
        new Uint8Array(buf, infoDataEnd, total - infoDataEnd),
        cuesData,
      );
    } else {
      const origBytes = new Uint8Array(buf);
      newBuf = new Uint8Array(total + cuesData.byteLength);
      newBuf.set(origBytes, 0);
      newBuf.set(cuesData, total);
    }

    /* ── Step 7: Patch Duration in place when Chrome wrote one ── */
    const newDv = new DataView(newBuf.buffer);
    if (durationDataOff >= 0 && durationDataLen === 8) {
      newDv.setFloat64(durationDataOff, durVal);
    } else if (durationDataOff >= 0 && durationDataLen === 4) {
      newDv.setFloat32(durationDataOff, durVal);
    }

    /* ── Step 8: Update Segment size if it was fixed (not unknown) ── */
    if (!segSz.unknown) {
      const newSegSize = segSz.val + cuesData.byteLength + insertLen;
      // An n-byte VINT size field carries 7n payload bits, and all-ones is
      // reserved for "unknown size". If the new size exceeds the field's
      // capacity, writing it in place would silently truncate and corrupt
      // the file — skip the update instead (players can still scan to the
      // end; Chrome's MediaRecorder output normally uses unknown size and
      // never reaches this branch).
      const capacity = Math.pow(2, 7 * segSzLen) - 2;
      if (newSegSize <= capacity) {
        writeVintSize(newDv, segSzOff, segSzLen, newSegSize);
      }
    }

    return newBuf.buffer;
  }

  /** Overwrite a VINT size field in place (same byte width). */
  function writeVintSize(dv, off, width, value) {
    const bytes = [];
    let v = value;
    for (let i = width - 1; i >= 0; i--) {
      bytes[i] = v & 0xFF;
      v = Math.floor(v / 256);
    }
    bytes[0] = (bytes[0] & ((1 << (8 - width)) - 1)) | (1 << (8 - width));
    for (let i = 0; i < width; i++) dv.setUint8(off + i, bytes[i]);
  }

  /* ═══════════════════════════════════════════════════════
     Build Cues Element
     ═══════════════════════════════════════════════════════ */

  function buildCues(clusters) {
    // Build CuePoint elements
    const cuePoints = [];
    for (const c of clusters) {
      // CueTrack = 1 (uint)
      const cueTrack = encodeElement(ID_BYTES.CUE_TRACK, encodeUint(1));
      // CueClusterPosition = relative offset from Segment data start
      const cueCluster = encodeElement(ID_BYTES.CUE_CLUSTER, encodeUint(c.relativeOff));
      // CueTrackPositions
      const cueTrackPos = encodeElement(ID_BYTES.CUE_TRACK_POS, concat(cueTrack, cueCluster));
      // CueTime
      const cueTime = encodeElement(ID_BYTES.CUE_TIME, encodeUint(c.timecodeMs));
      // CuePoint
      const cuePoint = encodeElement(ID_BYTES.CUE_POINT, concat(cueTime, cueTrackPos));
      cuePoints.push(cuePoint);
    }

    // Concatenate all CuePoints
    let cuePointsData = new Uint8Array(0);
    for (const cp of cuePoints) {
      cuePointsData = concat(cuePointsData, cp);
    }

    // Wrap in Cues element
    return encodeElement(ID_BYTES.CUES, cuePointsData);
  }

  /* ═══════════════════════════════════════════════════════
     Streaming implementation (production path)
     ═══════════════════════════════════════════════════════ */

  /**
   * 窗口读取层：把「整文件一个 DataView」换成按需滑动的 winSize 字节窗口。
   * readId/readSize/readUint 与全量版语义逐条对齐（越界返回 null /
   * 抛 RangeError 的行为一致），使 legacy 的解析逻辑得以原样复用。
   * 窗口不命中才 blob.slice 物化一次（≤winSize），命中时纯内存——
   * 扫描全程内存与文件大小无关。
   */
  function makeWindowReader(blob, winSize) {
    const total = blob.size;
    let winStart = 0;
    let win = new Uint8Array(0);

    async function ensure(off, len) {
      const end = Math.min(off + len, total);
      if (off < winStart || end > winStart + win.byteLength) {
        winStart = off;
        win = new Uint8Array(await blob.slice(off, Math.min(off + winSize, total)).arrayBuffer());
      }
    }
    const at = (off) => win[off - winStart];

    async function readId(off) {
      if (off >= total) return null;
      await ensure(off, 4);            // 近文件尾可能少于 4 字节——只需首字节
      const b = at(off);
      let len;
      if      (b & 0x80) len = 1;
      else if (b & 0x40) len = 2;
      else if (b & 0x20) len = 3;
      else if (b & 0x10) len = 4;
      else return null;
      if (off + len > total) return null;
      await ensure(off, len);
      let id = 0;
      for (let i = 0; i < len; i++) id = (id << 8) | at(off + i);
      return { id: id >>> 0, len };
    }

    async function readSize(off) {
      if (off >= total) return null;
      await ensure(off, 8);
      const b = at(off);
      let len = 0, mask = 0;
      if      (b & 0x80) { len = 1; mask = 0x7F; }
      else if (b & 0x40) { len = 2; mask = 0x3F; }
      else if (b & 0x20) { len = 3; mask = 0x1F; }
      else if (b & 0x10) { len = 4; mask = 0x0F; }
      else if (b & 0x08) { len = 5; mask = 0x07; }
      else if (b & 0x04) { len = 6; mask = 0x03; }
      else if (b & 0x02) { len = 7; mask = 0x01; }
      else if (b & 0x01) { len = 8; mask = 0x00; }
      else return null;
      if (off + len > total) return null;
      await ensure(off, len);
      let val = b & mask;
      for (let i = 1; i < len; i++) val = val * 256 + at(off + i);
      let allOnes = mask;
      for (let i = 1; i < len; i++) allOnes = allOnes * 256 + 0xFF;
      return { val, len, unknown: (val === allOnes) };
    }

    async function readUint(off, n) {
      if (off + n > total) {
        // 与 legacy（DataView.getUint8 越界抛 RangeError → 上层回退原文件）一致
        throw new RangeError('readUint out of bounds: ' + off + '+' + n + ' > ' + total);
      }
      await ensure(off, n);
      let val = 0;
      for (let i = 0; i < n; i++) val = val * 256 + at(off + i);
      return val;
    }

    return { total, readId, readSize, readUint };
  }

  /**
   * 流式扫描（legacy Steps 1-3 的逐行等价移植）：只收集「事实」，不物化文件。
   * 返回 null 表示 EBML/Segment 头不合法（等价 legacy 原样返回）。
   */
  async function scanWebM(rd) {
    const total = rd.total;

    /* Step 1: Skip EBML Header */
    let pos = 0;
    const hdrId = await rd.readId(pos);
    if (!hdrId || hdrId.id !== ID.EBML_HEADER) return null;
    pos += hdrId.len;
    const hdrSz = await rd.readSize(pos);
    if (!hdrSz) return null;
    pos += hdrSz.len + hdrSz.val;

    /* Step 2: Enter Segment */
    const segId = await rd.readId(pos);
    if (!segId || segId.id !== ID.SEGMENT) return null;
    pos += segId.len;
    const segSz = await rd.readSize(pos);
    if (!segSz) return null;
    const segSzOff = pos;
    const segSzLen = segSz.len;
    pos += segSz.len;
    const segDataStart = pos;
    const segEnd = segSz.unknown ? total : Math.min(segDataStart + segSz.val, total);

    /* Step 3: Scan Segment children */
    const f = {
      segSzOff, segSzLen, segSzVal: segSz.val, segSzUnknown: segSz.unknown,
      segDataStart,
      infoSzOff: 0, infoSzLen: 0, infoDefinite: false, infoDataStart: 0, infoDataEnd: -1,
      durationDataOff: -1, durationDataLen: 0,
      timecodeScale: 1000000,
      clusters: [],   // { absoluteOff, timecodeMs }，relativeOff 编辑阶段再算
    };

    let cur = segDataStart;
    while (cur < segEnd - 4) {
      const elId = await rd.readId(cur);
      if (!elId) break;
      const szOff = cur + elId.len;
      const elSz = await rd.readSize(szOff);
      if (!elSz) break;
      const dataOff = szOff + elSz.len;

      if (elId.id === ID.INFO) {
        f.infoSzOff = szOff;
        f.infoSzLen = elSz.len;
        f.infoDefinite = !elSz.unknown;
        f.infoDataStart = dataOff;
        f.infoDataEnd = f.infoDefinite ? Math.min(dataOff + elSz.val, total) : -1;

        const infoEnd = elSz.unknown ? segEnd : Math.min(dataOff + elSz.val, total);
        let ic = dataOff;
        while (ic < infoEnd - 2) {
          const cId = await rd.readId(ic);
          if (!cId) break;
          const cSzOff = ic + cId.len;
          const cSz = await rd.readSize(cSzOff);
          if (!cSz || cSz.unknown) break;
          const cData = cSzOff + cSz.len;

          if (cId.id === ID.TIMESCALE && cSz.val <= 4) {
            f.timecodeScale = await rd.readUint(cData, cSz.val);
          }
          if (cId.id === ID.DURATION) {
            f.durationDataOff = cData;
            f.durationDataLen = cSz.val;
          }
          ic = cData + cSz.val;
        }
      }

      if (elId.id === ID.CLUSTER) {
        const tcId = await rd.readId(dataOff);
        let timecodeMs = 0;
        if (tcId && tcId.id === ID.TIMECODE) {
          const tcSz = await rd.readSize(dataOff + tcId.len);
          if (tcSz) timecodeMs = await rd.readUint(dataOff + tcId.len + tcSz.len, tcSz.val);
        }
        f.clusters.push({ absoluteOff: cur, timecodeMs });

        if (elSz.unknown) {
          let scan = dataOff + 1;
          while (scan < segEnd - 4) {
            const peekId = await rd.readId(scan);
            if (peekId && (
              peekId.id === ID.CLUSTER || peekId.id === ID.CUES ||
              peekId.id === ID.INFO || peekId.id === ID.TRACKS
            )) break;
            scan++;
          }
          cur = scan;
          continue;
        }
      }

      if (elSz.unknown) {
        cur = dataOff + 1;
        continue;
      }
      cur = dataOff + elSz.val;
    }

    return f;
  }

  /**
   * 流式修复（legacy Steps 4-8 的推广）：所有修改统一表达为稀疏编辑
   * { off, deleteLen, insert }，随后用 Blob.slice 引用拼装——输出文件
   * 本体零拷贝。与 fixWebM() 的输出逐字节等价（e2e/unit-webmstream.mjs
   * golden 钉死）。
   */
  async function fixWebMStream(blob, durationMs, winSize) {
    const rd = makeWindowReader(blob, winSize || (1 << 18));
    const f = await scanWebM(rd);
    if (!f || f.clusters.length === 0) return blob;   // 头不合法 / 无 Cluster：原样返回

    const total = blob.size;
    const durVal = (durationMs * 1000000) / f.timecodeScale;

    /* 编辑 1：Duration 原位改写（Chrome 写了，宽 4/8）或插入（没写）——互斥 */
    const edits = [];
    if (f.durationDataOff < 0 && f.infoDefinite && f.infoDataEnd > 0) {
      const dv8 = new Uint8Array(8);
      new DataView(dv8.buffer).setFloat64(0, durVal);
      const durEl = concat(new Uint8Array(ID_BYTES.DURATION), new Uint8Array([0x88]), dv8);
      const newInfoSize = (f.infoDataEnd - f.infoDataStart) + durEl.byteLength;
      const capacity = Math.pow(2, 7 * f.infoSzLen) - 2;
      const newVintLen = newInfoSize <= capacity ? f.infoSzLen : f.infoSzLen + 1;
      edits.push({ off: f.infoSzOff, deleteLen: f.infoSzLen, insert: encodeVintSizeFixed(newInfoSize, newVintLen) });
      edits.push({ off: f.infoDataEnd, deleteLen: 0, insert: durEl });
    } else if (f.durationDataOff >= 0 && (f.durationDataLen === 8 || f.durationDataLen === 4)) {
      const b = new Uint8Array(f.durationDataLen);
      if (f.durationDataLen === 8) new DataView(b.buffer).setFloat64(0, durVal);
      else new DataView(b.buffer).setFloat32(0, durVal);
      edits.push({ off: f.durationDataOff, deleteLen: f.durationDataLen, insert: b });
    }

    /* 编辑 2：Cues。cluster 相对偏移先按头部编辑的净增量右移
       （编辑点都在 Info 一带，位于所有 Cluster 之前） */
    const headDelta = edits.reduce((s, e) => s + e.insert.byteLength - e.deleteLen, 0);
    const cuesData = buildCues(f.clusters.map(c => ({
      relativeOff: c.absoluteOff - f.segDataStart + headDelta,
      timecodeMs: c.timecodeMs,
    })));

    /* 编辑 3：Segment size（定长时原宽重写；容量不够则跳过，宁可不动不写坏） */
    if (!f.segSzUnknown) {
      const newSegSize = f.segSzVal + cuesData.byteLength + headDelta;
      const capacity = Math.pow(2, 7 * f.segSzLen) - 2;
      if (newSegSize <= capacity) {
        edits.push({ off: f.segSzOff, deleteLen: f.segSzLen, insert: encodeVintSizeFixed(newSegSize, f.segSzLen) });
      }
    }

    /* 编辑 4：Cues 追加到文件尾 */
    edits.push({ off: total, deleteLen: 0, insert: cuesData });

    /* 拼装：编辑点之间全部 Blob.slice 引用，编辑本体是 KB 级小数组 */
    edits.sort((a, b) => a.off - b.off);
    const parts = [];
    let cur = 0;
    for (const e of edits) {
      if (e.off > cur) parts.push(blob.slice(cur, e.off));
      parts.push(e.insert);
      cur = e.off + e.deleteLen;
    }
    if (cur < total) parts.push(blob.slice(cur));
    return new Blob(parts, { type: blob.type || 'video/webm' });
  }

  /* ═══════════════════════════════════════════════════════
     Public API
     ═══════════════════════════════════════════════════════ */

  async function fixWebMBlob(blob, durationMs) {
    if (!durationMs || durationMs <= 0) return blob;
    try {
      return await fixWebMStream(blob, durationMs);
    } catch (e) {
      console.error('WebM fix error:', e);
      return blob;
    }
  }

  G.fixWebMBlob = fixWebMBlob;
  // 仅供 e2e/unit-webmstream.mjs golden 对照（流式 vs 全量逐字节一致）。
  // 等价性验证一个版本周期后连同 fixWebM 一起删除。
  G._fixWebMFullBuffer = fixWebM;
  G._fixWebMStream = fixWebMStream;

})(self);
