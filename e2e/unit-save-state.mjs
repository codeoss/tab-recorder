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

function harness(initialState = null, durableRecording = null) {
  const listeners = {};
  const session = initialState ? { recorderState: initialState } : {};
  const local = durableRecording
    ? (Array.isArray(durableRecording) ? { durableRecordings: durableRecording } : { durableRecording })
    : {};
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
        get(key, cb) {
          const result = Object.fromEntries((Array.isArray(key) ? key : [key]).map(name => [name, local[name]]));
          if (cb) { cb(result); return; }
          return Promise.resolve(result);
        },
        async set(values, cb) { Object.assign(local, values); if (cb) cb(); },
        async remove(key) { for (const name of Array.isArray(key) ? key : [key]) delete local[name]; },
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
      async search(query) {
        if (query.id) return items.has(query.id) ? [{ ...items.get(query.id) }] : [];
        let found = [...items.values()];
        if (query.startedAfter) found = found.filter(item => Date.parse(item.startTime || 0) >= Date.parse(query.startedAfter));
        return found.map(item => ({ ...item }));
      },
      async cancel() { throw new Error('下载不应被取消'); },
    },
  };
  const sandbox = { chrome, console, URLSearchParams, setTimeout, clearTimeout };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  sandbox.importScripts = file => vm.runInContext(
    fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), sandbox, { filename: 'background.js' });
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
    status: 'recording', mode: 'tab', processing: false, savePhase: '', saveCanRetry: false,
  }, recoveryMeta('context-lost'));
  h.contexts.length = 0;
  const state = await h.send('GET_STATE');
  ok('录制中 offscreen 消失后提供真实恢复入口', state.status === 'idle' &&
    state.recoveryAvailable === true && state.saveCanRetry === true);
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

function recoveryMeta(id = 'r1') {
  return {
    id, fileName: `tab-record-${id}.media`, mime: 'video/webm', outputFormat: 'webm',
    recordedIsMp4: false, bytes: 100, mediaTimeMs: 1000, startedAt: 1700000000000,
    phase: 'recording', downloadId: 0,
  };
}

{
  const h = harness({ status: 'recording', mode: 'tab', processing: false }, recoveryMeta('live'));
  const state = await h.send('GET_STATE');
  ok('存活 offscreen 录制不会被误判为异常恢复', state.recoveryAvailable === false);
}

{
  const h = harness({ status: 'idle', mode: 'tab', processing: true,
    savePhase: 'error', saveCanRetry: true, downloadId: 0 }, recoveryMeta('live-retry'));
  h.respondWith(async msg => msg.type === 'OFF_RETRY_SAVE' ? true : { error: 'unexpected recovery' });
  const result = await h.send('RETRY_SAVE');
  ok('存活引擎下载失败仍走原 pendingSave 重试', result.ok === 1 &&
    h.sent.some(msg => msg.type === 'OFF_RETRY_SAVE') &&
    !h.sent.some(msg => msg.type === 'OFF_RECOVER_RECORDING'));
}

{
  const h = harness(null, recoveryMeta('independent-complete'));
  const result = await h.send('RECOVERY_COMPLETE', { historyEntry: {
    filename: 'independent.webm', recordingId: 'independent-complete', size: 100, duration: '00:00:01',
  } });
  ok('独立完成事件无需原始请求通道', result.ok === 1 && !h.local.durableRecording &&
    h.local.recordingHistory.length === 1);
}

{
  const h = harness({ status: 'idle', mode: 'tab', processing: true, savePhase: 'downloading',
    recoveryBusy: true, downloadId: 1, saveCanRetry: true },
  { ...recoveryMeta('sw-restart'), phase: 'downloading', downloadId: 1 });
  h.patch(1, { state: 'complete', bytesReceived: 100, filename: 'C:/Downloads/sw-restart.webm' });
  await h.send('GET_STATE');
  for (let i = 0; i < 30 && h.local.durableRecording; i++) await new Promise(resolve => setImmediate(resolve));
  ok('SW 在恢复中重启后主动对账已有下载', !h.local.durableRecording &&
    h.local.recordingHistory?.[0]?.filename === 'sw-restart.webm');
}

