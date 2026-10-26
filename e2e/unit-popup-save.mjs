/**
 * 验证主弹窗不会在停止后提前显示完成，并能显示真实保存阶段、
 * 下载进度与恢复入口；保存中禁止开始，致命错误不提供假重试。
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
  const classes = new Set(['hidden']);
  return {
    textContent: '', innerHTML: '', className: '', disabled: false,
    style: {}, dataset: {}, value: 'webm', checked: false,
    classList: {
      add: (...names) => names.forEach(x => classes.add(x)),
      remove: (...names) => names.forEach(x => classes.delete(x)),
      toggle: (name, force) => { if (force) classes.add(name); else classes.delete(name); },
      contains: name => classes.has(name),
    },
    addEventListener() {},
  };
}

function popupWith(bg) {
  const elements = new Map();
  const scheduled = [];
  const context = {
    console,
    document: {
      getElementById: id => {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      querySelectorAll: () => [],
      addEventListener() {},
    },
    chrome: {
      runtime: { sendMessage: async msg => msg.type === 'GET_STATE' ? { ...bg } : { ok: 1 } },
      storage: { local: {
        get: (_key, cb) => cb({}),
        set: () => {},
      } },
    },
    setTimeout: (fn, ms) => { scheduled.push({ fn, ms }); return 1; },
    setInterval: () => 1,
    clearTimeout() {},
    clearInterval() {},
    confirm: () => true,
    Date,
  };
  const source = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8').replace(/\r\n/g, '\n') +
    '\nglobalThis.__popupTest = { stop, pollState, el };\n';
  vm.runInNewContext(source, context, { filename: 'popup.js' });
  return { test: context.__popupTest, scheduled };
}

{
  const { test, scheduled } = popupWith({ status: 'idle', processing: true, savePhase: 'processing' });
  await test.stop();
  ok('停止后不得提前显示录制完成', test.el.stxt.textContent.includes('正在保存') &&
     !test.el.stxt.textContent.includes('录制完成'), test.el.stxt.textContent);
  ok('停止后不按固定延时刷新成功历史', !scheduled.some(x => x.ms === 600));
}

{
  const { test } = popupWith({
    status: 'idle', mode: 'tab', processing: true,
    savePhase: 'downloading', processingStage: 'download',
    saveReceived: 50 * 1048576, saveTotal: 100 * 1048576,
    saveCanRetry: true,
  });
  await test.pollState();
  ok('下载中显示可见保存面板和真实进度', test.el.savePanel && !test.el.savePanel.classList.contains('hidden') &&
     test.el.saveProgress && test.el.saveProgress.textContent.includes('50%'));
  ok('标签页下载中提供保存进度入口', test.el.openSaveBtn && test.el.openSaveBtn.hidden === false);
  ok('保存中禁用设置和开始按钮', test.el.sp.classList.contains('dis') &&
     test.el.rec.style.pointerEvents === 'none');
}

{
  const { test } = popupWith({
    status: 'idle', mode: 'tab', processing: false,
    savePhase: 'error', saveCanRetry: false, saveError: '上下文已关闭',
  });
  await test.pollState();
  ok('不可恢复错误不提供重试且允许新录制', test.el.retrySaveBtn && test.el.retrySaveBtn.hidden !== false &&
     test.el.rec.style.pointerEvents !== 'none' && test.el.saveText && test.el.saveText.textContent.includes('无法重试'));
}

console.log(failed ? `\n${failed} 项失败 ❌` : '\n主弹窗保存状态测试全部通过 🎉');
process.exit(failed ? 1 : 0);
