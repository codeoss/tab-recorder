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

function harness(initialState = null) {
  const listeners = {};
  const session = initialState ? { recorderState: initialState } : {};
  const local = {};
  const sent = [];
  const items = new Map();
  let nextId = 1;
  const chrome = {
    runtime: {
      onMessage: { addListener: fn => { listeners.message = fn; } },
      onInstalled: { addListener: fn => { listeners.installed = fn; } },
      sendMessage: async msg => { sent.push(msg); return { ok: 1 }; },
      getContexts: async () => [],
      getURL: path => `chrome-extension://test/${path}`,
    },
    windows: {
      onRemoved: { addListener: fn => { listeners.windowRemoved = fn; } },
      create: async () => ({ id: 100, tabs: [{ id: 200 }] }),
      remove: async () => {},
    },
    tabs: {
      query: async () => [{ id: 1 }],
      sendMessage: async (...args) => { sent.push(args); return { ok: 1 }; },
    },
    tabCapture: { getMediaStreamId: (_opts, cb) => cb('stream-id') },
    offscreen: { createDocument: async () => {} },
    storage: {
      session: {
        async get(key) { return { [key]: session[key] }; },
        async set(values) { Object.assign(session, values); },
      },
      local: {
        get(key, cb) { cb({ [key]: local[key] }); },
        set(values, cb) { Object.assign(local, values); if (cb) cb(); },
      },
    },
    action: {
      setBadgeText() {},
      setBadgeBackgroundColor() {},
    },
    downloads: {
      onChanged: { addListener: fn => { listeners.downloadChanged = fn; } },
      async download(options) {
        const id = nextId++;
        const item = {
          id,
          state: 'in_progress',
          error: undefined,
          filename: `C:/Downloads/${options.filename}`,
          bytesReceived: 0,
          totalBytes: 100,
        };
        items.set(id, item);
        return id;
      },
      async search({ id }) { return items.has(id) ? [{ ...items.get(id) }] : []; },
      async cancel() { throw new Error('下载不应被取消'); },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), {
    chrome, console, URLSearchParams, setTimeout, clearTimeout,
  }, { filename: 'background.js' });
  if (!listeners.downloadChanged) listeners.downloadChanged = async () => {};
  async function send(type, extra = {}) {
    return new Promise((resolve, reject) => {
      try {
        const result = listeners.message({ type, ...extra }, {}, value => resolve(value ?? {}));
        if (result !== true) reject(new Error(`消息 ${type} 未异步回复`));
      } catch (error) { reject(error); }
    });
  }
  function patch(id, values) {
    if (!items.has(id)) items.set(id, { id, state: 'in_progress', filename: '', bytesReceived: 0, totalBytes: 100 });
    Object.assign(items.get(id), values);
  }
  return { chrome, listeners, session, local, sent, items, send, patch };
}

async function processing(h, stage = 'webm-fix') {
  await h.send('ENGINE_PROCESSING', { active: true, stage });
}

{
  const h = harness();
  await processing(h);
  const started = await h.send('SAVE_FILE', { url: 'blob:chrome-extension://x/first', filename: 'a.webm' });
  ok('SAVE_FILE 创建下载并进入 downloading', started.downloadId === 1 &&
     h.session.recorderState.savePhase === 'downloading' && h.session.recorderState.processing === true);
  const duplicate = await h.send('SAVE_FILE', { url: 'blob:chrome-extension://x/second', filename: 'b.webm' });
  ok('重复未完成任务被拒绝', !!duplicate.error && h.items.size === 1);
  const discard = await h.send('DISCARD_RECORDING');
  ok('下载中丢弃返回忙错误', !!discard.error);

  h.patch(1, { bytesReceived: 50 });
  const progress = await h.send('GET_DOWNLOAD_STATUS', { downloadId: 1 });
  const stateProgress = await h.send('GET_STATE');
  ok('下载进度同步到 GET_STATE', progress.received === 50 && progress.total === 100 &&
     stateProgress.saveReceived === 50 && stateProgress.saveTotal === 100);

  await h.listeners.downloadChanged({ id: 999, state: { current: 'complete' } });
  const unrelated = await h.send('GET_STATE');
  ok('无关下载事件不污染状态', unrelated.savePhase === 'downloading');

  h.patch(1, { state: 'complete', bytesReceived: 100, filename: 'C:/Downloads/a (1).webm' });
  await h.listeners.downloadChanged({ id: 1, state: { current: 'complete' } });
  const complete = await h.send('GET_DOWNLOAD_STATUS', { downloadId: 1 });
  const stateComplete = await h.send('GET_STATE');
  ok('complete 返回真实文件名和路径', complete.state === 'complete' &&
     complete.filename === 'a (1).webm' && complete.path === 'C:/Downloads/a (1).webm');
  ok('完成下载仍等待引擎收尾', stateComplete.savePhase === 'complete' && stateComplete.processing === true);

  await h.send('RECORDING_STOPPED', { historyEntry: { filename: complete.filename, size: 100 } });
  ok('引擎收尾后解除 processing', (await h.send('GET_STATE')).processing === false);
  ok('成功历史在引擎确认后写入', h.local.recordingHistory?.[0]?.filename === 'a (1).webm');
}

