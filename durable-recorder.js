/**
 * durable-recorder.js — MediaRecorder 分片到 OPFS Worker 的有界适配器。
 * 主侧只保留少量待写分片；确认字节严格来自 Worker 完整写入并 flush 后的回复。
 * 写入失败保留已确认前缀，finalize 会把未确认尾部长度截去，供恢复链使用。
 */
(function (G) {
  'use strict';

  const MAX_PENDING_CHUNKS = 4;
  const MAX_PENDING_BYTES = 32 * 1024 * 1024;

  async function createDurableWriter({ id, mime, onMetadata }) {
    const worker = new Worker('durable-writer-worker.js');
    const requests = new Map();
    let sequence = 0;
    let state = 'open';
    let workerFailed = null;
    let pendingChunks = 0;
    let pendingBytes = 0;
    let tail = Promise.resolve();
    let finalizePromise = null;
    const metadata = (typeof onMetadata === 'function') ? onMetadata : () => {};

    function request(type, extra = {}, transfer = []) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        requests.set(id, { resolve, reject });
        worker.postMessage({ type, id, ...extra }, transfer);
      });
    }

    worker.onmessage = event => {
      const msg = event.data || {};
      const pending = requests.get(msg.id);
      if (!pending) return;
      requests.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg);
    };
    worker.onerror = event => {
      workerFailed = new Error(event.message || 'OPFS Worker failed');
      for (const pending of requests.values()) pending.reject(workerFailed);
      requests.clear();
    };

    const writer = {
      worker,
      bytes: 0,
      append(blob, mediaTimeMs) {
        if (state === 'discarded') return Promise.reject(new Error('Writer discarded'));
        if (state !== 'open') return Promise.reject(new Error(`Writer is ${state}`));
        if (pendingChunks >= MAX_PENDING_CHUNKS) {
          return Promise.reject(new Error('Durable write queue is full'));
        }
        if (pendingBytes + blob.size > MAX_PENDING_BYTES) {
          return Promise.reject(new Error('Durable write queue exceeds 32 MiB'));
        }
        pendingChunks++;
        pendingBytes += blob.size;
        const job = tail.then(async () => {
          if (state !== 'open') throw new Error(`Writer is ${state}`);
          const buffer = await blob.arrayBuffer();
          const result = await request('append', { buffer }, [buffer]);
          writer.bytes = result.bytes;
          await metadata({ id, mime, bytes: writer.bytes, mediaTimeMs, phase: 'recording' });
        }).catch(error => {
          if (state === 'open') state = 'error';
          throw error;
        }).finally(() => {
          pendingChunks--;
          pendingBytes -= blob.size;
        });
        tail = job.catch(() => {});
        return job;
      },
      finalize() {
        if (finalizePromise) return finalizePromise;
        finalizePromise = (async () => {
          await tail;
          if (workerFailed) throw workerFailed;
          const result = await request('finalize');
          writer.bytes = result.bytes;
          state = 'finalized';
          await metadata({ id, mime, bytes: writer.bytes, phase: 'processing' });
          return result.file;
        })();
        return finalizePromise;
      },
      async discard() {
        if (state === 'discarded') return;
        state = 'discarded';
        await tail;
        let failure = workerFailed;
        try {
          if (!failure) await request('discard');
        } catch (error) { failure = error; }
        try {
          if (failure) {
            const root = await navigator.storage.getDirectory();
            try { await root.removeEntry(`tab-record-${id}.media`); }
            catch (error) { if (error.name !== 'NotFoundError') throw error; }
          }
        } finally {
          worker.terminate();
        }
      },
    };

    try {
      await request('open', { recordingId: id, mime });
      await metadata({ id, mime, fileName: `tab-record-${id}.media`, bytes: 0, mediaTimeMs: 0, phase: 'recording' });
      return writer;
    } catch (error) {
      try { await request('discard'); } catch (_) {}
      worker.terminate();
      throw error;
    }
  }

  G.createDurableWriter = createDurableWriter;
})(self);
