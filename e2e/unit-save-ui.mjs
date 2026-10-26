/**
 * 验证 save-status 页面：整理/下载/完成/失败各阶段、真实进度、
 * beforeunload 防护、完成自动关窗，以及重试和明确丢弃。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'save-status.js');
let failed = 0;
function ok(name, condition, extra = '') {
  console.log(`${condition ? '  ✅' : '  ❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!condition) failed++;
}

if (!fs.existsSync(SCRIPT)) {
  ok('保存状态页面脚本存在', false);
} else {
  function page(state) {
    const ids = ['title', 'detail', 'progressText', 'progress', 'retryBtn', 'discardBtn', 'closeBtn'];
    const elements = Object.fromEntries(ids.map(id => [id, {
      textContent: '', hidden: false, disabled: false, value: 0, max: 100,
      listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; },
      async click() { return await this.listeners.click?.(); },
    }]));
    const listeners = {};
    const messages = [];
    const timeouts = [];
    const context = {
      console,
      document: { getElementById: id => elements[id] },
      window: {
        addEventListener: (type, fn) => { listeners[type] = fn; },
        close() { this.closed = (this.closed || 0) + 1; },
        closed: 0,
      },
      chrome: { runtime: { sendMessage: async msg => {
        messages.push(msg);
        if (msg.type === 'GET_STATE') return { ...state };
        return { ok: 1 };
      } } },
      confirm: () => true,
      setInterval: () => 1,
      setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return 1; },
      clearTimeout() {},
    };
    vm.runInNewContext(fs.readFileSync(SCRIPT, 'utf8'), context, { filename: 'save-status.js' });
    return { elements, listeners, messages, timeouts, context };
  }
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };

  const initial = page({ processing: false, savePhase: '', saveCanRetry: false });
  const initialEvent = { preventDefault() {}, returnValue: '' };
  initial.listeners.beforeunload?.(initialEvent);
  ok('首次状态查询返回前不解除关窗保护', !!initialEvent.returnValue);
  await flush();
  const noTaskEvent = { preventDefault() {}, returnValue: '' };
  initial.listeners.beforeunload?.(noTaskEvent);
  ok('明确无保存任务后才允许直接关窗', !noTaskEvent.returnValue);

  const processing = page({ processing: true, savePhase: 'processing', processingStage: 'webm-fix', saveCanRetry: true });
  await flush();
  ok('整理阶段显示明确保存警告', processing.elements.title.textContent.includes('保存') &&
     processing.elements.detail.textContent.includes('请勿关闭浏览器'));
  const processingEvent = { preventDefault() {}, returnValue: '' };
  processing.listeners.beforeunload?.(processingEvent);
  ok('整理阶段 beforeunload 阻止误关', !!processingEvent.returnValue);

  const downloading = page({ processing: true, savePhase: 'downloading', processingStage: 'download',
    saveReceived: 50 * 1048576, saveTotal: 100 * 1048576, saveCanRetry: true });
  await flush();
  ok('下载阶段显示真实百分比和字节数', downloading.elements.progressText.textContent.includes('50%') &&
     downloading.elements.progressText.textContent.includes('50.0') &&
     downloading.elements.progress.value === 50);

  const complete = page({ processing: false, savePhase: 'complete', saveFilename: 'done.webm', saveCanRetry: false });
  await flush();
  const completeEvent = { preventDefault() {}, returnValue: '' };
  complete.listeners.beforeunload?.(completeEvent);
  ok('完成后显示文件名且不阻止关窗', complete.elements.title.textContent.includes('保存完成') &&
     complete.elements.detail.textContent.includes('done.webm') && !completeEvent.returnValue);
  ok('完成两秒后自动关闭', complete.timeouts.some(x => x.ms === 2000));

  const failure = page({ processing: true, savePhase: 'error', saveCanRetry: true, saveError: 'FILE_NO_SPACE' });
  await flush();
  ok('可恢复失败显示重试和丢弃', !failure.elements.retryBtn.hidden && !failure.elements.discardBtn.hidden &&
     failure.elements.detail.textContent.includes('FILE_NO_SPACE'));
  await failure.elements.retryBtn.click();
  await failure.elements.discardBtn.click();
  ok('重试和丢弃按钮发送真实命令', failure.messages.some(x => x.type === 'RETRY_SAVE') &&
     failure.messages.some(x => x.type === 'DISCARD_RECORDING'));

  const fatal = page({ processing: false, savePhase: 'error', saveCanRetry: false, saveError: '上下文已关闭' });
  await flush();
  const fatalEvent = { preventDefault() {}, returnValue: '' };
  fatal.listeners.beforeunload?.(fatalEvent);
  ok('不可恢复错误不提供假重试', fatal.elements.retryBtn.hidden &&
     fatal.elements.detail.textContent.includes('无法重试') && !fatalEvent.returnValue);
}

console.log(failed ? `\n${failed} 项失败 ❌` : '\n保存页面测试全部通过 🎉');
process.exit(failed ? 1 : 0);
