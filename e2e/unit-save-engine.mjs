/**
 * 用可控 saveFile Promise 驱动真实录制引擎，验证下载完成前不伪造成功、
 * 真实文件名、失败保持忙态、重试不重复修复，以及明确丢弃后的资源释放。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

globalThis.self = globalThis;
let fixCalls = 0;
globalThis.fixWebMBlob = async blob => { fixCalls++; return blob; };
globalThis.fixWebMRecoveryBlob = async blob => { fixCalls++; return blob; };
globalThis.mp4FaststartJs = async blob => blob;
globalThis.mp4Faststart = async blob => blob;
globalThis.webmToMp4 = async blob => blob;
globalThis.document = {
  createElement: () => ({ click() {} }),
};

const durableWriters = [];
globalThis.createDurableWriter = async ({ id, mime, onMetadata }) => {
  const parts = [];
  let failed = null;
  let finalized = null;
  const writer = {
    bytes: 0,
    discarded: false,
    async append(blob, mediaTimeMs) {
      if (failed) throw failed;
      if (writer.failWith) { failed = writer.failWith; throw failed; }
      if (writer.appendHold) await writer.appendHold;
      parts.push(blob);
      writer.bytes += blob.size;
      await onMetadata({ id, mime, bytes: writer.bytes, mediaTimeMs, phase: 'recording' });
    },
    async finalize() {
      if (finalized) return finalized;
      if (writer.finalizeError) throw writer.finalizeError;
      if (writer.finalizeHold) await writer.finalizeHold;
      finalized = new File(parts, `tab-record-${id}.media`, { type: mime });
      await onMetadata({ id, mime, bytes: writer.bytes, phase: 'processing' });
      return finalized;
    },
    async discard() {
      if (writer.appendHold) await writer.appendHold;
      if (writer.discardError) throw writer.discardError;
      writer.discarded = true; parts.length = 0;
    },
  };
  durableWriters.push(writer);
  return writer;
};

let lastRecorder;
class FakeMediaRecorder {
  static isTypeSupported(type) { return type.startsWith('video/webm'); }
  constructor() { this.state = 'inactive'; lastRecorder = this; }
  start() { this.state = 'recording'; }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['encoded']) });
      this.onstop?.();
    });
  }
}
globalThis.MediaRecorder = FakeMediaRecorder;

await import(pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../core-recorder.js')).href);
const { createRecorderEngine } = globalThis;

let failed = 0;
function ok(name, condition, extra = '') {
  console.log(`${condition ? '  ✅' : '  ❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!condition) failed++;
}
function stream() {
  return { getTracks: () => [{ kind: 'video', addEventListener() {}, stop() {} }] };
}
async function waitFor(predicate, timeout = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('等待引擎状态超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function engineWith(saveFile) {
  const events = [];
  const engine = createRecorderEngine({
    getStream: async () => stream(),
    onEvent: (name, data) => events.push({ name, data }),
    releaseExtra() {},
    saveFile,
  });
  return { engine, events };
}
function successEvents(events) {
  return events.filter(x => x.name === 'saved' || x.name === 'stopped' || x.name === 'processing');
}

{
  const calls = [];
  let resolveDownload;
  const { engine, events } = engineWith((blob, filename) => {
    calls.push({ blob, filename });
    return new Promise(resolve => { resolveDownload = resolve; });
  });
  await engine.start({ outputFormat: 'webm' });
  engine.stop();
  ok('stop 同步进入 busy（onstop 尚未到达）', engine.isBusy());
  await waitFor(() => calls.length === 1 || events.some(x =>
    x.name === 'saved' || x.name === 'stopped' || x.name === 'saveerror'));
  ok('下载未决时不发 saved/stopped/processing=false',
     engine.isBusy() && !successEvents(events).some(x => x.name === 'saved' || x.name === 'stopped') &&
     !events.some(x => x.name === 'processing' && x.data?.active === false));
  const restarted = await engine.start({ outputFormat: 'webm' });
  ok('下载未决时重复 start 被拒绝', restarted === false);
  if (restarted) engine.discard();

  resolveDownload?.({ filename: 'a (1).webm', path: 'C:/Downloads/a (1).webm' });
  await waitFor(() => !engine.isBusy());
  const saved = events.find(x => x.name === 'saved');
  const stopped = events.find(x => x.name === 'stopped');
  ok('complete 后 saved/history 使用真实文件名', saved?.data?.filename === 'a (1).webm' &&
     stopped?.data?.historyEntry?.filename === 'a (1).webm');
  ok('成功收尾包含 processing=false', events.some(x => x.name === 'processing' && x.data?.active === false));
}

{
  const calls = [];
  const { engine, events } = engineWith((blob, filename) => {
    calls.push({ blob, filename });
    return calls.length === 1
      ? Promise.reject(new Error('FILE_NO_SPACE'))
      : Promise.resolve({ filename: 'retry.webm', path: 'C:/Downloads/retry.webm' });
  });
  await engine.start({ outputFormat: 'webm' });
  engine.stop();
  await waitFor(() => calls.length === 1 || events.some(x =>
    x.name === 'saved' || x.name === 'stopped' || x.name === 'saveerror'));
  ok('下载失败保留忙态且不发成功历史', engine.isBusy() &&
     !events.some(x => x.name === 'stopped' && x.data?.historyEntry));
  ok('失败发出 saveerror', events.some(x => x.name === 'saveerror' && x.data?.message?.includes('FILE_NO_SPACE')));
  ok('retrySave 接口存在', typeof engine.retrySave === 'function');
  if (typeof engine.retrySave === 'function') {
    const beforeFix = fixCalls;
    const retried = await engine.retrySave();
    ok('重试成功且不重复修复', retried === true && calls.length === 2 && fixCalls === beforeFix &&
       calls[0].blob === calls[1].blob && !engine.isBusy());
    ok('重试使用成功文件名', events.find(x => x.name === 'saved')?.data?.filename === 'retry.webm');
  }
}

{
  const calls = [];
  const { engine, events } = engineWith((blob, filename) => {
    calls.push({ blob, filename });
    return Promise.reject(new Error('USER_CANCELED'));
  });
  await engine.start({ outputFormat: 'webm' });
  engine.stop();
  await waitFor(() => calls.length === 1 || events.some(x =>
    x.name === 'saved' || x.name === 'stopped' || x.name === 'saveerror'));
  await engine.discard();
  const stopped = events.find(x => x.name === 'stopped' && x.data?.discarded === true);
  ok('失败后明确丢弃释放忙态', !!stopped && !engine.isBusy());
  ok('丢弃不写成功历史且不再下载', !events.some(x => x.name === 'saved') && calls.length === 1);
  if (typeof engine.retrySave === 'function') {
    ok('丢弃后不能重试', (await engine.retrySave()) === false && calls.length === 1);
  }
}

{
  const calls = [];
  const { engine } = engineWith(async blob => {
    calls.push(blob);
    return { filename: 'durable.webm', path: 'C:/Downloads/durable.webm' };
  });
  const before = durableWriters.length;
  await engine.start({ outputFormat: 'webm' });
  const writer = durableWriters[before];
  lastRecorder.ondataavailable({ data: new Blob(['first']) });
  await waitFor(() => writer.bytes === 5);
  engine.stop();
  await waitFor(() => !engine.isBusy());
  ok('正常停止保存 writer 的完整 File',
    calls[0] instanceof File && await calls[0].text() === 'firstencoded');
}

{
  const { engine } = engineWith(async () => ({ filename: 'unused.webm' }));
  const before = durableWriters.length;
  await engine.start({ outputFormat: 'webm' });
  const writer = durableWriters[before];
  await engine.discard();
  ok('录制中明确丢弃会删除暂存', writer.discarded && !engine.isBusy());
}

{
  const calls = [];
  const { engine, events } = engineWith(async blob => {
    calls.push(blob);
    return { filename: 'confirmed-prefix.webm', path: 'C:/Downloads/confirmed-prefix.webm' };
  });
  const before = durableWriters.length;
  await engine.start({ outputFormat: 'webm' });
  const writer = durableWriters[before];
  lastRecorder.ondataavailable({ data: new Blob(['first']) });
  await waitFor(() => writer.bytes === 5);
  writer.failWith = new Error('OPFS_FULL');
  lastRecorder.ondataavailable({ data: new Blob(['unconfirmed']) });
  await waitFor(() => !engine.isBusy());
  ok('暂存失败有可见错误', events.some(event =>
    event.name === 'saveerror' && event.data?.message?.includes('OPFS_FULL')));
  ok('暂存失败只下载已确认前缀',
    calls[0] instanceof File && await calls[0].text() === 'first');
}

{
  const originalFactory = globalThis.createDurableWriter;
  globalThis.createDurableWriter = async () => { throw new Error('OPFS_UNAVAILABLE'); };
  let stopped = false;
  const isolated = createRecorderEngine({
    getStream: async () => ({ getTracks: () => [{ stop() { stopped = true; } }] }),
    saveFile: async () => ({ filename: 'unused.webm' }),
  });
  let error = '';
  try { await isolated.start({ outputFormat: 'webm' }); } catch (value) { error = value.message; }
  ok('OPFS 初始化失败释放媒体流且不进入录制', error.includes('OPFS_UNAVAILABLE') && stopped && !isolated.isBusy());
  globalThis.createDurableWriter = originalFactory;
}

{
  const originalFactory = globalThis.createDurableWriter;
  let resolveWriter;
  let discarded = false;
  const writer = { bytes: 0, async discard() { discarded = true; } };
  globalThis.createDurableWriter = () => new Promise(resolve => { resolveWriter = resolve; });
  const { engine } = engineWith(async () => ({ filename: 'unused.webm' }));
  const recorderBefore = lastRecorder;
  const starting = engine.start({ outputFormat: 'webm' });
  await waitFor(() => !!resolveWriter);
  engine.stop();
  resolveWriter(writer);
  const started = await starting;
  ok('OPFS 初始化途中取消不会启动幽灵录制', started === false && discarded && lastRecorder === recorderBefore);
  if (started) engine.discard();
  globalThis.createDurableWriter = originalFactory;
}

{
  const originalSupport = FakeMediaRecorder.isTypeSupported;
  FakeMediaRecorder.isTypeSupported = () => true;
  globalThis.recoverMp4Blob = async () => { throw new Error('NO_VALID_MP4'); };
  const calls = [];
  const { engine, events } = engineWith(async blob => {
    calls.push(blob);
    return { filename: 'invalid.webm' };
  });
  const before = durableWriters.length;
  await engine.start({ outputFormat: 'mp4' });
  const writer = durableWriters[before];
  lastRecorder.ondataavailable({ data: new Blob(['first']) });
  await waitFor(() => writer.bytes === 5);
  writer.failWith = new Error('OPFS_FULL');
  lastRecorder.ondataavailable({ data: new Blob(['broken-tail']) });
  await waitFor(() => !engine.isBusy());
  ok('原生 MP4 暂存异常归一化失败时不下载', calls.length === 0 && events.some(event =>
    event.name === 'saveerror' && event.data?.message?.includes('NO_VALID_MP4')));
  FakeMediaRecorder.isTypeSupported = originalSupport;
}

{
  const { engine, events } = engineWith(async () => ({ filename: 'unused.webm' }));
  const before = durableWriters.length;
  await engine.start({ outputFormat: 'webm' });
  const writer = durableWriters[before];
  let release;
  writer.appendHold = new Promise(resolve => { release = resolve; });
  lastRecorder.ondataavailable({ data: new Blob(['pending']) });
  await waitFor(() => !!writer.appendHold);
  const discarding = engine.discard();
  release();
  await discarding;
  const stoppedAt = events.findIndex(event => event.name === 'stopped');
  ok('在途 append 后丢弃不会重建元数据', writer.discarded && stoppedAt >= 0 &&
    !events.slice(stoppedAt + 1).some(event => event.name === 'durable'));
}

{
  const { engine, events } = engineWith(async () => ({ filename: 'unused.webm' }));
  const before = durableWriters.length;
  await engine.start({ outputFormat: 'webm' });
  const writer = durableWriters[before];
  writer.finalizeError = new Error('WORKER_DEAD');
  engine.stop();
  await waitFor(() => events.some(event => event.name === 'saveerror'));
  ok('finalize 失败释放旧引擎忙态并保留恢复错误', !engine.isBusy() && events.some(event =>
    event.data?.message?.includes('WORKER_DEAD')));
}

{
  const { engine, events } = engineWith(async () => ({ filename: 'cleanup.webm' }));
  const before = durableWriters.length;
  await engine.start({ outputFormat: 'webm' });
  durableWriters[before].discardError = new Error('CLEANUP_FAILED');
  engine.stop();
  await waitFor(() => events.some(event => event.name === 'saveerror' || event.name === 'saved'));
  ok('清理失败不伪造下载收尾成功', events.some(event => event.name === 'saveerror') &&
    !events.some(event => event.name === 'saved') && engine.isBusy());
}

{
  const originalRecorder = globalThis.MediaRecorder;
  globalThis.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor() { throw new Error('RECORDER_CONSTRUCTOR_FAILED'); }
  };
  const { engine, events } = engineWith(async () => ({ filename: 'unused.webm' }));
  const before = durableWriters.length;
  let error = '';
  try { await engine.start({ outputFormat: 'webm' }); } catch (value) { error = value.message; }
  ok('MediaRecorder 构造失败回滚 OPFS 和元数据', error.includes('RECORDER_CONSTRUCTOR_FAILED') &&
    durableWriters[before].discarded && events.some(event => event.name === 'durablecleanup'));
  globalThis.MediaRecorder = originalRecorder;
}

{
  const { engine, events } = engineWith(async () => ({ filename: 'duration.webm' }));
  const before = durableWriters.length;
  await engine.start({ outputFormat: 'webm' });
  const writer = durableWriters[before];
  let release;
  writer.finalizeHold = new Promise(resolve => { release = resolve; });
  engine.stop();
  await new Promise(resolve => setTimeout(resolve, 1200));
  release();
  await waitFor(() => !engine.isBusy());
  ok('保存排队时间不计入录制时长', events.find(event => event.name === 'stopped')?.data?.historyEntry?.duration === '00:00:00');
}

{
  async function resourceCase(manageResources) {
    let stopped = false;
    let released = 0;
    const shared = { getTracks: () => [{ kind: 'video', addEventListener() {}, stop() { stopped = true; } }] };
    const engine = createRecorderEngine({
      getStream: async () => shared,
      releaseExtra: () => { released++; },
      manageResources,
      saveFile: async () => ({ filename: 'resources.webm' }),
    });
    await engine.start({ outputFormat: 'webm' });
    engine.stop();
    await waitFor(() => !engine.isBusy());
    return { stopped, released };
  }
  const owned = await resourceCase(undefined);
  ok('默认停止仍释放媒体流与额外资源', owned.stopped && owned.released === 1);
  const shared = await resourceCase(false);
  ok('分段模式停止不释放共享资源', !shared.stopped && shared.released === 0);
}

{
  const { engine, events } = engineWith(async () => ({ filename: 'media-error.webm' }));
  await engine.start({ outputFormat: 'webm' });
  lastRecorder.onerror?.({ error: { name: 'UnknownError', message: 'MEDIA_FATAL' } });
  await new Promise(resolve => setTimeout(resolve, 30));
  ok('MediaRecorder error 可见并停止当前录制器', events.some(event =>
    event.name === 'saveerror' && event.data?.message?.includes('MEDIA_FATAL')) &&
    lastRecorder.state === 'inactive' && !engine.isBusy());
  if (engine.isBusy()) await engine.discard();
}

console.log(failed ? `\n${failed} 项失败 ❌` : '\n保存引擎测试全部通过 🎉');
process.exit(failed ? 1 : 0);