{
  const h = harness({ status: 'recording', mode: 'desktop', recorderWindowId: 100,
    recorderTabId: 200, processing: false }, recoveryMeta('desktop-lost'));
  await h.listeners.windowRemoved(100);
  const state = await h.send('GET_STATE');
  ok('desktop 录制窗口销毁也提供磁盘恢复', state.recoveryAvailable === true && state.saveCanRetry === true);
}

{
  const h = harness(null, recoveryMeta());
  const state = await h.send('GET_STATE');
  const started = await h.send('START_RECORDING', { source: 'window' });
  ok('重启后发现可恢复录制', state.recoveryAvailable === true);
  ok('恢复处理前禁止新录制', !!started.error);
}

{
  const h = harness(null, recoveryMeta('concurrent'));
  let finish;
  let calls = 0;
  h.respondWith(async msg => {
    if (msg.type === 'OFF_RECOVER_RECORDING') {
      calls++;
      await new Promise(resolve => { finish = resolve; });
      return { ok: 1, historyEntry: { filename: 'recovered.webm', recordingId: 'concurrent' } };
    }
    return { ok: 1 };
  });
  const first = h.send('RECOVER_RECORDING');
  const second = h.send('RECOVER_RECORDING');
  await new Promise(resolve => setImmediate(resolve));
  finish?.();
  const results = await Promise.all([first, second]);
  ok('并发恢复只执行一次且共享结果', calls === 1 && results.every(result => result.ok === 1));
  ok('恢复完成清理元数据且不重复历史', !h.local.durableRecording && h.local.recordingHistory.length === 1);
}

{
  const h = harness(null, { ...recoveryMeta('downloaded'), phase: 'downloading', downloadId: 1 });
  h.patch(1, { state: 'complete', bytesReceived: 100, filename: 'C:/Downloads/already.webm' });
  const result = await h.send('RECOVER_RECORDING');
  ok('已有下载 complete 直接对账完成', result.ok === 1 && !h.local.durableRecording &&
    h.local.recordingHistory[0].filename === 'already.webm');
  ok('已有下载完成不会再次恢复编码', !h.sent.some(msg => msg.type === 'OFF_RECOVER_RECORDING'));
}

