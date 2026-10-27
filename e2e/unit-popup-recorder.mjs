/**
 * 用真实 popup 脚本验证 desktop/compat 的准备、实际计时和控制入口。
 * DOM/Chrome 仅替换外部边界，状态同步和界面行为均由生产代码执行。
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

function element(id) {
  const classes = new Set(['hidden']);
  const values = { res: '1920x1080', fps: '30', qual: '8000000', cd: '0', fmt: 'webm' };
  return {
    textContent: '', innerHTML: '', className: '', disabled: false,
    style: {}, dataset: {}, value: values[id] || '0', checked: false,
    classList: {
      add: (...names) => names.forEach(x => classes.add(x)),
      remove: (...names) => names.forEach(x => classes.delete(x)),
      toggle: (name, force) => { if (force) classes.add(name); else classes.delete(name); },
      contains: name => classes.has(name),
    },
    addEventListener() {},
  };
}

function popupWith(bg, { source = 'tab', compat = false, responses = {} } = {}) {
  const elements = new Map();
  const messages = [];
  const intervals = [];
  const context = {
    console, Date, confirm: () => true,
    document: {
      getElementById: id => {
        if (!elements.has(id)) elements.set(id, element(id));
        return elements.get(id);
      },
      querySelectorAll: () => [],
      addEventListener() {},
    },
    chrome: {
      runtime: { sendMessage: async msg => {
        messages.push(msg);
        if (msg.type === 'GET_STATE') return { ...bg };
        return { ok: 1, ...responses[msg.type] };
      } },
      storage: { local: { get: (_key, cb) => cb({}), set() {} } },
    },
    setTimeout: () => 1,
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearTimeout() {},
    clearInterval() {},
  };
  const script = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8').replace(/\r\n/g, '\n') +
    `\nsrc = ${JSON.stringify(source)}; el.compat.checked = ${compat};\n` +
    'globalThis.__popupTest = { start, stop, toggle, togglePause, pollState, el,\n' +
    '  get state() { return state; }, get tickActive() { return tick !== null; },\n' +
    '  get startTime() { return bgStart; } };\n';
  vm.runInNewContext(script, context, { filename: 'popup.js' });
  return { test: context.__popupTest, bg, messages, intervals };
}

for (const [source, compat] of [['window', false], ['tab', true]]) {
  const h = popupWith({ status: 'preparing', mode: 'desktop', startTime: 0, timeLimit: 10 },
    { source, compat });
  h.test.el.tlS.value = '10';
  await h.test.start();
  ok(`${source}${compat ? '/compat' : ''} 等待选择时不启动计时`,
    h.test.state === 'preparing' && !h.test.tickActive && h.test.el.stxt.textContent.includes('选择'),
    `${h.test.state} / ${h.test.el.stxt.textContent}`);
  ok('准备阶段不显示定时停止进度', h.test.el.pWrap.classList.contains('hidden'));

  h.bg.status = 'recording';
  h.bg.startTime = 1700000000000;
  await h.test.pollState();
  ok('RECORDER_STARTED 后才按实际时间计时',
    h.test.state === 'recording' && h.test.tickActive && h.test.startTime === 1700000000000,
    `${h.test.state} / ${h.test.startTime}`);
}

{
  const h = popupWith({ status: 'preparing', mode: 'desktop', startTime: 0 });
  await h.test.pollState();
  ok('重开 popup 也保持准备态且不计时',
    h.test.state === 'preparing' && !h.test.tickActive && h.test.el.stxt.textContent.includes('选择'),
    `${h.test.state} / ${h.test.el.stxt.textContent}`);
}

{
  const h = popupWith({ status: 'recording', mode: 'tab', startTime: 1000 });
  h.test.el.cd.value = '3';
  await h.test.start();
  ok('普通 tab 倒计时和实际录制计时保持原行为',
    h.test.state === 'recording' && h.test.tickActive &&
    h.messages.some(x => x.type === 'START_RECORDING' && x.countdownSec === 3));
}

console.log(failed ? `\n${failed} 项失败 ❌` : '\n录制窗口状态测试全部通过 🎉');
process.exit(failed ? 1 : 0);
