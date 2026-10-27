/**
 * 验证 background 下载 broker：真实完成/中断、下载进度、重复与丢弃守卫、
 * service worker 恢复、可见保存窗口，以及上下文销毁后的不可恢复状态。
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

function harness(initialState = null) {
  const listeners = {};
  const session = initialState ? { recorderState: initialState } : {};
  const local = {};
  const sent = [];
  const items = new Map();
  const contexts = [{ contextType: 'OFFSCREEN_DOCUMENT' }];
  const createdWindows = [];
  const focusedWindows = [];
  let nextId = 1;
  let sendImpl = async () => ({ ok: 1 });
  const chrome = {
    runtime: {
      onMessage: { addListener: fn => { listeners.message = fn; } },
      onInstalled: { addListener: fn => { listeners.installed = fn; } },
      sendMessage: async msg => { sent.push(msg); return sendImpl(msg); },
      getContexts: async () => contexts,
      getURL: path => `chrome-extension://test/${path}`,
    },
    windows: {
      onRemoved: { addListener: fn => { listeners.windowRemoved = fn; } },
      create: async options => {
        createdWindows.push(options);
        return { id: 100, tabs: [{ id: 200 }] };
      },
      update: async id => { focusedWindows.push(id); return { id }; },
      get: async id => ({ id }),
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
  async function send(type, extra = {}, sender = {}) {
    return new Promise((resolve, reject) => {
      try {
        const result = listeners.message({ type, ...extra }, sender, value => resolve(value ?? {}));
        if (result !== true) reject(new Error(`消息 ${type} 未异步回复`));
      } catch (error) { reject(error); }
    });
  }
  function patch(id, values) {
    if (!items.has(id)) items.set(id, { id, state: 'in_progress', filename: '', bytesReceived: 0, totalBytes: 100 });
    Object.assign(items.get(id), values);
  }
  return { chrome, listeners, session, local, sent, items, send, patch, contexts, createdWindows, focusedWindows,
    respondWith: fn => { sendImpl = fn; } };
}

async function processing(h, stage = 'webm-fix') {
  await h.send('ENGINE_PROCESSING', { active: true, stage });
}

{
  const h = harness();
  await processing(h, 'download');
  const started = await h.send('SAVE_FILE', { url: 'blob:chrome-extension://x/first-download', filename: 'first.webm' });
  ok('download 阶段但 downloadId=0 时允许首次保存', started.downloadId === 1 &&
     h.session.recorderState.downloadId === 1, JSON.stringify(started));
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
  const finished = await h.send('GET_STATE');
  ok('引擎收尾后解除 processing 和 retry 状态', finished.processing === false && finished.saveCanRetry === false);
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
  const h = harness({ status: 'idle', mode: 'tab' });
  await h.send('ENGINE_PROCESSING', { active: true, stage: 'webm-fix' });
  ok('tab 保存时自动打开可见窗口', h.createdWindows.length === 1 &&
     h.createdWindows[0].url === 'chrome-extension://test/save-status.html' &&
     (await h.send('GET_STATE')).saveWindowId === 100);
  await h.send('OPEN_SAVE_WINDOW');
  ok('已有保存窗口聚焦而不重复创建', h.createdWindows.length === 1 && h.focusedWindows[0] === 100);
  await h.listeners.windowRemoved(100);
  const closed = await h.send('GET_STATE');
  ok('关闭进度窗口不影响引擎保存', closed.saveWindowId === 0 && closed.processing === true &&
     closed.savePhase === 'processing');
  await h.send('OPEN_SAVE_WINDOW');
  ok('可重新打开保存进度', h.createdWindows.length === 2 && (await h.send('GET_STATE')).saveWindowId === 100);
}

{
  const h = harness({
    status: 'idle', mode: 'desktop', processing: true, savePhase: 'processing',
    recorderWindowId: 77, recorderTabId: 88, saveCanRetry: true,
  });
  await h.listeners.windowRemoved(77);
  const state = await h.send('GET_STATE');
  ok('recorder 上下文销毁显示不可恢复错误并清理忙态', state.processing === false &&
     state.savePhase === 'error' && state.saveCanRetry === false && state.recorderWindowId === 0 &&
     !h.local.recordingHistory?.length);
}

{
  const h = harness({
    status: 'idle', mode: 'tab', processing: true, savePhase: 'downloading',
    saveCanRetry: true, downloadId: 1,
  });
  h.contexts.length = 0;
  const state = await h.send('GET_STATE');
  ok('offscreen 消失后清除僵尸保存状态', state.processing === false && state.savePhase === 'error' &&
     state.saveCanRetry === false && !h.local.recordingHistory?.length);
}

{
  const h = harness({
    status: 'idle', mode: 'tab', processing: true, savePhase: 'error',
    saveCanRetry: true, saveError: 'FILE_NO_SPACE',
  });
  const result = await h.send('RETRY_SAVE');
  const state = await h.send('GET_STATE');
  ok('RETRY_SAVE 转发到引擎并恢复保存阶段', !result.error && state.savePhase === 'processing' &&
     state.saveError === '' && h.sent.some(x => x.type === 'OFF_RETRY_SAVE'));
}

{
  const h = harness();
  await h.send('START_RECORDING', { source: 'tab' });
  await h.send('STOP_RECORDING');
  const state = await h.send('GET_STATE');
  ok('STOP 后立即进入保存忙态', state.status === 'idle' && state.processing === true &&
     state.savePhase === 'processing', JSON.stringify(state));
}

{
  const h = harness({ status: 'recording', mode: 'tab' });
  await h.send('ENGINE_PROCESSING', { active: true, stage: 'webm-fix' });
  const state = await h.send('GET_STATE');
  ok('自动停止转为 idle 而非继续 recording', state.status === 'idle' && state.processing === true);
}

{
  const h = harness({
    status: 'recording', mode: 'tab', processing: true, savePhase: 'complete', saveCanRetry: true,
  });
  h.contexts.length = 0;
  const state = await h.send('GET_STATE');
  ok('下载完成后上下文丢失仍清理忙态并转为 idle', state.status === 'idle' && state.processing === false &&
     state.savePhase === 'error' && state.saveCanRetry === false);
}

for (const [mode, response] of [['tab', false], ['desktop', { ok: 0 }], ['desktop', null]]) {
  const h = harness({
    status: 'idle', mode, processing: true, savePhase: 'error', saveCanRetry: true,
    recorderTabId: 1,
  });
  h.respondWith(async () => response);
  h.chrome.tabs.sendMessage = async (...args) => { h.sent.push(args); return response; };
  const result = await h.send('RETRY_SAVE');
  const state = await h.send('GET_STATE');
  ok(`重试响应 ${JSON.stringify(response)} 被识别为失败并保留可重试错误`, !result.ok &&
     state.savePhase === 'error' && state.processing === true && state.saveCanRetry === true,
     JSON.stringify({ result, state }));
}

{
  const h = harness();
  await processing(h);
  await h.send('SAVE_FILE', { url: 'blob:chrome-extension://x/old', filename: 'old.webm' });
  let resolveSearch;
  h.chrome.downloads.search = () => new Promise(resolve => {
    resolveSearch = () => resolve([{
      id: 1, state: 'complete', filename: 'C:/Downloads/old.webm', bytesReceived: 100, totalBytes: 100,
    }]);
  });
  const pending = h.send('GET_DOWNLOAD_STATUS', { downloadId: 1 });
  await h.send('ENGINE_SAVE_ERROR', { message: 'FILE_NO_SPACE', canRetry: true });
  await h.send('RETRY_SAVE');
  await h.send('SAVE_FILE', { url: 'blob:chrome-extension://x/new', filename: 'new.webm' });
  resolveSearch();
  const result = await pending;
  const state = await h.send('GET_STATE');
  ok('旧下载完成事件不得覆盖新任务', !!result.error && state.downloadId === 2 &&
     state.savePhase === 'downloading' && state.saveFilename === 'new.webm',
     JSON.stringify({ result, state }));
}

{
  const h = harness({ status: 'idle', mode: 'tab' });
  await Promise.all([
    h.send('ENGINE_PROCESSING', { active: true, stage: 'webm-fix' }),
    h.send('ENGINE_PROCESSING', { active: true, stage: 'webm-fix' }),
  ]);
  ok('并发处理事件只创建一个保存窗口', h.createdWindows.length === 1,
     `实际 ${h.createdWindows.length}`);
}

{
  const h = harness();
  await processing(h);
  const download = h.chrome.downloads.download.bind(h.chrome.downloads);
  let releaseOld;
  let markOldStarted;
  const oldStarted = new Promise(resolve => { markOldStarted = resolve; });
  h.chrome.downloads.download = async options => {
    if (options.filename !== 'old.webm') return download(options);
    markOldStarted();
    const id = await download(options);
    await new Promise(resolve => { releaseOld = resolve; });
    return id;
  };
  const pending = h.send('SAVE_FILE', { url: 'blob:chrome-extension://x/old', filename: 'old.webm' });
  await oldStarted;
  await h.send('ENGINE_SAVE_ERROR', { message: 'FILE_NO_SPACE', canRetry: true });
  await h.send('RETRY_SAVE');
  await h.send('SAVE_FILE', { url: 'blob:chrome-extension://x/new', filename: 'new.webm' });
  releaseOld();
  const result = await pending;
  const state = await h.send('GET_STATE');
  ok('迟到的下载创建结果不得覆盖重试任务', !!result.error && state.downloadId === 2 &&
     state.saveFilename === 'new.webm' && state.saveGeneration > 0,
     JSON.stringify({ result, state }));
}

for (const request of [{ source: 'window' }, { source: 'tab', compatMode: true }]) {
  const h = harness();
  const started = await h.send('START_RECORDING', request);
  const pending = await h.send('GET_STATE');
  const duplicate = await h.send('START_RECORDING', request);
  ok(`${request.source}${request.compatMode ? '/compat' : ''} 创建窗口后进入准备态`,
    !started.error && pending.status === 'preparing' && pending.startTime === 0 && !!duplicate.error,
    JSON.stringify(pending));
  const before = Date.now();
  await h.send('RECORDER_STARTED');
  const actual = await h.send('GET_STATE');
  ok('RECORDER_STARTED 才写入实际开始时间', actual.status === 'recording' &&
    actual.startTime >= before && actual.startTime <= Date.now(), JSON.stringify(actual));
}

{
  const h = harness({
    status: 'preparing', mode: 'desktop', processing: false,
    recorderWindowId: 77, recorderTabId: 88,
  });
  const removed = [];
  h.chrome.windows.remove = async id => { removed.push(id); };
  await h.send('STOP_RECORDING');
  const state = await h.send('GET_STATE');
  ok('准备阶段 STOP 关闭等待窗口且不进入保存链', removed[0] === 77 &&
    state.status === 'idle' && state.processing === false && !h.local.recordingHistory?.length,
    JSON.stringify({ removed, state }));
}

{
  const h = harness({
    status: 'recording', mode: 'desktop', startTime: 1000,
    recorderWindowId: 77, recorderTabId: 88,
  });
  const result = await h.send('OPEN_RECORDER_WINDOW');
  ok('聚焦已有 recorder 而不创建新窗口', result.ok === 1 && result.windowId === 77 &&
    h.focusedWindows[0] === 77 && h.createdWindows.length === 0, JSON.stringify(result));
}

for (const initial of [
  { status: 'recording', mode: 'tab' },
  { status: 'preparing', mode: 'desktop', recorderWindowId: 77, missingWindow: true },
]) {
  const h = harness(initial);
  if (initial.missingWindow) h.chrome.windows.update = async () => { throw new Error('窗口不存在'); };
  const result = await h.send('OPEN_RECORDER_WINDOW');
  ok('tab 或失效 recorder 窗口不得伪造聚焦成功', !!result.error && h.createdWindows.length === 0,
    JSON.stringify(result));
}

{
  const h = harness({
    status: 'preparing', mode: 'desktop', startTime: 0,
    recorderWindowId: 77, recorderTabId: 88,
  });
  await h.send('RECORDER_STOPPED', { historyEntry: null, captureFailed: true });
  const cancelled = await h.send('GET_STATE');
  const duplicate = await h.send('START_RECORDING', { source: 'window' });
  ok('原生取消保留同窗口准备态和所有权', cancelled.status === 'preparing' &&
    cancelled.recorderWindowId === 77 && cancelled.recorderTabId === 88 && !!duplicate.error,
    JSON.stringify(cancelled));
  await h.send('RECORDER_STARTED', {}, { tab: { id: 88 } });
  const retry = await h.send('GET_STATE');
  ok('同一 recorder 重试后恢复真实录制状态', retry.status === 'recording' &&
    retry.startTime > 0 && retry.recorderWindowId === 77 && retry.recorderTabId === 88,
    JSON.stringify(retry));
}

{
  const h = harness({
    status: 'preparing', mode: 'desktop', startTime: 0,
    recorderWindowId: 77, recorderTabId: 88,
  });
  await h.send('RECORDER_STARTED', {}, { tab: { id: 88 } });
  const started = await h.send('GET_STATE');
  h.session.recorderState.pausedTime = 1234;
  await h.send('RECORDER_STARTED', {}, { tab: { id: 88 } });
  const duplicate = await h.send('GET_STATE');
  ok('重复 started 不重置开始时间和暂停累计', duplicate.startTime === started.startTime &&
    duplicate.pausedTime === 1234, JSON.stringify(duplicate));
  const stale = await h.send('RECORDER_STARTED', {}, { tab: { id: 999 } });
  ok('错误 recorder 来源的 started 被拒绝', !!stale.error && duplicate.startTime === started.startTime,
    JSON.stringify(stale));
}

for (const status of ['preparing', 'recording']) {
  const h = harness({ status, mode: 'desktop', recorderWindowId: 77, recorderTabId: 88, startTime: 1000 });
  h.chrome.windows.update = async () => { throw new Error('窗口不存在'); };
  h.chrome.windows.get = async () => { throw new Error('窗口不存在'); };
  await h.send('OPEN_RECORDER_WINDOW');
  const recovered = await h.send('GET_STATE');
  const restarted = await h.send('START_RECORDING', { source: 'window' });
  ok(`${status} 聚焦失效后清理并可重新开始`, recovered.recorderWindowId === 0 &&
    recovered.recorderTabId === 0 && recovered.processing === false && !restarted.error &&
    (status === 'preparing' ? recovered.status === 'idle' : recovered.savePhase === 'error'),
    JSON.stringify({ recovered, restarted }));
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
