import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function ok(name, condition, extra = '') {
  console.log(`${condition ? '  ✅' : '  ❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!condition) failed++;
}

function fakeStorage() {
  const files = new Map();
  const handles = [];
  const root = {
    async getFileHandle(name, options = {}) {
      if (!files.has(name) && !options.create) throw new Error('NotFoundError');
      if (!files.has(name)) files.set(name, { name, bytes: new Uint8Array(0), mime: '' });
      const file = files.get(name);
      const handle = {
        flushed: 0,
        closed: false,
        shortWriteOnce: false,
        async createSyncAccessHandle() {
          const sync = {
            write(chunk, { at }) {
              const source = new Uint8Array(chunk.buffer || chunk, chunk.byteOffset || 0, chunk.byteLength);
              const required = at + source.length;
              const next = new Uint8Array(required);
              next.set(file.bytes.subarray(0, Math.min(file.bytes.length, required)));
              next.set(source, at);
              file.bytes = next;
              if (sync.shortWriteOnce) {
                sync.shortWriteOnce = false;
                return source.length - 1;
              }
              return source.length;
            },
            flush() { handle.flushed++; },
            truncate(size) { file.bytes = file.bytes.slice(0, size); },
            close() { handle.closed = true; },
          };
          Object.defineProperty(handle, 'sync', { value: sync });
          return sync;
        },
        async getFile() { return new File([file.bytes], name, { type: file.mime }); },
      };
      handles.push(handle);
      return handle;
    },
    async removeEntry(name) {
      if (!files.delete(name)) throw new Error('NotFoundError');
    },
  };
  return { root, files, handles };
}

class FakeWorker {
  constructor() {
    const storage = fakeStorage();
    this.storage = storage;
    const workerSelf = {
      postMessage: data => queueMicrotask(() => this.onmessage?.({ data })),
    };
    this.context = vm.createContext({
      self: workerSelf,
      navigator: { storage: { getDirectory: async () => storage.root } },
      Uint8Array, File, console,
    });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'durable-writer-worker.js'), 'utf8'), this.context);
    this.workerSelf = workerSelf;
  }
  postMessage(data) {
    Promise.resolve(this.workerSelf.onmessage?.({ data })).catch(error => {
      this.onerror?.({ message: error.message });
    });
  }
  terminate() { this.terminated = true; }
}

globalThis.self = globalThis;
globalThis.Worker = FakeWorker;
await import(pathToFileURL(path.join(ROOT, 'durable-recorder.js')).href);
const { createDurableWriter } = globalThis;

{
  const metadata = [];
  const writer = await createDurableWriter({ id: '7', mime: 'video/webm', onMetadata: patch => metadata.push(patch) });
  await Promise.all([
    writer.append(new Blob(['abc']), 100),
    writer.append(new Blob(['def']), 200),
  ]);
  ok('并发 append 仍按顺序持久化', writer.bytes === 6 && metadata.at(-1)?.bytes === 6);
  const file = await writer.finalize();
  ok('finalize 返回完整 File', await file.text() === 'abcdef' && file.type === 'video/webm');
  ok('每个分片和 finalize 都 flush', writer.worker.storage.handles[0].flushed === 4);
  ok('finalize 幂等', await writer.finalize() === file);
  ok('元数据包含稳定文件名和阶段', metadata[0].fileName === 'tab-record-7.media' && metadata.at(-1).phase === 'processing');
  ok('finalize 后 Worker 仍可执行清理', writer.worker.terminated !== true);
  await writer.discard();
  ok('下载后的暂存文件可删除', !writer.worker.storage.files.has('tab-record-7.media'));
}

{
  const writer = await createDurableWriter({ id: 'backpressure', mime: 'video/webm' });
  const writes = Array.from({ length: 4 }, (_, i) => writer.append(new Blob([String(i)]), i));
  const fifth = await writer.append(new Blob(['5']), 5).then(() => '', error => error.message);
  await Promise.all(writes);
  ok('第 5 个未确认分片被背压拒绝', fifth.includes('queue'));
  const oversized = await writer.append({ size: 33 * 1024 * 1024 }, 6).then(() => '', error => error.message);
  ok('超过 32 MiB 的待写数据被拒绝', oversized.includes('32'));
  await writer.discard();
}

{
  const writer = await createDurableWriter({ id: 'short', mime: 'video/webm' });
  const worker = writer.worker;
  const handle = worker.storage.handles[0];
  handle.sync.shortWriteOnce = true;
  const error = await writer.append(new Blob(['abcdef']), 100).then(() => '', value => value.message);
  ok('短写向上报告且不确认字节', error.includes('short write') && writer.bytes === 0);
  const file = await writer.finalize();
  ok('短写后 finalize 只保留确认前缀', file.size === 0 && handle.closed);
}

{
  const writer = await createDurableWriter({ id: 'discard', mime: 'video/webm' });
  await writer.append(new Blob(['data']), 100);
  await writer.discard();
  ok('discard 删除对应 OPFS 文件', !writer.worker.storage.files.has('tab-record-discard.media'));
  const error = await writer.append(new Blob(['x']), 101).then(() => '', value => value.message);
  ok('discard 后拒绝继续写入', error.includes('discarded'));
}

{
  const writer = await createDurableWriter({ id: 'crash', mime: 'video/webm' });
  await writer.append(new Blob(['data']), 100);
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    storage: { getDirectory: async () => writer.worker.storage.root },
  } });
  writer.worker.onerror({ message: 'WORKER_CRASH' });
  await writer.discard();
  ok('Worker 崩溃后仍删除 OPFS 孤儿文件', !writer.worker.storage.files.has('tab-record-crash.media'));
}

console.log(failed ? `\n${failed} 项失败 ❌` : '\n持续暂存测试全部通过 🎉');
process.exit(failed ? 1 : 0);
