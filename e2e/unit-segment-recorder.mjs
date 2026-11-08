/**
 * 用真实核心引擎驱动分段控制器：验证同流重叠、串行保存、暂停/停止、
 * 失败边界和丢弃语义。只替换媒体编码器、OPFS 与下载外部边界。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.self = globalThis;
globalThis.fixWebMBlob = async blob => blob;
globalThis.fixWebMRecoveryBlob = async blob => blob;
globalThis.mp4FaststartJs = async blob => blob;
globalThis.mp4Faststart = async blob => blob;
globalThis.webmToMp4 = async blob => blob;
globalThis.document = { createElement: () => ({ click() {} }) };

const recorders = [];
const lifecycle = [];
let suppressData = false;
class FakeMediaRecorder {
  static isTypeSupported(type) { return type.startsWith('video/webm'); }
  constructor() {
    this.state = 'inactive';
    this.id = recorders.length + 1;
    recorders.push(this);
  }
  start() { this.state = 'recording'; lifecycle.push(`start${this.id}`); }
  pause() { this.state = 'paused'; lifecycle.push(`pause${this.id}`); }
  resume() { this.state = 'recording'; lifecycle.push(`resume${this.id}`); }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    lifecycle.push(`stop${this.id}`);
    queueMicrotask(() => {
      if (!suppressData) this.ondataavailable?.({ data: new Blob([`encoded${this.id}`]) });
      this.onstop?.();
    });
  }
}
globalThis.MediaRecorder = FakeMediaRecorder;

const durableWriters = [];
let writerCalls = 0;
let failWriterCall = 0;
let blockWriterCall = 0;
let releaseBlockedWriter = null;
let failFinalizeCall = 0;
let finalizeCalls = 0;
globalThis.createDurableWriter = async ({ id, mime, onMetadata }) => {
  writerCalls++;
  if (writerCalls === failWriterCall) throw new Error('NEXT_WRITER_FAILED');
  if (writerCalls === blockWriterCall) {
    await new Promise(resolve => { releaseBlockedWriter = resolve; });
  }
  const parts = [];
  const writer = {
    id, bytes: 0, discarded: false,
    async append(blob, mediaTimeMs) {
      parts.push(blob); writer.bytes += blob.size;
      await onMetadata({ id, mime, bytes: writer.bytes, mediaTimeMs, phase: 'recording' });
    },
    async finalize() {
      finalizeCalls++;
      if (finalizeCalls === failFinalizeCall) throw new Error('FINALIZE_FAILED');
      await onMetadata({ id, mime, bytes: writer.bytes, phase: 'processing' });
      return new File(parts, `tab-record-${id}.media`, { type: mime });
    },
    async discard() { writer.discarded = true; parts.length = 0; },
  };
  durableWriters.push(writer);
  return writer;
};

await import(pathToFileURL(path.join(ROOT, 'core-recorder.js')).href);
await import(pathToFileURL(path.join(ROOT, 'segment-recorder.js')).href);

let failed = 0;
function ok(name, condition, extra = '') {
  console.log(`${condition ? '  ✅' : '  ❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!condition) failed++;
}
async function waitFor(predicate, timeout = 2500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('等待分段状态超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function harness(saveImpl, getStreamImpl) {
  writerCalls = 0;
  recorders.length = 0;
  lifecycle.length = 0;
  blockWriterCall = 0;
  releaseBlockedWriter = null;
  failFinalizeCall = 0;
  finalizeCalls = 0;
  const events = [];
  const saveCalls = [];
  const trackListeners = [];
  let sharedStopped = false;
  let released = 0;
  const shared = { getTracks: () => [{
    kind: 'video', addEventListener: (type, fn) => { if (type === 'ended') trackListeners.push(fn); },
    stop() { sharedStopped = true; },
  }] };
  const engine = globalThis.createSegmentedRecorderEngine({
    getStream: async () => getStreamImpl ? getStreamImpl() : shared,
    onEvent: (name, data) => events.push({ name, data }),
    releaseExtra: () => { released++; },
    saveFile: async (blob, filename, extra) => {
      saveCalls.push({ blob, filename, extra });
      if (saveImpl) return await saveImpl(blob, filename, extra, saveCalls.length);
      return { filename, path: `C:/Downloads/${filename}` };
    },
  });
  return { engine, events, saveCalls,
    endSharedTrack: () => trackListeners.forEach(fn => fn()),
    get writerRelease() { return releaseBlockedWriter; },
    get sharedStopped() { return sharedStopped; }, get released() { return released; } };
}
async function scenario(name, fn) {
  if (process.env.E2E_CASE && process.env.E2E_CASE !== name) return;
  try { await fn(); }
  catch (error) { failed++; console.log(`  ❌ ${name} — ${error.message}`); }
}

{
  let activeSaves = 0;
  let maxSaves = 0;
  const h = harness(async (_blob, filename) => {
    activeSaves++; maxSaves = Math.max(maxSaves, activeSaves);
    await new Promise(resolve => setTimeout(resolve, 8));
    activeSaves--;
    return { filename };
  });
  await h.engine.start({ outputFormat: 'webm', segmentMinutes: 0.005 });
  await waitFor(() => recorders.length >= 3 && h.saveCalls.length >= 1);
  ok('下一段开始先于上一段停止', lifecycle.indexOf('start2') < lifecycle.indexOf('stop1') &&
    lifecycle.indexOf('start3') < lifecycle.indexOf('stop2'), lifecycle.join(','));
  ok('重叠期间共享流未释放', !h.sharedStopped && h.released === 0);
  h.engine.stop();
  await waitFor(() => !h.engine.isBusy());
  ok('保存严格串行', maxSaves === 1);
  ok('文件名包含连续段号', h.saveCalls[0]?.filename.includes('_part001') &&
    h.saveCalls[1]?.filename.includes('_part002'));
  ok('最终停止才释放共享资源', h.sharedStopped && h.released === 1);
  ok('段级 saved 含独立 recordingId', h.events.filter(x => x.name === 'segment' && x.data.phase === 'saved').length >= 2 &&
    new Set(h.events.filter(x => x.name === 'segment').map(x => x.data.recordingId).filter(Boolean)).size >= 2);
}

{
  const h = harness();
  await h.engine.start({ outputFormat: 'webm', segmentMinutes: 0.01 });
  await new Promise(resolve => setTimeout(resolve, 20));
  h.engine.pause();
  await new Promise(resolve => setTimeout(resolve, 100));
  ok('暂停期间不切换分段', recorders.length === 1 && h.engine.isPaused());
  h.engine.resume();
  await waitFor(() => recorders.length >= 2);
  h.engine.stop();
  await waitFor(() => !h.engine.isBusy());
}

{
  const h = harness();
  await h.engine.start({ outputFormat: 'webm', segmentMinutes: 0.005, timeLimit: 1 });
  await waitFor(() => !h.engine.isBusy());
  ok('总定时停止后没有新分段或孤儿录制', recorders.length >= 2 && recorders.every(x => x.state === 'inactive') &&
    h.events.some(x => x.name === 'stopped'));
}

{
  writerCalls = 0; failWriterCall = writerCalls + 2;
  const h = harness();
  await h.engine.start({ outputFormat: 'webm', segmentMinutes: 0.005 });
  await waitFor(() => !h.engine.isBusy());
  ok('下一段创建失败会停止旧段并保存', h.events.some(x => x.name === 'saveerror' &&
    x.data?.message?.includes('下一段启动失败')) && recorders.every(x => x.state === 'inactive') && h.saveCalls.length === 1);
  failWriterCall = 0;
}

{
  let calls = 0;
  const h = harness(async (_blob, filename) => {
    calls++;
    if (calls === 1) throw new Error('DOWNLOAD_FAILED');
    return { filename };
  });
  await h.engine.start({ outputFormat: 'webm', segmentMinutes: 0.005 });
  await waitFor(() => h.events.some(x => x.name === 'saveerror' && x.data?.message?.includes('DOWNLOAD_FAILED')));
  const countAtError = recorders.length;
  await new Promise(resolve => setTimeout(resolve, 70));
  ok('下载失败后不再创建新段', recorders.length === countAtError && h.engine.isBusy());
  ok('失败后可重试并完成会话', await h.engine.retrySave());
  await waitFor(() => !h.engine.isBusy());
}

{
  let releaseFirst;
  const h = harness(async (_blob, filename, _extra, index) => {
    if (index === 1) await new Promise(resolve => { releaseFirst = resolve; });
    return { filename };
  });
  await h.engine.start({ outputFormat: 'webm', segmentMinutes: 0.005 });
  await waitFor(() => h.events.some(x => x.name === 'saveerror' && x.data?.message?.includes('跟不上')));
  ok('保存或转码积压会停止并提示', recorders.length === 2 && h.engine.isBusy());
  releaseFirst?.();
  await waitFor(() => !h.engine.isBusy());
}

{
  suppressData = true;
  const h = harness();
  await h.engine.start({ outputFormat: 'webm', segmentMinutes: 1 });
  h.engine.stop();
  await waitFor(() => !h.engine.isBusy());
  ok('空段不下载也不写成功历史', h.saveCalls.length === 0 &&
    h.events.find(x => x.name === 'stopped')?.data?.historyEntry == null);
  suppressData = false;
}

{
  const h = harness();
  await h.engine.start({ outputFormat: 'webm', segmentMinutes: 0.005 });
  await waitFor(() => recorders.length >= 2);
  await h.engine.discard();
  ok('明确丢弃清理未保存分段并停止共享流', h.sharedStopped &&
    durableWriters.filter(writer => writer.id).every(writer => writer.discarded) &&
    !h.events.some(x => x.name === 'saved'));
}

await scenario('切换中停止', async () => {
  const h = harness();
  await h.engine.start({ outputFormat: 'webm', segmentMinutes: 0.005 });
  blockWriterCall = 2;
  await waitFor(() => !!h.writerRelease);
  h.engine.stop();
  h.writerRelease();
  await waitFor(() => !h.engine.isBusy());
  ok('下一段启动途中停止会关闭所有 recorder', recorders.every(recorder => recorder.state === 'inactive') &&
    h.saveCalls.length >= 1 && h.events.some(event => event.name === 'stopped'), lifecycle.join(','));
  return h;
});

await scenario('切换中暂停', async () => {
  const h = harness();
  await h.engine.start({ outputFormat: 'webm', segmentMinutes: 0.005 });
  blockWriterCall = 2;
  await waitFor(() => !!h.writerRelease);
  h.engine.pause();
  await new Promise(resolve => setTimeout(resolve, 40));
  ok('新段未就绪时暂停请求不会丢失', h.engine.isPaused() && recorders.length === 1);
  h.writerRelease();
  await waitFor(() => recorders[1]?.state === 'paused');
  h.engine.resume();
  ok('恢复后继续当前段', h.engine.isRecording() && !h.engine.isPaused());
  h.engine.stop();
  await waitFor(() => !h.engine.isBusy());
  return h;
});

await scenario('切换中丢弃', async () => {
  const h = harness();
  await h.engine.start({ outputFormat: 'webm', segmentMinutes: 0.005 });
  blockWriterCall = 2;
  await waitFor(() => !!h.writerRelease);
  const discarding = h.engine.discard();
  h.writerRelease();
  await discarding;
  ok('下一段启动途中丢弃不留下孤儿 recorder', recorders.every(recorder => recorder.state === 'inactive') &&
    h.sharedStopped && !h.events.some(event => event.name === 'saved'));
  return h;
});

await scenario('共享轨意外结束', async () => {
  const h = harness();
  await h.engine.start({ outputFormat: 'webm', segmentMinutes: 0.005 });
  h.endSharedTrack();
  await waitFor(() => !h.engine.isBusy());
  await new Promise(resolve => setTimeout(resolve, 40));
  ok('共享轨结束后不再轮换新段', recorders.length === 1 && recorders[0].state === 'inactive' &&
    h.saveCalls.length === 1);
  return h;
});

await scenario('取流异常复位', async () => {
  const h = harness(null, async () => { throw new Error('CAPTURE_FAILED'); });
  const started = await h.engine.start({ outputFormat: 'webm', segmentMinutes: 1 });
  ok('首次取流异常后释放忙态与额外资源', started === false && !h.engine.isBusy() && h.released === 1);
  return h;
});

await scenario('finalize 失败保留恢复', async () => {
  const h = harness();
  failFinalizeCall = 1;
  await h.engine.start({ outputFormat: 'webm', segmentMinutes: 1 });
  h.engine.stop();
  await waitFor(() => h.events.some(event => event.name === 'saveerror' &&
    event.data?.message?.includes('FINALIZE_FAILED')));
  await new Promise(resolve => setTimeout(resolve, 40));
  ok('整理失败不伪造会话终态', h.engine.isBusy() &&
    !h.events.some(event => event.name === 'stopped' && !event.data?.discarded));
  ok('没有可重试产物时不伪造重试成功', await h.engine.retrySave() === false && h.engine.isBusy());
  return h;
});

await scenario('严格串行处理', async () => {
  const original = globalThis.fixWebMBlob;
  globalThis.fixWebMBlob = async blob => {
    if (await blob.text() === 'encoded1') await new Promise(resolve => setTimeout(resolve, 450));
    return blob;
  };
  try {
    const h = harness();
    await h.engine.start({ outputFormat: 'webm', segmentMinutes: 0.005 });
    await waitFor(() => h.saveCalls.length >= 2);
    ok('慢的第一段不会被第二段超车', h.saveCalls[0].filename.includes('_part001') &&
      h.saveCalls[1].filename.includes('_part002'), h.saveCalls.map(call => call.filename).join(','));
    h.engine.stop();
    await waitFor(() => !h.engine.isBusy());
    return h;
  } finally { globalThis.fixWebMBlob = original; }
});

await scenario('失败状态不被 finalizing 覆盖', async () => {
  let calls = 0;
  const h = harness(async (_blob, filename) => {
    if (++calls === 1) throw new Error('DOWNLOAD_FAILED');
    return { filename };
  });
  await h.engine.start({ outputFormat: 'webm', segmentMinutes: 0.005 });
  await waitFor(() => h.events.some(event => event.name === 'saveerror' &&
    event.data?.message?.includes('DOWNLOAD_FAILED')));
  ok('可重试错误保持可见', !h.events.some(event => event.name === 'processing' &&
    event.data?.active && event.data?.stage === 'finalizing'));
  const retried = await h.engine.retrySave();
  await waitFor(() => !h.engine.isBusy());
  ok('重试后能够完成会话', retried && !h.engine.isBusy());
  return h;
});

console.log(failed ? `\n${failed} 项失败 ❌` : '\n分段控制器测试全部通过 🎉');
process.exit(failed ? 1 : 0);
