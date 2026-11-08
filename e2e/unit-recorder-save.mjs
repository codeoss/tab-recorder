/**
 * 验证桌面 recorder：段级保存保留会话控制、会话级收尾禁用控制、
 * 失败重试入口不被后续事件隐藏、真实下载进度和 saved 后自动关闭。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function ok(name, condition, extra = '') {
  console.log(`${condition ? '  ✅' : '  ❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!condition) failed++;
}
function element() {
  const classes = new Set();
  return {
    textContent: '', innerHTML: '', className: '', disabled: false, hidden: false,
    style: {}, dataset: {},
    classList: {
      add: (...x) => x.forEach(v => classes.add(v)),
      remove: (...x) => x.forEach(v => classes.delete(v)),
      toggle: (x, force) => { if (force) classes.add(x); else classes.delete(x); },
      contains: x => classes.has(x),
    },
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    async click() { return await this.listeners.click?.(); },
  };
}

const bg = {
  status: 'idle', processing: true, savePhase: 'downloading', processingStage: 'download',
  saveReceived: 50 * 1048576, saveTotal: 100 * 1048576, saveCanRetry: true,
};
const elements = new Map();
const listeners = {};
const timeouts = [];
const context = {
  console,
  document: { getElementById: id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  } },
  window: {
    location: { hash: '' },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    close() {},
  },
  navigator: {},
  URLSearchParams,
  chrome: { runtime: {
    onMessage: { addListener() {} },
    sendMessage: async msg => msg.type === 'GET_STATE' ? { ...bg } : { ok: 1 },
  } },
  setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return 1; },
  setInterval: () => 1,
  clearInterval() {},
  confirm: () => true,
};
let retries = 0;
let discards = 0;
let normalEngines = 0;
let segmentedEngines = 0;
const fakeEngine = () => ({
  start: async () => true,
  isBusy: () => true,
  retrySave: async () => { retries++; return true; },
  discard: () => { discards++; },
});
context.createRecorderEngine = () => { normalEngines++; return fakeEngine(); };
context.createSegmentedRecorderEngine = () => { segmentedEngines++; return fakeEngine(); };
vm.runInNewContext(
  fs.readFileSync(path.join(ROOT, 'recorder.js'), 'utf8').replace(/\r\n/g, '\n') +
    '\nglobalThis.__recorderTest = { onEvent, startRecording, setEngine: e => { engine = e; }, enableSegments: () => { config.segmentEnabled = true; config.segmentMinutes = 1; }, pollSaveState: typeof pollSaveState === "function" ? pollSaveState : null };\n',
  context,
  { filename: 'recorder.js' },
);
const test = context.__recorderTest;
const el = id => {
  if (!elements.has(id)) elements.set(id, element());
  return elements.get(id);
};
test.setEngine(context.createRecorderEngine());

test.onEvent('processing', { active: true, stage: 'download', scope: 'segment', segmentIndex: 1 });
ok('段级保存显示段号且录制继续', el('stxt').textContent.includes('第 1 段') &&
  el('stxt').textContent.includes('录制继续'));
ok('旧段保存时仍可暂停和停止当前录制', el('pauseBtn').disabled === false && el('stopBtn').disabled === false);
test.onEvent('processing', { active: true, stage: 'webm-fix' });
ok('会话级收尾才禁用暂停和停止', el('pauseBtn').disabled === true && el('stopBtn').disabled === true);
const busyEvent = { preventDefault() {}, returnValue: '' };
listeners.beforeunload?.(busyEvent);
ok('保存中 beforeunload 保持保护', !!busyEvent.returnValue);

test.onEvent('saveerror', { message: 'FILE_NO_SPACE' });
ok('可恢复失败显示重试和丢弃', el('retrySaveBtn') && el('retrySaveBtn').hidden === false &&
   el('discardSaveBtn') && el('discardSaveBtn').hidden === false &&
   el('stxt').textContent.includes('文件仍保留'));
test.onEvent('processing', { active: true, stage: 'webm-fix', scope: 'segment', segmentIndex: 2 });
ok('后续段级事件不隐藏保存失败与重试入口', el('retrySaveBtn').hidden === false &&
  el('discardSaveBtn').hidden === false && el('stxt').textContent.includes('保存失败'));
await el('retrySaveBtn').click();
await el('discardSaveBtn').click();
ok('重试和丢弃调用真实引擎方法', retries === 1 && discards === 1);

if (typeof test.pollSaveState !== 'function') {
  ok('recorder 提供真实下载进度轮询', false);
} else {
  await test.pollSaveState();
  ok('recorder 显示真实下载进度', el('saveProgress') && el('saveProgress').textContent.includes('50%'));
}

test.onEvent('saved', { filename: 'done.webm' });
ok('saved 后显示完成并延时关窗', el('stxt').textContent.includes('已保存') &&
   timeouts.some(x => x.ms === 2000));

await test.startRecording();
ok('默认 recorder 使用原核心引擎', normalEngines > 0 && segmentedEngines === 0);
test.enableSegments();
await test.startRecording();
ok('打开分段后 recorder 使用分段控制器', segmentedEngines === 1);

console.log(failed ? `\n${failed} 项失败 ❌` : '\n桌面保存状态测试全部通过 🎉');
process.exit(failed ? 1 : 0);