{
  const h = harness();
  await processing(h);
  await h.send('SAVE_FILE', { url: 'blob:chrome-extension://x/failure', filename: 'failed.webm' });
  h.patch(1, { state: 'interrupted', error: 'FILE_NO_SPACE' });
  await h.listeners.downloadChanged({ id: 1, state: { current: 'interrupted' }, error: { current: 'FILE_NO_SPACE' } });
  const interrupted = await h.send('GET_DOWNLOAD_STATUS', { downloadId: 1 });
  const state = await h.send('GET_STATE');
  ok('interrupted 进入 error 而非 complete', interrupted.state === 'interrupted' &&
     state.savePhase === 'error' && state.saveError === 'FILE_NO_SPACE' && state.saveCanRetry === true);
  const discarded = await h.send('DISCARD_RECORDING');
  const after = await h.send('GET_STATE');
  ok('可重试失败后允许明确丢弃并清理状态', !discarded.error && after.processing === false &&
     after.savePhase === '' && after.downloadId === 0 && after.saveCanRetry === false);
}

{
  const restored = {
    status: 'idle', mode: 'tab', processing: true,
    savePhase: 'downloading', processingStage: 'download', downloadId: 7,
    saveError: '', saveFilename: 'restored.webm', saveWindowId: 0,
    saveCanRetry: true, saveReceived: 10, saveTotal: 100,
    recorderWindowId: 0, recorderTabId: 0, fileSize: 0,
  };
  const h = harness(restored);
  h.items.set(7, {
    id: 7, state: 'complete', filename: 'C:/Downloads/restored.webm',
    bytesReceived: 100, totalBytes: 100,
  });
  const result = await h.send('GET_DOWNLOAD_STATUS', { downloadId: 7 });
  const state = await h.send('GET_STATE');
  ok('SW 恢复后按 downloadId 对账', result.state === 'complete' &&
     state.savePhase === 'complete' && state.saveReceived === 100 && state.saveTotal === 100);
}

{
  const h = harness({
    status: 'idle', mode: 'tab', processing: false,
    savePhase: 'error', downloadId: 8, saveError: 'FILE_NO_SPACE',
    saveFilename: 'old.webm', saveWindowId: 9, saveCanRetry: true,
    saveReceived: 50, saveTotal: 100,
  });
  const started = await h.send('START_RECORDING', { source: 'window' });
  const state = await h.send('GET_STATE');
  ok('新录制清理上一段终态', !started.error && state.savePhase === '' && state.downloadId === 0 &&
     state.saveError === '' && state.saveFilename === '' && state.saveCanRetry === false &&
     state.saveReceived === 0 && state.saveTotal === 0 && state.saveWindowId === 0,
     JSON.stringify({ started, state }));
}

{
  const saveFilePath = path.join(ROOT, 'save-file.js');
  if (!fs.existsSync(saveFilePath)) {
    ok('saveFileViaBackground 已定义', false);
  } else {
    function adapterHarness(finalState) {
      const messages = [];
      const revoked = [];
      const context = {
        self: {},
        queueMicrotask,
        setTimeout: fn => { queueMicrotask(fn); return 0; },
        URL: {
          createObjectURL: () => 'blob:test',
          revokeObjectURL: url => revoked.push(url),
        },
        chrome: { runtime: { sendMessage: async msg => {
          messages.push(msg);
          if (msg.type === 'SAVE_FILE') return { downloadId: 42 };
          if (msg.type === 'GET_DOWNLOAD_STATUS') {
            const done = messages.filter(x => x.type === 'GET_DOWNLOAD_STATUS').length;
            if (finalState === 'complete' && done < 3) return { state: 'in_progress', received: 50, total: 100 };
            return finalState === 'complete'
              ? { state: 'complete', filename: 'a (1).webm', path: 'C:/Downloads/a (1).webm', received: 100, total: 100 }
              : { state: 'interrupted', error: 'FILE_NO_SPACE', filename: 'a.webm', path: '', received: 50, total: 100 };
          }
          return {};
        } } },
      };
      vm.runInNewContext(fs.readFileSync(saveFilePath, 'utf8'), context, { filename: 'save-file.js' });
      return { context, messages, revoked };
    }

    const success = adapterHarness('complete');
    const saved = await success.context.self.saveFileViaBackground({}, 'a.webm');
    ok('适配器在 complete 后返回真实文件名', saved.filename === 'a (1).webm' &&
       saved.path === 'C:/Downloads/a (1).webm');
    ok('适配器仅在终态后 revoke 一次', success.revoked.length === 1 && success.revoked[0] === 'blob:test' &&
       success.messages.filter(x => x.type === 'GET_DOWNLOAD_STATUS').length === 3);

    const failure = adapterHarness('interrupted');
    let saveError = '';
    try { await failure.context.self.saveFileViaBackground({}, 'a.webm'); }
    catch (error) { saveError = error.message; }
    ok('适配器传播下载失败并 revoke', saveError.includes('FILE_NO_SPACE') && failure.revoked.length === 1);
  }
}

console.log(failed ? `\n${failed} 项失败 ❌` : '\n下载状态测试全部通过 🎉');
process.exit(failed ? 1 : 0);