{
  const h = harness(null, { ...recoveryMeta('in-progress'), phase: 'downloading', downloadId: 1 });
  h.patch(1, { state: 'in_progress', bytesReceived: 50, totalBytes: 100, filename: 'C:/Downloads/running.webm' });
  const pending = h.send('RECOVER_RECORDING');
  for (let i = 0; i < 20 && h.session.recorderState?.savePhase !== 'downloading'; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  h.patch(1, { state: 'complete', bytesReceived: 100 });
  const result = await pending;
  ok('已有下载 in_progress 继续等待且不重复导出', result.ok === 1 &&
    h.local.recordingHistory[0].filename === 'running.webm' &&
    !h.sent.some(msg => msg.type === 'OFF_RECOVER_RECORDING'));
}

{
  const h = harness(null, { ...recoveryMeta('interrupted'), phase: 'downloading', downloadId: 1 });
  h.patch(1, { state: 'interrupted', error: 'FILE_NO_SPACE', filename: 'C:/Downloads/old.webm' });
  h.respondWith(async msg => msg.type === 'OFF_RECOVER_RECORDING'
    ? { ok: 1, historyEntry: { filename: 'retry-recovery.webm', recordingId: 'interrupted' } }
    : { ok: 1 });
  const result = await h.send('RECOVER_RECORDING');
  ok('已有下载 interrupted 才重新恢复导出', result.ok === 1 &&
    h.sent.some(msg => msg.type === 'OFF_RECOVER_RECORDING'));
}

{
  const h = harness(null, recoveryMeta('failed'));
  h.respondWith(async msg => msg.type === 'OFF_RECOVER_RECORDING'
    ? { error: 'RECOVERY_DECODE_FAILED' } : { ok: 1 });
  const result = await h.send('RECOVER_RECORDING');
  const state = await h.send('GET_STATE');
  ok('恢复失败保留暂存并允许重试', (result.error || '').includes('RECOVERY_DECODE_FAILED') &&
    h.local.durableRecording && state.recoveryAvailable && state.saveCanRetry);
  const discarded = await h.send('DISCARD_RECOVERY');
  ok('明确丢弃恢复文件并清除状态', discarded.ok === 1 && !h.local.durableRecording &&
    h.sent.some(msg => msg.type === 'OFF_DISCARD_RECOVERY'));
}

{
  const intentAt = 1700000000000;
  const h = harness(null, { ...recoveryMeta('intent'), phase: 'processing', downloadId: 0,
    downloadIntent: { filename: 'intent.webm', startedAt: intentAt } });
  h.patch(1, { state: 'complete', bytesReceived: 100, filename: 'C:/Downloads/intent.webm',
    startTime: new Date(intentAt + 10).toISOString() });
  const result = await h.send('RECOVER_RECORDING');
  ok('downloadId 未落盘时通过 intent 对账原下载', result.ok === 1 &&
    h.local.recordingHistory?.[0]?.filename === 'intent.webm' &&
    !h.sent.some(msg => msg.type === 'OFF_RECOVER_RECORDING'));
}

{
  const h = harness(null, recoveryMeta('mutex'));
  let finish;
  h.respondWith(async msg => {
    if (msg.type === 'OFF_DISCARD_RECOVERY') await new Promise(resolve => { finish = resolve; });
    return { ok: 1 };
  });
  const discarding = h.send('DISCARD_RECOVERY');
  await new Promise(resolve => setImmediate(resolve));
  const recovering = h.send('RECOVER_RECORDING');
  finish?.();
  await Promise.all([discarding, recovering]);
  ok('恢复与丢弃共用互斥操作', !h.sent.some(msg => msg.type === 'OFF_RECOVER_RECORDING') &&
    !h.local.durableRecording);
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
    const saved = await success.context.self.saveFileViaBackground({}, 'a.webm', { recordingId: 'seg1', segmentIndex: 1 });
    ok('适配器在 complete 后返回真实文件名', saved.filename === 'a (1).webm' &&
       saved.path === 'C:/Downloads/a (1).webm');
    ok('适配器透传分段标识', success.messages.find(x => x.type === 'SAVE_FILE')?.recordingId === 'seg1' &&
       success.messages.find(x => x.type === 'SAVE_FILE')?.segmentIndex === 1);
    ok('适配器仅在终态后 revoke 一次', success.revoked.length === 1 && success.revoked[0] === 'blob:test' &&
       success.messages.filter(x => x.type === 'GET_DOWNLOAD_STATUS').length === 3);

    const failure = adapterHarness('interrupted');
    let saveError = '';
    try { await failure.context.self.saveFileViaBackground({}, 'a.webm'); }
    catch (error) { saveError = error.message; }
    ok('适配器传播下载失败并 revoke', saveError.includes('FILE_NO_SPACE') && failure.revoked.length === 1);
  }
}

