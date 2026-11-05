/**
 * recovery.js — 从 OPFS 恢复异常中断的录制。
 * 原始 File 只读；WebM 先按最后确认字节截去不完整尾部，再走既有索引修复。
 * 原生 MP4 保持现有 faststart/时长修复与 wasm 兜底，不经过 EBML 逻辑。
 */
(function (G) {
  'use strict';

  async function readDurableFile(metadata) {
    if (!metadata || !metadata.fileName) throw new Error('恢复元数据缺少文件名');
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(metadata.fileName);
    return await handle.getFile();
  }

  function confirmedSize(raw, value) {
    const confirmed = Number(value);
    if (!Number.isSafeInteger(confirmed) || confirmed < 0 || confirmed > raw.size) {
      throw new Error('确认字节边界无效');
    }
    if (confirmed === 0) throw new Error('没有已确认的媒体数据');
    return confirmed;
  }

  async function recoverMp4Prefix(raw, confirmedBytes) {
    const total = confirmedSize(raw, confirmedBytes);
    let offset = 0;
    let pendingMoof = false;
    let lastCompleteEnd = 0;
    while (offset < total) {
      if (offset + 8 > total) break;
      const head = new Uint8Array(await raw.slice(offset, Math.min(offset + 16, total)).arrayBuffer());
      const view = new DataView(head.buffer);
      let size = view.getUint32(0);
      let headerSize = 8;
      if (size === 1) {
        if (head.length < 16) break;
        size = view.getUint32(8) * 4294967296 + view.getUint32(12);
        headerSize = 16;
      }
      const type = String.fromCharCode(...head.subarray(4, 8));
      if (size === 0) {
        if (type === 'mdat' && pendingMoof && total > offset + headerSize) lastCompleteEnd = total;
        offset = total;
        break;
      }
      if (size < headerSize || offset + size > total) break;
      if (type === 'moof') pendingMoof = true;
      else if (type === 'mdat') {
        if (pendingMoof && size > headerSize) lastCompleteEnd = offset + size;
        pendingMoof = false;
      } else pendingMoof = false;
      offset += size;
    }
    if (!lastCompleteEnd) throw new Error('没有可恢复的媒体数据');
    return raw.slice(0, lastCompleteEnd, raw.type || 'video/mp4');
  }

  async function recoverDurableBlob(metadata) {
    let raw = await readDurableFile(metadata);
    const confirmed = confirmedSize(raw, metadata.bytes);
    const durMs = Math.max(1, Number(metadata.mediaTimeMs) || 0);
    const date = new Date(Number(metadata.startedAt) || Date.now());
    const ts = date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let blob = raw;
    let filename = `TabRecord_${ts}.webm`;

    if (metadata.recordedIsMp4) {
      filename = `TabRecord_${ts}.mp4`;
      raw = await recoverMp4Prefix(raw, metadata.bytes);
      blob = raw;
      try {
        blob = await mp4FaststartJs(raw);
      } catch (firstError) {
        try { blob = await mp4Faststart(raw); }
        catch (secondError) { console.warn('MP4 recovery faststart failed:', firstError, secondError); }
      }
    } else {
      blob = await fixWebMRecoveryBlob(raw, durMs, confirmed);
      if (metadata.outputFormat === 'mp4') {
        try {
          blob = await webmToMp4(blob);
          filename = `TabRecord_${ts}.mp4`;
        } catch (error) { console.warn('Recovery transcode failed, keeping WebM:', error); }
      }
    }
    return { blob, filename, durMs };
  }

  async function deleteDurableFile(metadata) {
    if (!metadata || !metadata.fileName) return;
    const root = await navigator.storage.getDirectory();
    try { await root.removeEntry(metadata.fileName); }
    catch (error) { if (error.name !== 'NotFoundError') throw error; }
  }

  G.recoverDurableBlob = recoverDurableBlob;
  G.recoverMp4Blob = recoverMp4Prefix;
  G.deleteDurableFile = deleteDurableFile;
})(self);
