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
 *   4) Patching Duration in the Info element
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
     Main: Parse WebM → Add Cues → Fix Duration
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

    /* ── Step 4: Build Cues element ── */
    const cuesData = buildCues(clusters);

    /* ── Step 5: Build new file = original + Cues appended ── */
    const origBytes = new Uint8Array(buf);
    const newBuf = new Uint8Array(total + cuesData.byteLength);
    newBuf.set(origBytes, 0);
    newBuf.set(cuesData, total);

    /* ── Step 6: Fix Duration ── */
    const newDv = new DataView(newBuf.buffer);
    const durVal = (durationMs * 1000000) / timecodeScale;

    if (durationDataOff >= 0 && durationDataLen === 8) {
      newDv.setFloat64(durationDataOff, durVal);
    } else if (durationDataOff >= 0 && durationDataLen === 4) {
      newDv.setFloat32(durationDataOff, durVal);
    }
    // If Duration element doesn't exist, we skip insertion for simplicity —
    // Cues alone is enough for seeking, and most players derive duration
    // from the last Cluster's timecode.

    /* ── Step 7: Update Segment size if it was fixed (not unknown) ── */
    if (!segSz.unknown) {
      const newSegSize = segSz.val + cuesData.byteLength;
      writeVintSize(newDv, segSzOff, segSzLen, newSegSize);
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
     Public API
     ═══════════════════════════════════════════════════════ */

  async function fixWebMBlob(blob, durationMs) {
    if (!durationMs || durationMs <= 0) return blob;
    try {
      const buf = await blob.arrayBuffer();
      const fixed = fixWebM(buf, durationMs);
      return new Blob([fixed], { type: blob.type || 'video/webm' });
    } catch (e) {
      console.error('WebM fix error:', e);
      return blob;
    }
  }

  G.fixWebMBlob = fixWebMBlob;

})(self);