{
  const h = harness({ status: 'recording', mode: 'tab', segmented: true, segmentIndex: 1,
    savedSegments: 0, savingSegments: 0, processing: false });
  await h.send('ENGINE_PROCESSING', { active: true, stage: 'webm-fix', scope: 'segment', segmentIndex: 1 });
  let state = await h.send('GET_STATE');
  ok('段级处理保持 recording 并显示保存段数', state.status === 'recording' && state.savingSegments === 1 &&
    state.savePhase === 'processing');
  const first = await h.send('SAVE_FILE', {
    url: 'blob:chrome-extension://x/seg1', filename: 'part1.webm', recordingId: 'seg1', segmentIndex: 1,
  });
  h.patch(first.downloadId, { state: 'complete', bytesReceived: 100, filename: 'C:/Downloads/part1.webm' });
  await h.send('GET_DOWNLOAD_STATUS', { downloadId: first.downloadId });
  await h.send('SEGMENT_SAVED', { recordingId: 'seg1', segmentIndex: 1,
    historyEntry: { recordingId: 'seg1', filename: 'part1.webm', size: 100 } });
  state = await h.send('GET_STATE');
  ok('首段 complete 后才写历史与完成数', state.savedSegments === 1 && state.status === 'recording' &&
    h.local.recordingHistory?.[0]?.recordingId === 'seg1' && state.downloadRecordingId === 'seg1');

  await h.send('ENGINE_PROCESSING', { active: true, stage: 'webm-fix', scope: 'segment', segmentIndex: 2 });
  const second = await h.send('SAVE_FILE', {
    url: 'blob:chrome-extension://x/seg2', filename: 'part2.webm', recordingId: 'seg2', segmentIndex: 2,
  });
  const stale = await h.send('GET_DOWNLOAD_STATUS', { downloadId: first.downloadId });
  state = await h.send('GET_STATE');
  ok('下一段可创建新下载且旧事件不覆盖', !second.error && second.downloadId === 2 && state.downloadId === 2 &&
    state.downloadRecordingId === 'seg2' && !!stale.error && state.status === 'recording',
    JSON.stringify({ second, stale, state }));
  h.patch(second.downloadId, { state: 'complete', bytesReceived: 100, filename: 'C:/Downloads/part2.webm' });
  await h.send('GET_DOWNLOAD_STATUS', { downloadId: second.downloadId });
  await h.send('SEGMENT_SAVED', { recordingId: 'seg2', segmentIndex: 2,
    historyEntry: { recordingId: 'seg2', filename: 'part2.webm', size: 100 } });
  ok('第二段完成历史独立且段号推进', h.local.recordingHistory?.length === 2 &&
    (await h.send('GET_STATE')).savedSegments === 2);
}

{
  const records = [
    { ...recoveryMeta('session-1'), sessionId: 'session', segmentIndex: 1, phase: 'downloading', downloadId: 1 },
    { ...recoveryMeta('session-2'), sessionId: 'session', segmentIndex: 2 },
    { ...recoveryMeta('session-3'), sessionId: 'session', segmentIndex: 3 },
  ];
  const h = harness(null, records);
  h.patch(1, { state: 'complete', filename: 'C:/Downloads/session-1.webm', bytesReceived: 100, totalBytes: 100 });
  const recovered = [];
  h.respondWith(async msg => {
    if (msg.type === 'OFF_RECOVER_RECORDING') {
      recovered.push(msg.metadata.id);
      await new Promise(resolve => setImmediate(resolve));
      return { ok: 1, historyEntry: { filename: `${msg.metadata.id}.webm`, recordingId: msg.metadata.id, size: 100 } };
    }
    return { ok: 1 };
  });
  await Promise.all([h.send('RECOVER_RECORDING'), h.send('RECOVER_RECORDING')]);
  const state = await h.send('GET_STATE');
  ok('多段按顺序恢复且不重复请求', recovered.join(',') === 'session-2,session-3', recovered.join(','));
  ok('已有下载对账后只写一次历史且清空恢复态', h.local.recordingHistory?.length === 3 &&
    state.recoveryAvailable === false && !h.local.durableRecordings?.length &&
    new Set(h.local.recordingHistory.map(x => x.recordingId)).size === 3);
  ok('恢复界面提供分段数量和总字节', state.recoveryCount === 0 && state.durableBytes === 0);
}

