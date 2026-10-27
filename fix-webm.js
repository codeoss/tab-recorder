/**
 * fix-webm.js — v4
 *
 * Chrome's MediaRecorder outputs WebM files that:
 *   1) Have Duration = 0 or absent  → player shows "unknown length"
 *   2) Have no Cues, or Cues that do not reliably target video keyframes
 *   3) Have NO SeekHead             → Windows Media Foundation cannot discover Cues
 *
 * This module fixes these issues by:
 *   1) Scanning Cluster/block headers for verified video keyframes and timestamps
 *   2) Building a proper Cues element (seek index) and appending it at EOF
 *   3) Inserting a fixed-size SeekHead whose positions are relative to Segment data
 *   4) Patching Duration in the Info element — or INSERTING one when Chrome
 *      never wrote it (all head insertions are included in Cue/Seek positions)
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

  /** Fixed-width positions keep SeekHead's size independent of the file layout. */
  function encodeUintFixed(value, width) {
    const bytes = new Uint8Array(width);
    let v = value;
    for (let i = width - 1; i >= 0; i--) {
      bytes[i] = v & 0xFF;
      v = Math.floor(v / 256);
    }
    return bytes;
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
    TRACK_ENTRY:  0xAE,
    TRACK_NUMBER: 0xD7,
    TRACK_TYPE:   0x83,
    SIMPLE_BLOCK: 0xA3,
    BLOCK_GROUP:  0xA0,
    BLOCK:        0xA1,
    REFERENCE_BLOCK: 0xFB,
  };

  // Byte representations for writing
  const ID_BYTES = {
    INFO:          [0x15, 0x49, 0xA9, 0x66],
    TRACKS:        [0x16, 0x54, 0xAE, 0x6B],
    SEEKHEAD:      [0x11, 0x4D, 0x9B, 0x74],
    SEEK:          [0x4D, 0xBB],
    SEEKID:        [0x53, 0xAB],
    SEEKPOS:       [0x53, 0xAC],
    CUES:          [0x1C, 0x53, 0xBB, 0x6B],
    CUE_POINT:     [0xBB],
    CUE_TIME:      [0xB3],
    CUE_TRACK_POS: [0xB7],
    CUE_TRACK:     [0xF7],
    CUE_CLUSTER:   [0xF1],
    DURATION:      [0x44, 0x89],
  };

  function buildSeekHead(infoRel, tracksRel, cuesRel) {
    function entry(idBytes, position) {
      return encodeElement(ID_BYTES.SEEK, concat(
        encodeElement(ID_BYTES.SEEKID, new Uint8Array(idBytes)),
        encodeElement(ID_BYTES.SEEKPOS, encodeUintFixed(position, 8)),
      ));
    }
    return encodeElement(ID_BYTES.SEEKHEAD, concat(
      entry(ID_BYTES.INFO, infoRel),
      entry(ID_BYTES.TRACKS, tracksRel),
      entry(ID_BYTES.CUES, cuesRel),
    ));
  }

  function findVideoTrackSync(dv, start, end) {
    let pos = start;
    while (pos < end) {
      const id = readId(dv, pos);
      if (!id || id.id !== ID.TRACK_ENTRY) break;
      const sz = readSize(dv, pos + id.len);
      if (!sz || sz.unknown) break;
      const dataOff = pos + id.len + sz.len;
      const entryEnd = dataOff + sz.val;
      if (entryEnd > end) break;
      let number = 0, type = 0;
      for (let p = dataOff; p < entryEnd;) {
        const childId = readId(dv, p);
        const childSz = childId && readSize(dv, p + childId.len);
        if (!childId || !childSz || childSz.unknown) break;
        const childData = p + childId.len + childSz.len;
        if (childData + childSz.val > entryEnd) break;
        if (childId.id === ID.TRACK_NUMBER) number = readUint(dv, childData, childSz.val);
        if (childId.id === ID.TRACK_TYPE) type = readUint(dv, childData, childSz.val);
        p = childData + childSz.val;
      }
      if (type === 1) return number;
      pos = entryEnd;
    }
    return 0;
  }

  function blockHeaderSync(dv, off, end, videoTrack) {
    const track = readSize(dv, off);
    if (!track || track.unknown || off + track.len + 3 > end) return null;
    const flags = dv.getUint8(off + track.len + 2);
    if (track.val !== videoTrack || (flags & 0x06)) return null;
    return { relative: dv.getInt16(off + track.len), flags };
  }

  function findClusterKeyframeSync(dv, start, end, videoTrack) {
    let clusterTime = null;
    for (let pos = start; pos < end;) {
      const id = readId(dv, pos);
      if (!id || id.id === ID.CLUSTER || id.id === ID.CUES) break;
      const sz = readSize(dv, pos + id.len);
      if (!sz || sz.unknown) break;
      const dataOff = pos + id.len + sz.len;
      if (dataOff + sz.val > end) break;
      if (id.id === ID.TIMECODE) {
        if (sz.val < 1 || sz.val > 8) break;
        clusterTime = readUint(dv, dataOff, sz.val);
      } else if (id.id === ID.SIMPLE_BLOCK) {
        if (clusterTime === null) { pos = dataOff + sz.val; continue; }
        const block = blockHeaderSync(dv, dataOff, dataOff + sz.val, videoTrack);
        if (block && (block.flags & 0x80)) return clusterTime + block.relative;
      } else if (id.id === ID.BLOCK_GROUP) {
        if (clusterTime === null) { pos = dataOff + sz.val; continue; }
        const groupEnd = dataOff + sz.val;
        let referenced = false, candidate = null, complete = true, p = dataOff;
        for (; p < groupEnd;) {
          const childId = readId(dv, p);
          const childSz = childId && readSize(dv, p + childId.len);
          if (!childId || !childSz || childSz.unknown) { complete = false; break; }
          const childData = p + childId.len + childSz.len;
          if (childData + childSz.val > groupEnd) { complete = false; break; }
          if (childId.id === ID.REFERENCE_BLOCK) referenced = true;
          if (childId.id === ID.BLOCK) {
            const block = blockHeaderSync(dv, childData, childData + childSz.val, videoTrack);
            if (block) candidate = block.relative;
          }
          p = childData + childSz.val;
        }
        if (p !== groupEnd) complete = false;
        if (complete && candidate !== null && !referenced) return clusterTime + candidate;
        if (!complete) break;
      }
      pos = dataOff + sz.val;
    }
    return null;
  }

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
    let tracksOff = -1;               // Tracks element offset for SeekHead
    let infoSzOff = 0, infoSzLen = 0; // where Info's size VINT is, and its width
    let infoDataStart = 0;            // Info data begin
    let infoDataEnd = -1;             // Info data end (-1 if unknown size)
    let infoDefinite = false;         // Info written with a definite size
    let durationDataOff = -1;         // where Duration float is
    let durationDataLen = 0;
    let timecodeScale = 1000000;
    const clusters = [];              // Verified video keyframes only
    let videoTrack = 0;
    let lastClusterTimecode = -1;
    let cur = segDataStart;
    let infoSeen = false;             // phantom-Info guard: only the first clean Info counts

    // Structural validation of byte-scan candidates: kills same-bytes phantoms
    // in cluster payloads. A real Cluster's first child is Timecode (E7) with a
    // non-decreasing value; a real Cues' first child is CuePoint (BB).
    function validTopElementSync(elIdV, off) {
      const sz = readSize(dv, off + elIdV.len);
      if (!sz) return false;
      const dataOff = off + elIdV.len + sz.len;
      const childId = readId(dv, dataOff);
      if (!childId) return false;
      if (elIdV.id === ID.CLUSTER) {
        if (childId.id !== ID.TIMECODE) return false;
        const tcSz = readSize(dv, dataOff + childId.len);
        if (!tcSz || tcSz.unknown || tcSz.val < 1 || tcSz.val > 8) return false;
        const tc = readUint(dv, dataOff + childId.len + tcSz.len, tcSz.val);
        return lastClusterTimecode < 0 || tc >= lastClusterTimecode;
      }
      if (elIdV.id === ID.CUES) return childId.id === ID.CUE_POINT;
      return false;
    }

    while (cur < segEnd - 4) {
      const elId = readId(dv, cur);
      if (!elId) break;
      const szOff = cur + elId.len;
      const elSz = readSize(dv, szOff);
      if (!elSz) break;
      const dataOff = szOff + elSz.len;

      if (elId.id === ID.TRACKS) {
        tracksOff = cur;
        if (!videoTrack && !elSz.unknown) {
          videoTrack = findVideoTrackSync(dv, dataOff, Math.min(dataOff + elSz.val, total));
        }
      }

      if (elId.id === ID.INFO && !infoSeen) {
        // Only trust the FIRST Info, and only if it parses cleanly (well-formed
        // children filling it exactly, incl. TimecodeScale). A same-bytes
        // phantom inside Cluster payload fails this check — without it the
        // phantom overwrites the real Info and Duration gets inserted into
        // media data (this corrupted a real 632MB recording).
        infoSeen = true;
        infoOff = cur;
        infoLen = elId.len + elSz.len + (elSz.unknown ? 0 : elSz.val);
        const iSzOff = szOff, iSzLen = elSz.len;

        const infoEnd = elSz.unknown ? segEnd : Math.min(dataOff + elSz.val, total);
        let ic = dataOff, clean = !elSz.unknown, sawScale = false;
        let durOff = -1, durLen = 0, tcs = 1000000;
        while (clean && ic < infoEnd) {
          const cId = readId(dv, ic);
          if (!cId) { clean = false; break; }
          const cSzOff = ic + cId.len;
          const cSz = readSize(dv, cSzOff);
          if (!cSz || cSz.unknown) { clean = false; break; }
          const cData = cSzOff + cSz.len;
          if (cData + cSz.val > infoEnd) { clean = false; break; }

          if (cId.id === ID.TIMESCALE && cSz.val <= 4) {
            tcs = readUint(dv, cData, cSz.val);
            sawScale = true;
          }
          if (cId.id === ID.DURATION) {
            durOff = cData;
            durLen = cSz.val;
          }
          ic = cData + cSz.val;
        }
        if (clean && sawScale && ic === infoEnd) {
          infoSzOff = iSzOff;
          infoSzLen = iSzLen;
          infoDefinite = true;
          infoDataStart = dataOff;
          infoDataEnd = infoEnd;
          durationDataOff = durOff;
          durationDataLen = durLen;
          timecodeScale = tcs;
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

        lastClusterTimecode = timecodeMs;
        const keyframeTime = videoTrack
          ? findClusterKeyframeSync(dv, dataOff, clusterEnd, videoTrack) : null;
        const last = clusters[clusters.length - 1];
        if (keyframeTime !== null && keyframeTime >= 0 && (!last || keyframeTime >= last.timecodeMs)) {
          clusters.push({
            absoluteOff: cur,
            relativeOff: cur - segDataStart,
            timecodeMs: keyframeTime,
          });
        }

        // For unknown-size clusters, scan forward to find next top-level element
        if (elSz.unknown) {
          // Scan byte by byte for next Cluster or Cues. After clusters have
          // begun, Info/Tracks cannot legitimately appear (Chrome layout is
          // fixed) — and every candidate must pass structural validation, so
          // same-bytes phantoms in payloads no longer derail the scan.
          let scan = dataOff + 1;
          while (scan < segEnd - 4) {
            const peekId = readId(dv, scan);
            if (peekId && (peekId.id === ID.CLUSTER || peekId.id === ID.CUES)) {
              if (validTopElementSync(peekId, scan)) break;
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

    if (infoOff < 0 || tracksOff < 0) return buf;

    /* ── Step 5: Build Cues and a fixed-size SeekHead ── */
    const seekHeadLen = buildSeekHead(0, 0, 0).byteLength;
    const contentDelta = insertLen + seekHeadLen;
    const cuesData = buildCues(clusters.map(c => ({
      relativeOff: c.relativeOff + seekHeadLen,
      timecodeMs: c.timecodeMs,
    })), videoTrack);
    const seekHeadData = buildSeekHead(
      infoOff - segDataStart + seekHeadLen,
      tracksOff - segDataStart + contentDelta,
      total - segDataStart + contentDelta,
    );

    /* ── Step 6: Update Segment size, widening its VINT when required ── */
    let newSegVint = null;
    let segSizeDelta = 0;
    if (!segSz.unknown) {
      const newSegSize = segSz.val + contentDelta + cuesData.byteLength;
      let newSegSzLen = segSzLen;
      while (newSegSize > Math.pow(2, 7 * newSegSzLen) - 2) newSegSzLen++;
      newSegVint = encodeVintSizeFixed(newSegSize, newSegSzLen);
      segSizeDelta = newSegSzLen - segSzLen;
    }

    /* ── Step 7: Assemble [Segment header][SeekHead][Info..media][Cues] ── */
    const parts = [];
    if (newSegVint) {
      parts.push(
        new Uint8Array(buf, 0, segSzOff),
        newSegVint,
        new Uint8Array(buf, segSzOff + segSzLen, segDataStart - (segSzOff + segSzLen)),
      );
    } else {
      parts.push(new Uint8Array(buf, 0, segDataStart));
    }
    parts.push(seekHeadData);
    if (insertLen > 0) {
      parts.push(
        new Uint8Array(buf, segDataStart, infoSzOff - segDataStart),
        newInfoVint,
        new Uint8Array(buf, infoSzOff + infoSzLen, infoDataEnd - (infoSzOff + infoSzLen)),
        durEl,
        new Uint8Array(buf, infoDataEnd, total - infoDataEnd),
      );
    } else {
      parts.push(new Uint8Array(buf, segDataStart, total - segDataStart));
    }
    parts.push(cuesData);
    const newBuf = concat(...parts);

    /* ── Step 8: Patch Duration after the two possible head shifts ── */
    const newDv = new DataView(newBuf.buffer);
    const durationOff = durationDataOff + segSizeDelta + seekHeadLen;
    if (durationDataOff >= 0 && durationDataLen === 8) {
      newDv.setFloat64(durationOff, durVal);
    } else if (durationDataOff >= 0 && durationDataLen === 4) {
      newDv.setFloat32(durationOff, durVal);
    }

    return newBuf.buffer;
  }

  /* ═══════════════════════════════════════════════════════
     Build Cues Element
     ═══════════════════════════════════════════════════════ */

  function buildCues(clusters, videoTrack) {
    // Build CuePoint elements
    const cuePoints = [];
    for (const c of clusters) {
      const cueTrack = encodeElement(ID_BYTES.CUE_TRACK, encodeUint(videoTrack));
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

    // 同步快路径：窗口命中时与 readId 语义逐条一致；未命中/跨界返回 undefined
    // （调用方回退到 await readId）。unknown-size Cluster 前扫每字节都调它，
    // 没有这个快路径时每个字节都要付一次微任务开销（实测大文件慢 ~14 倍）
    function readIdSync(off) {
      if (off >= total) return null;
      if (off < winStart || off + 4 > winStart + win.byteLength) return undefined;
      const b = win[off - winStart];
      let len;
      if      (b & 0x80) len = 1;
      else if (b & 0x40) len = 2;
      else if (b & 0x20) len = 3;
      else if (b & 0x10) len = 4;
      else return null;
      if (off + len > total) return null;
      if (off + len > winStart + win.byteLength) return undefined;
      let id = 0;
      for (let i = 0; i < len; i++) id = (id << 8) | win[off - winStart + i];
      return { id: id >>> 0, len };
    }

    return { total, readId, readSize, readUint, readIdSync };
  }

  async function findVideoTrack(rd, start, end) {
    let pos = start;
    while (pos < end) {
      const id = await rd.readId(pos);
      if (!id || id.id !== ID.TRACK_ENTRY) break;
      const sz = await rd.readSize(pos + id.len);
      if (!sz || sz.unknown) break;
      const dataOff = pos + id.len + sz.len;
      const entryEnd = dataOff + sz.val;
      if (entryEnd > end) break;
      let number = 0, type = 0;
      for (let p = dataOff; p < entryEnd;) {
        const childId = await rd.readId(p);
        const childSz = childId && await rd.readSize(p + childId.len);
        if (!childId || !childSz || childSz.unknown) break;
        const childData = p + childId.len + childSz.len;
        if (childData + childSz.val > entryEnd) break;
        if (childId.id === ID.TRACK_NUMBER) number = await rd.readUint(childData, childSz.val);
        if (childId.id === ID.TRACK_TYPE) type = await rd.readUint(childData, childSz.val);
        p = childData + childSz.val;
      }
      if (type === 1) return number;
      pos = entryEnd;
    }
    return 0;
  }

  async function blockHeader(rd, off, end, videoTrack) {
    const track = await rd.readSize(off);
    if (!track || track.unknown || off + track.len + 3 > end) return null;
    const flags = await rd.readUint(off + track.len + 2, 1);
    if (track.val !== videoTrack || (flags & 0x06)) return null;
    const raw = await rd.readUint(off + track.len, 2);
    return { relative: raw & 0x8000 ? raw - 0x10000 : raw, flags };
  }

  async function findClusterKeyframe(rd, start, end, videoTrack) {
    let clusterTime = null;
    for (let pos = start; pos < end;) {
      const id = await rd.readId(pos);
      if (!id || id.id === ID.CLUSTER || id.id === ID.CUES) break;
      const sz = await rd.readSize(pos + id.len);
      if (!sz || sz.unknown) break;
      const dataOff = pos + id.len + sz.len;
      if (dataOff + sz.val > end) break;
      if (id.id === ID.TIMECODE) {
        if (sz.val < 1 || sz.val > 8) break;
        clusterTime = await rd.readUint(dataOff, sz.val);
      } else if (id.id === ID.SIMPLE_BLOCK) {
        if (clusterTime === null) { pos = dataOff + sz.val; continue; }
        const block = await blockHeader(rd, dataOff, dataOff + sz.val, videoTrack);
        if (block && (block.flags & 0x80)) return clusterTime + block.relative;
      } else if (id.id === ID.BLOCK_GROUP) {
        if (clusterTime === null) { pos = dataOff + sz.val; continue; }
        const groupEnd = dataOff + sz.val;
        let referenced = false, candidate = null, complete = true, p = dataOff;
        for (; p < groupEnd;) {
          const childId = await rd.readId(p);
          const childSz = childId && await rd.readSize(p + childId.len);
          if (!childId || !childSz || childSz.unknown) { complete = false; break; }
          const childData = p + childId.len + childSz.len;
          if (childData + childSz.val > groupEnd) { complete = false; break; }
          if (childId.id === ID.REFERENCE_BLOCK) referenced = true;
          if (childId.id === ID.BLOCK) {
            const block = await blockHeader(rd, childData, childData + childSz.val, videoTrack);
            if (block) candidate = block.relative;
          }
          p = childData + childSz.val;
        }
        if (p !== groupEnd) complete = false;
        if (complete && candidate !== null && !referenced) return clusterTime + candidate;
        if (!complete) break;
      }
      pos = dataOff + sz.val;
    }
    return null;
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
      infoOff: -1, tracksOff: -1,
      infoSzOff: 0, infoSzLen: 0, infoDefinite: false, infoDataStart: 0, infoDataEnd: -1,
      durationDataOff: -1, durationDataLen: 0,
      timecodeScale: 1000000,
      videoTrack: 0,
      clusters: [],   // Verified video keyframes only
    };
    let lastClusterTimecode = -1;
    let infoSeen = false;   // 幻影 Info 防护：只采信第一个且解析干净的 Info

    // 候选顶层元素的结构校验：挡掉负载里的同字节幻影。
    // 真 Cluster 首子元素必是 Timecode(E7) 且时间码单调不降；真 Cues 首子是 CuePoint(BB)
    async function validTopElement(elId, off) {
      const sz = await rd.readSize(off + elId.len);
      if (!sz) return false;
      const dataOff = off + elId.len + sz.len;
      const childId = await rd.readId(dataOff);
      if (!childId) return false;
      if (elId.id === ID.CLUSTER) {
        if (childId.id !== ID.TIMECODE) return false;
        const tcSz = await rd.readSize(dataOff + childId.len);
        if (!tcSz || tcSz.unknown || tcSz.val < 1 || tcSz.val > 8) return false;
        const tc = await rd.readUint(dataOff + childId.len + tcSz.len, tcSz.val);
        return lastClusterTimecode < 0 || tc >= lastClusterTimecode;
      }
      if (elId.id === ID.CUES) return childId.id === ID.CUE_POINT;
      return false;
    }

    let cur = segDataStart;
    while (cur < segEnd - 4) {
      const elId = await rd.readId(cur);
      if (!elId) break;
      const szOff = cur + elId.len;
      const elSz = await rd.readSize(szOff);
      if (!elSz) break;
      const dataOff = szOff + elSz.len;

      if (elId.id === ID.TRACKS) {
        f.tracksOff = cur;
        if (!f.videoTrack && !elSz.unknown) {
          f.videoTrack = await findVideoTrack(rd, dataOff, Math.min(dataOff + elSz.val, total));
        }
      }

      if (elId.id === ID.INFO && !infoSeen) {
        // 只采信第一个 Info，且必须「解析干净」：子元素全部合法、恰好占满、
        // 含 TimecodeScale。Cluster 负载里的同字节幻影（1549A966 出现在媒体
        // 数据里）通不过这个校验——否则幻影会覆盖真实 Info，导致 Duration
        // 被插进媒体数据、正文被改写（实测踩坑，毁了一个 632MB 文件）
        infoSeen = true;   // 无论通过与否都只试第一个（Chrome 布局里真 Info 是第一个子元素）
        const infoEnd = elSz.unknown ? segEnd : Math.min(dataOff + elSz.val, total);
        const iSzOff = szOff, iSzLen = elSz.len;
        let ic = dataOff, clean = !elSz.unknown, sawScale = false;
        let durOff = -1, durLen = 0;
        while (clean && ic < infoEnd) {
          const cId = await rd.readId(ic);
          if (!cId) { clean = false; break; }
          const cSz = await rd.readSize(ic + cId.len);
          if (!cSz || cSz.unknown) { clean = false; break; }
          const cData = ic + cId.len + cSz.len;
          if (cData + cSz.val > infoEnd) { clean = false; break; }
          if (cId.id === ID.TIMESCALE && cSz.val <= 4) {
            f.timecodeScale = await rd.readUint(cData, cSz.val);
            sawScale = true;
          }
          if (cId.id === ID.DURATION) { durOff = cData; durLen = cSz.val; }
          ic = cData + cSz.val;
        }
        if (clean && sawScale && ic === infoEnd) {
          f.infoOff = cur;
          f.infoSzOff = iSzOff; f.infoSzLen = iSzLen;
          f.infoDefinite = true; f.infoDataStart = dataOff; f.infoDataEnd = infoEnd;
          f.durationDataOff = durOff; f.durationDataLen = durLen;
        }
      }

      if (elId.id === ID.CLUSTER) {
        const tcId = await rd.readId(dataOff);
        let timecodeMs = 0;
        if (tcId && tcId.id === ID.TIMECODE) {
          const tcSz = await rd.readSize(dataOff + tcId.len);
          if (tcSz) timecodeMs = await rd.readUint(dataOff + tcId.len + tcSz.len, tcSz.val);
        }
        lastClusterTimecode = timecodeMs;
        const clusterEnd = elSz.unknown ? segEnd : Math.min(dataOff + elSz.val, total);
        const keyframeTime = f.videoTrack
          ? await findClusterKeyframe(rd, dataOff, clusterEnd, f.videoTrack) : null;
        const last = f.clusters[f.clusters.length - 1];
        if (keyframeTime !== null && keyframeTime >= 0 && (!last || keyframeTime >= last.timecodeMs)) {
          f.clusters.push({ absoluteOff: cur, timecodeMs: keyframeTime });
        }

        if (elSz.unknown) {
          let scan = dataOff + 1;
          while (scan < segEnd - 4) {
            // 同步快路径优先：窗口命中时不付微任务开销；跨窗口才 await 物化
            let peekId = rd.readIdSync(scan);
            if (peekId === undefined) peekId = await rd.readId(scan);
            // 已开始收 Cluster 后，Info/Tracks 不可能合法出现（Chrome 布局固定）；
            // 只认 CLUSTER/CUES 且必须过结构校验——负载里的同字节幻影不再误判
            if (peekId && (peekId.id === ID.CLUSTER || peekId.id === ID.CUES)) {
              if (await validTopElement(peekId, scan)) break;
            }
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

    if (f.infoOff < 0 || f.tracksOff < 0) return blob;

    /* 编辑 2：固定长度 SeekHead + Cues；相对偏移不含 Segment size 字段加宽量 */
    const durationDelta = edits.reduce((s, e) => s + e.insert.byteLength - e.deleteLen, 0);
    const seekHeadLen = buildSeekHead(0, 0, 0).byteLength;
    const contentDelta = durationDelta + seekHeadLen;
    const cuesData = buildCues(f.clusters.map(c => ({
      relativeOff: c.absoluteOff - f.segDataStart + contentDelta,
      timecodeMs: c.timecodeMs,
    })), f.videoTrack);
    const seekHeadData = buildSeekHead(
      f.infoOff - f.segDataStart + seekHeadLen,
      f.tracksOff - f.segDataStart + contentDelta,
      total - f.segDataStart + contentDelta,
    );
    edits.push({ off: f.segDataStart, deleteLen: 0, insert: seekHeadData });

    /* 编辑 3：定长 Segment 更新 size；容量不足时加宽 VINT 而不是保留错误尺寸 */
    if (!f.segSzUnknown) {
      const newSegSize = f.segSzVal + contentDelta + cuesData.byteLength;
      let newSegSzLen = f.segSzLen;
      while (newSegSize > Math.pow(2, 7 * newSegSzLen) - 2) newSegSzLen++;
      edits.push({ off: f.segSzOff, deleteLen: f.segSzLen, insert: encodeVintSizeFixed(newSegSize, newSegSzLen) });
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
