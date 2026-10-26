import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

globalThis.self = globalThis;
let fixCalls = 0;
globalThis.fixWebMBlob = async blob => { fixCalls++; return blob; };
globalThis.mp4FaststartJs = async blob => blob;
globalThis.mp4Faststart = async blob => blob;
globalThis.webmToMp4 = async blob => blob;
globalThis.document = {
  createElement: () => ({ click() {} }),
};

class FakeMediaRecorder {
  static isTypeSupported(type) { return type.startsWith('video/webm'); }
  constructor() { this.state = 'inactive'; }
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
  engine.discard();
  const stopped = events.find(x => x.name === 'stopped' && x.data?.discarded === true);
  ok('失败后明确丢弃释放忙态', !!stopped && !engine.isBusy());
  ok('丢弃不写成功历史且不再下载', !events.some(x => x.name === 'saved') && calls.length === 1);
  if (typeof engine.retrySave === 'function') {
    ok('丢弃后不能重试', (await engine.retrySave()) === false && calls.length === 1);
  }
}

console.log(failed ? `\n${failed} 项失败 ❌` : '\n保存引擎测试全部通过 🎉');
process.exit(failed ? 1 : 0);