{
  const records = [
    { ...recoveryMeta('discard-1'), sessionId: 'discard', segmentIndex: 1, phase: 'downloading', downloadId: 1 },
    { ...recoveryMeta('discard-2'), sessionId: 'discard', segmentIndex: 2 },
    { ...recoveryMeta('discard-3'), sessionId: 'discard', segmentIndex: 3 },
  ];
  const h = harness(null, records);
  h.patch(1, { state: 'complete', filename: 'C:/Downloads/discard-1.webm', bytesReceived: 100, totalBytes: 100 });
  const discarded = [];
  h.respondWith(async msg => {
    if (msg.type === 'OFF_DISCARD_RECOVERY') discarded.push(msg.metadata.id);
    return { ok: 1 };
  });
  await h.send('DISCARD_RECOVERY');
  ok('明确丢弃保留下载文件但删除全部暂存副本', discarded.join(',') === 'discard-1,discard-2,discard-3' &&
    !h.local.durableRecordings?.length, discarded.join(','));
}

{
  const h = harness({ status: 'recording', mode: 'tab', segmented: true, processing: true,
    savePhase: 'downloading', downloadId: 1, downloadRecordingId: 'seg1' });
  h.patch(1, { state: 'in_progress', bytesReceived: 50, totalBytes: 100 });
  const blocked = await h.send('SAVE_FILE', {
    url: 'blob:chrome-extension://x/seg2', filename: 'part2.webm', recordingId: 'seg2', segmentIndex: 2,
  });
  ok('上一段真实下载进行中禁止新段并发', !!blocked.error);
  h.patch(1, { state: 'complete', bytesReceived: 100, filename: 'C:/Downloads/part1.webm' });
  const allowed = await h.send('SAVE_FILE', {
    url: 'blob:chrome-extension://x/seg2', filename: 'part2.webm', recordingId: 'seg2', segmentIndex: 2,
  });
  ok('即使阶段被改写为 downloading 也按真实 complete 放行', !allowed.error && allowed.downloadId === 1,
    JSON.stringify(allowed));
}

{
  const h = harness({ status: 'recording', mode: 'tab', segmented: true, processing: true,
    savePhase: 'downloading', downloadId: 2, downloadRecordingId: 'seg2' },
    { ...recoveryMeta('seg1'), downloadId: 1 });
  h.patch(1, { state: 'complete', bytesReceived: 100, filename: 'C:/Downloads/part1.webm' });
  const result = await h.send('SEGMENT_SAVED', { recordingId: 'seg1', segmentIndex: 1,
    historyEntry: { recordingId: 'seg1', filename: 'part1.webm', size: 100 } });
  ok('旧段 saved 晚于新 downloadId 仍按本段 complete 记账', !result.error &&
    h.local.recordingHistory?.[0]?.recordingId === 'seg1', JSON.stringify(result));
}

{
  const h = harness({ status: 'idle', mode: 'tab', segmented: true, segmentIndex: 3,
    savedSegments: 2, savingSegments: 1, processing: true, savePhase: 'downloading', downloadId: 3 });
  await h.send('ENGINE_PROCESSING', { active: false, scope: 'segment', segmentIndex: 3 });
  const state = await h.send('GET_STATE');
  ok('最终段处理结束仍等待会话停止通知再解除忙态', state.processing === true && state.status === 'idle',
    JSON.stringify(state));
}

{
  const h = harness(null, [recoveryMeta('wanted')]);
  h.respondWith(async msg => msg.type === 'OFF_RECOVER_RECORDING'
    ? { ok: 1, historyEntry: { filename: 'other.webm', recordingId: 'other', size: 100 } }
    : { ok: 1 });
  const result = await h.send('RECOVER_RECORDING');
  ok('恢复结果 ID 不匹配时拒绝清除真实暂存', !!result.error &&
    h.local.durableRecordings?.[0]?.id === 'wanted' && !h.local.recordingHistory?.length,
  JSON.stringify(result));
}

