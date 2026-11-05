/**
 * durable-writer-worker.js — OPFS 同步追加工人。
 * 普通 createWritable 未关闭时可能一个字节都不提交，因此崩溃暂存必须在
 * Worker 中使用 sync access handle。只有完整写入并 flush 的分片才确认偏移。
 * 本上下文没有 chrome.* API；文件名与 MIME 全由主侧传入。
 */
'use strict';

let root = null;
let fileHandle = null;
let handle = null;
let fileName = '';
let mime = '';
let offset = 0;

self.onmessage = async event => {
  const msg = event.data || {};
  const id = msg.id;
  try {
    if (msg.type === 'open') {
      if (handle || fileHandle) throw new Error('Writer already open');
      fileName = `tab-record-${msg.recordingId}.media`;
      mime = msg.mime || '';
      root = await navigator.storage.getDirectory();
      fileHandle = await root.getFileHandle(fileName, { create: true });
      handle = await fileHandle.createSyncAccessHandle();
      handle.truncate(0);
      handle.flush();
      self.postMessage({ id, bytes: 0 });
      return;
    }
    if (msg.type === 'append') {
      if (!handle) throw new Error('Writer is not open');
      const buffer = msg.buffer;
      const written = handle.write(new Uint8Array(buffer), { at: offset });
      if (written !== buffer.byteLength) throw new Error('OPFS short write');
      offset += written;
      handle.flush();
      self.postMessage({ id, bytes: offset });
      return;
    }
    if (msg.type === 'finalize') {
      if (!handle || !fileHandle) throw new Error('Writer is not open');
      handle.truncate(offset);
      handle.flush();
      handle.close();
      handle = null;
      const file = await fileHandle.getFile();
      const typed = file.type === mime ? file : new File([file], fileName, { type: mime });
      self.postMessage({ id, file: typed, bytes: offset });
      return;
    }
    if (msg.type === 'discard') {
      if (handle) { handle.close(); handle = null; }
      if (root && fileName) await root.removeEntry(fileName);
      fileHandle = null;
      self.postMessage({ id, discarded: true });
    }
  } catch (error) {
    self.postMessage({ id, error: error.message || String(error) });
  }
};