{
  const recovered = [];
  const deleted = [];
  let listener;
  const sandbox = {
    console,
    recoverDurableBlob: async metadata => {
      recovered.push(metadata.id);
      return { blob: new Blob(['media'], { type: 'video/webm' }), filename: `${metadata.id}.webm`, durMs: 1000 };
    },
    saveFileViaBackground: async (_blob, filename) => ({ filename, path: `C:/Downloads/${filename}` }),
    deleteDurableFile: async metadata => { deleted.push(metadata.id); },
    chrome: { runtime: {
      onMessage: { addListener: fn => { listener = fn; } },
      sendMessage: async () => ({ ok: 1 }),
    } },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'offscreen.js'), 'utf8'), sandbox, { filename: 'offscreen.js' });
  async function recover(id) {
    return new Promise((resolve, reject) => {
      const asyncReply = listener({ type: 'OFF_RECOVER_RECORDING', target: 'offscreen', metadata: { id } }, {}, resolve);
      if (!asyncReply) reject(new Error('恢复消息未异步回复'));
    });
  }
  const first = await recover('part-one');
  const second = await recover('part-two');
  ok('连续恢复使用各自 ID 而不是复用首段结果', recovered.join(',') === 'part-one,part-two' &&
    deleted.join(',') === 'part-one,part-two' && first.historyEntry.recordingId === 'part-one' &&
    second.historyEntry.recordingId === 'part-two', JSON.stringify({ recovered, deleted, second }));
}

{
  const h = harness({ status: 'recording', segmented: true, processing: true,
    completedRecordingIds: ['history-a', 'history-b'] });
  const originalGet = h.chrome.storage.local.get;
  h.chrome.storage.local.get = async key => {
    if (key !== 'recordingHistory') return originalGet(key);
    const snapshot = structuredClone(await originalGet(key));
    await new Promise(resolve => setImmediate(resolve));
    return snapshot;
  };
  await Promise.all([
    h.send('SEGMENT_SAVED', { recordingId: 'history-a', segmentIndex: 1,
      historyEntry: { recordingId: 'history-a', filename: 'a.webm', size: 100 } }),
    h.send('SEGMENT_SAVED', { recordingId: 'history-b', segmentIndex: 2,
      historyEntry: { recordingId: 'history-b', filename: 'b.webm', size: 100 } }),
  ]);
  h.chrome.storage.local.get = originalGet;
  const ids = (h.local.recordingHistory || []).map(entry => entry.recordingId).sort();
  ok('并发分段完成不会覆盖历史', ids.join(',') === 'history-a,history-b', ids.join(','));
  await h.send('SEGMENT_SAVED', { recordingId: 'history-a', segmentIndex: 1,
    historyEntry: { recordingId: 'history-a', filename: 'a.webm', size: 100 } });
  ok('重复完成事件仍按 recordingId 去重', h.local.recordingHistory.length === 2);
}

{
  const h = harness({ status: 'recording', mode: 'tab', segmented: true, processing: true,
    completedRecordingIds: ['seg1'] });
  await h.send('ENGINE_PROCESSING', { active: true, scope: 'segment', recordingId: 'seg2',
    segmentIndex: 2, sessionId: 'session-current', stage: 'webm-fix' });
  await h.send('SEGMENT_SAVED', { recordingId: 'seg1', segmentIndex: 1, sessionId: 'session-current',
    historyEntry: { recordingId: 'seg1', filename: 'part1.webm', size: 100 } });
  let state = await h.send('GET_STATE');
  ok('旧 saved 不清除新段保存状态', state.processing && state.savingSegments === 1,
    JSON.stringify(state));
  await h.send('ENGINE_PROCESSING', { active: false, scope: 'segment', recordingId: 'seg1',
    segmentIndex: 1, sessionId: 'session-current' });
  state = await h.send('GET_STATE');
  const saved = await h.send('SAVE_FILE', { url: 'blob:chrome-extension://x/seg2',
    filename: 'part2.webm', recordingId: 'seg2', segmentIndex: 2 });
  ok('旧 processing:false 不影响新段下载', state.processing && state.savingSegments === 1 && !saved.error,
    JSON.stringify({ state, saved }));
}

console.log(failed ? `\n${failed} 项失败 ❌` : '\n下载状态测试全部通过 🎉');
process.exit(failed ? 1 : 0);
