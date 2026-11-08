/**
 * background.js — Service Worker (MV3)
 *
 * 职责：
 *   1. 维护全局录制状态机 (idle | preparing | countdown | recording | paused)
 *   2. 消息路由：把 popup 的指令分发给 offscreen / recorder 窗口
 *   3. 通过 chrome.tabCapture.getMediaStreamId 取得 streamId 并跨上下文传递
 *   4. 管理录制窗口生命周期与历史记录
 *   5. 通过 chrome.downloads 确认真实落盘，维护保存阶段、进度和失败重试状态；
 *      tab 停止后打开 save-status.html，避免 popup 关闭后用户看不到保存进度
 *
 * 为什么 service worker 不直接录制？
 *   - MV3 worker 会被系统回收，无法长时间持有 MediaRecorder。
 *   - 因此把录制引擎放进 offscreen document (tab 模式) 或独立 popup 窗口
 *     (桌面/兼容模式)，与 worker 生命周期解耦 —— Chrome 最小化、popup 关闭
 *     均不影响录制。
 */

importScripts('durable-store.js');
const durableStore = createDurableStore(chrome.storage.local);

const state = {
  status: 'idle',          // idle | preparing | countdown | recording | paused
  startTime: 0,
  pausedTime: 0,
  pauseStart: 0,
  fileSize: 0,
  timeLimit: 0,            // 秒，0 = 不限
  mode: '',                // 'tab' | 'desktop'
  recorderWindowId: 0,
  recorderTabId: 0,        // desktop 模式 recorder 窗口里的 tab id（用于转发指令）
  countdownRemaining: 0,
  processing: false,       // 引擎正在保存/转码/等待下载结果（含失败待处理）
  savePhase: '',           // '' | processing | downloading | complete | error
  processingStage: '',     // webm-fix | mp4-fix | transcode | download
  downloadId: 0,
  saveError: '',
  saveFilename: '',
  saveWindowId: 0,
  saveCanRetry: false,
  saveReceived: 0,
  saveTotal: 0,
  saveGeneration: 0,        // 新录制/重试递增，防止旧异步结果提交到新任务
  recoveryAvailable: false,
  recoveryBusy: false,
  durableBytes: 0,
  segmented: false,
  segmentSessionId: '',
  processingSegmentIds: [],
  segmentIndex: 0,
  savedSegments: 0,
  savingSegments: 0,
  savingSegmentIndex: 0,
  downloadRecordingId: '',
  completedRecordingIds: [],
};

/* ═══════════════════════════════════════════════════════
   状态持久化（MV3 SW 回收后状态不丢）

   MV3 SW 空闲 ~30s 会被回收，唤醒后所有内存变量归零。
   把 state 镜像到 chrome.storage.session：
     - 写：任何变更都 fire-and-forget 写回
     - 读：SW 脚本加载时立即发起恢复（不阻塞顶层），route 时 await
   用 session 而非 local：录制状态是会话级的，浏览器重启后不该残留。
   ═══════════════════════════════════════════════════════ */

const STATE_KEY = 'recorderState';

/** 统一的状态变更入口：改完立即持久化。 */
function setState(patch) {
  Object.assign(state, patch);
  chrome.storage.session.set({ [STATE_KEY]: state }).catch(() => {});
}

function resetSaveResult() {
  setState({
    savePhase: '', processingStage: '', downloadId: 0,
    saveError: '', saveFilename: '', saveWindowId: 0,
    saveCanRetry: false, saveReceived: 0, saveTotal: 0,
  });
}

/** SW 启动时异步恢复 state；返回 Promise。 */
function restoreState() {
  return chrome.storage.session.get(STATE_KEY).then(d => {
    if (d[STATE_KEY] && typeof d[STATE_KEY] === 'object') {
      Object.assign(state, d[STATE_KEY]);
    }
  }).catch(() => {});
}

function durableBytes(records) {
  return records.reduce((total, record) => total + (record.bytes || 0), 0);
}

function isCurrentSegment(msg) {
  if (!state.segmented) {
    return state.status === 'idle' && !!msg.sessionId && msg.sessionId === state.segmentSessionId;
  }
  if (msg.sessionId && state.segmentSessionId && msg.sessionId !== state.segmentSessionId) return false;
  if (msg.sessionId && !state.segmentSessionId) setState({ segmentSessionId: msg.sessionId });
  return true;
}

function segmentProcessingPatch(ids) {
  return {
    processingSegmentIds: ids,
    savingSegments: ids.length,
    processing: ids.length > 0 || state.savePhase === 'downloading' ||
      (state.segmented && state.status === 'idle'),
  };
}

function orderedDurable(records) {
  return [...records].sort((a, b) =>
    String(a.sessionId || '').localeCompare(String(b.sessionId || '')) ||
    (a.segmentIndex || 0) - (b.segmentIndex || 0) || (a.startedAt || 0) - (b.startedAt || 0));
}

// 顶层立即发起恢复；route() 会 await 它们
const stateReady = restoreState();
const recoveryReady = (async () => {
  await stateReady;
  try {
    const records = await durableStore.list();
    if (!records.length) return;
    const resuming = state.recoveryBusy;
    const owned = resuming ? false : await hasLiveEngineOwner();
    setState({ recoveryAvailable: !owned, durableBytes: durableBytes(records) });
    if (resuming) {
      Promise.resolve().then(() => recoverExistingRecording()).catch(() => {});
    }
  } catch (_) {}
})();

async function hasLiveEngineOwner() {
  try {
    if (state.mode === 'tab') {
      if (!chrome.runtime.getContexts) return false;
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      return contexts.length > 0;
    }
    if (state.mode === 'desktop' && state.recorderWindowId) {
      await chrome.windows.get(state.recorderWindowId);
      return true;
    }
  } catch (_) {}
  return false;
}

function downloadBasename(path) {
  return (path || '').replace(/\\/g, '/').split('/').pop() || '';
}

async function refreshDownloadStatus(downloadId) {
  if (!downloadId || downloadId !== state.downloadId) return { error: '下载任务不存在或已过期' };
  const generation = state.saveGeneration;
  const [item] = await chrome.downloads.search({ id: downloadId });
  if (generation !== state.saveGeneration || downloadId !== state.downloadId) {
    return { error: '下载任务已替换，忽略过期结果' };
  }
  if (!item) {
    setState({ savePhase: 'error', saveError: 'DOWNLOAD_NOT_FOUND' });
    return { state: 'interrupted', error: 'DOWNLOAD_NOT_FOUND', filename: state.saveFilename, path: '', received: 0, total: 0 };
  }
  const currentState = item.state || 'interrupted';
  const received = item.bytesReceived || 0;
  const total = item.totalBytes > 0 ? item.totalBytes : 0;
  const filename = downloadBasename(item.filename) || state.saveFilename;
  setState({
    savePhase: currentState === 'complete' ? 'complete' : currentState === 'interrupted' ? 'error' : 'downloading',
    saveError: item.error || '',
    saveFilename: filename,
    saveReceived: received,
    saveTotal: total,
    completedRecordingIds: currentState === 'complete' && state.downloadRecordingId
      ? [...new Set([...(state.completedRecordingIds || []), state.downloadRecordingId])].slice(-100)
      : (state.completedRecordingIds || []),
  });
  return {
    state: currentState,
    error: item.error,
    filename,
    path: item.filename || '',
    received,
    total,
  };
}

chrome.downloads.onChanged.addListener(async delta => {
  await stateReady;
  if (delta.id !== state.downloadId) return;
  try { await refreshDownloadStatus(delta.id); } catch (_) {}
});

/* ═══════════════════════════════════════════════════════
   Offscreen 生命周期
   ═══════════════════════════════════════════════════════ */

async function ensureOffscreen() {
  // 同一扩展只能有一个 offscreen document，先查重避免报错
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (ctx.length > 0) return;
  }
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA', 'DISPLAY_MEDIA', 'AUDIO_PLAYBACK'],
    justification: '录制标签页画面与声音，并把标签页音频回环到扬声器',
  });
}

/* ═══════════════════════════════════════════════════════
   录制窗口被关闭 → 归位状态

   必须顶层注册：MV3 只持久化顶层同步注册的 listener。原先在
   openRecorderWindow 的异步流程里注册，SW 被回收后监听丢失，
   用户关窗无人清理状态，storage.session 里残留假「录制中」。
   ═══════════════════════════════════════════════════════ */

function markSaveContextLost(message) {
  setState({
    status: 'idle',
    processing: false,
    savePhase: 'error',
    processingStage: '',
    saveError: message,
    saveCanRetry: false,
  });
  badge('error');
}

let saveWindowPromise = null;

async function openSaveWindow() {
  if (saveWindowPromise) return await saveWindowPromise;
  const pending = (async () => {
    if (state.saveWindowId) {
      try {
        await chrome.windows.update(state.saveWindowId, { focused: true });
        return state.saveWindowId;
      } catch (_) {
        setState({ saveWindowId: 0 });
      }
    }
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL('save-status.html'),
      type: 'popup', width: 420, height: 360, focused: true,
    });
    setState({ saveWindowId: win.id });
    return win.id;
  })();
  saveWindowPromise = pending;
  try {
    return await pending;
  } finally {
    if (saveWindowPromise === pending) saveWindowPromise = null;
  }
}

let recoveryInFlight = null;

function recoveryHistory(meta, filename, size) {
  const seconds = Math.max(0, Math.floor((meta.mediaTimeMs || 0) / 1000));
  return {
    filename,
    size: size || meta.bytes || 0,
    duration: [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
      .map(value => String(value).padStart(2, '0')).join(':'),
    date: new Date().toLocaleString('zh-CN'),
    format: meta.recordedIsMp4 || meta.outputFormat === 'mp4' ? 'mp4' : 'webm',
    recordingId: meta.id,
  };
}

async function finishRecovery(meta, entry) {
  const historyEntry = entry || recoveryHistory(meta, state.saveFilename, state.saveTotal);
  await saveHistory(historyEntry);
  await durableStore.remove(meta.id);
  const remaining = await durableStore.list();
  if (remaining.length) {
    setState({
      status: 'idle', processing: true, savePhase: 'processing', processingStage: '',
      saveFilename: historyEntry.filename, saveCanRetry: true,
      recoveryAvailable: true, recoveryBusy: true, durableBytes: durableBytes(remaining),
    });
    badge('saving');
    return { ok: 1, remaining: remaining.length };
  }
  setState({
    status: 'idle', processing: false, savePhase: 'complete', processingStage: '',
    saveFilename: historyEntry.filename, saveCanRetry: false,
    recoveryAvailable: false, recoveryBusy: false, durableBytes: 0,
  });
  badge('idle');
  return { ok: 1 };
}

async function discardRecoveryFile(meta) {
  await ensureOffscreen();
  const result = await chrome.runtime.sendMessage({
    type: 'OFF_DISCARD_RECOVERY', target: 'offscreen', metadata: meta,
  });
  if (!result || result.error) throw new Error((result && result.error) || '无法删除恢复文件');
}

function recoverExistingRecording() {
  if (recoveryInFlight) return recoveryInFlight;
  recoveryInFlight = (async () => {
    const records = orderedDurable(await durableStore.list());
    if (!records.length) return { error: '没有可恢复的录制' };
    recoverSegments: for (const pending of records) {
      let meta = pending;
      setState({ recoveryAvailable: true, recoveryBusy: true, durableBytes: meta.bytes || 0 });

      if (!meta.downloadId && meta.downloadIntent) {
        const intent = meta.downloadIntent;
        const dot = intent.filename.lastIndexOf('.');
        const stem = dot >= 0 ? intent.filename.slice(0, dot) : intent.filename;
        const extension = dot >= 0 ? intent.filename.slice(dot) : '';
        const candidates = await chrome.downloads.search({
          startedAfter: new Date(Math.max(0, intent.startedAt - 1000)).toISOString(),
        });
        candidates.sort((a, b) => Date.parse(b.startTime || 0) - Date.parse(a.startTime || 0));
        const item = candidates.find(candidate => {
          if (intent.url) return (candidate.finalUrl || candidate.url) === intent.url;
          const name = downloadBasename(candidate.filename);
          return name === intent.filename ||
            (name.startsWith(stem + ' (') && name.endsWith(')' + extension));
        });
        meta = { ...meta, downloadIntent: null };
        if (item) {
          meta.downloadId = item.id;
          meta.phase = 'downloading';
        }
        await durableStore.upsert(meta);
      }

      if (meta.downloadId) {
        const [item] = await chrome.downloads.search({ id: meta.downloadId });
        if (item && item.state === 'complete') {
          const filename = downloadBasename(item.filename) || state.saveFilename;
          await discardRecoveryFile(meta);
          await finishRecovery(meta, recoveryHistory(meta, filename, item.totalBytes));
          continue recoverSegments;
        }
        if (item && item.state === 'in_progress') {
          setState({
            processing: true, savePhase: 'downloading', processingStage: 'download',
            downloadId: meta.downloadId, saveFilename: downloadBasename(item.filename),
            saveCanRetry: true,
          });
          await openSaveWindow();
          for (;;) {
            const status = await refreshDownloadStatus(meta.downloadId);
            if (status.state === 'complete') {
              await discardRecoveryFile(meta);
              await finishRecovery(meta, recoveryHistory(meta, status.filename, status.total));
              continue recoverSegments;
            }
            if (status.state === 'interrupted' || status.error) break;
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
        meta = { ...meta, downloadId: 0, phase: 'error' };
        await durableStore.upsert(meta);
      }

      setState({
        status: 'idle', processing: true, savePhase: 'processing',
        processingStage: meta.recordedIsMp4 ? 'mp4-fix' : 'webm-fix',
        downloadId: 0, saveError: '', saveReceived: 0, saveTotal: 0,
        saveCanRetry: true, recoveryAvailable: true, recoveryBusy: true,
        saveGeneration: state.saveGeneration + 1,
      });
      badge('saving');
      await openSaveWindow();
      await ensureOffscreen();
      const result = await chrome.runtime.sendMessage({
        type: 'OFF_RECOVER_RECORDING', target: 'offscreen', metadata: meta,
      });
      if (!result || result.error) throw new Error((result && result.error) || '恢复请求未送达');
      if (!result.historyEntry || result.historyEntry.recordingId !== meta.id) {
        throw new Error('恢复结果与暂存记录不匹配，已保留原暂存');
      }
      await finishRecovery(meta, result.historyEntry);
    }
    return { ok: 1 };
  })().catch(error => {
    setState({
      status: 'idle', processing: true, savePhase: 'error', processingStage: '',
      saveError: error.message || String(error), saveCanRetry: true,
      recoveryAvailable: true, recoveryBusy: false,
    });
    badge('error');
    return { error: error.message || String(error) };
  }).finally(() => { recoveryInFlight = null; });
  return recoveryInFlight;
}

function discardRecovery() {
  if (recoveryInFlight) return Promise.resolve({ error: '正在处理录制，请稍候' });
  recoveryInFlight = (async () => {
    const records = orderedDurable(await durableStore.list());
    for (const meta of records) {
      if (meta.downloadId) {
        const [item] = await chrome.downloads.search({ id: meta.downloadId });
        if (item && item.state === 'complete') {
          await discardRecoveryFile(meta);
          continue;
        }
        if (item && item.state === 'in_progress') {
          try { await chrome.downloads.cancel(meta.downloadId); } catch (_) {}
        }
      }
      await discardRecoveryFile(meta);
    }
    await durableStore.clear();
    resetSaveResult();
    setState({ recoveryAvailable: false, recoveryBusy: false, durableBytes: 0, processing: false });
    badge('idle');
    return { ok: 1 };
  })().finally(() => { recoveryInFlight = null; });
  return recoveryInFlight;
}

async function reconcileEngineContext() {
  const active = state.processing || ['countdown', 'recording', 'paused'].includes(state.status);
  if (!active || state.mode !== 'tab' || !chrome.runtime.getContexts) return;
  const generation = state.saveGeneration;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (generation !== state.saveGeneration || contexts.length) return;
  const records = await durableStore.list();
  if (records.length) {
    setState({
      status: 'idle', processing: false, savePhase: 'error',
      saveError: '录制上下文已关闭，可从磁盘暂存恢复', saveCanRetry: true,
      recoveryAvailable: true, recoveryBusy: false,
      durableBytes: durableBytes(records),
    });
    badge('error');
  } else if (state.processing) {
    markSaveContextLost('录制上下文已关闭，无法继续保存');
  } else {
    setState({ status: 'idle' });
    badge('idle');
  }
}

chrome.windows.onRemoved.addListener(async windowId => {
  await stateReady;   // SW 刚被唤醒时 state 可能尚未恢复
  if (windowId && windowId === state.saveWindowId && state.saveWindowId !== 0) {
    setState({ saveWindowId: 0 });
    return;
  }
  if (windowId && windowId === state.recorderWindowId && state.recorderWindowId !== 0) {
    setState({ recorderWindowId: 0, recorderTabId: 0 });
    const records = await durableStore.list();
    if (records.length) {
      setState({
        status: 'idle', processing: false, savePhase: 'error',
        saveError: '录制窗口已关闭，可从磁盘暂存恢复', saveCanRetry: true,
        recoveryAvailable: true, recoveryBusy: false,
        durableBytes: durableBytes(records),
      });
      badge('error');
    } else if (state.processing) {
      markSaveContextLost('录制窗口已关闭，无法继续保存');
    } else if (state.status !== 'idle') {
      setState({ status: 'idle' });
      badge('idle');
    }
  }
});

/* ═══════════════════════════════════════════════════════
   消息路由
   ═══════════════════════════════════════════════════════ */

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  route(msg, sender).then(reply).catch(e => reply({ error: e.message }));
  return true; // 异步回复
});

async function route(msg, sender = {}) {
  await stateReady;   // 确保 SW 回收后已恢复 state
  await recoveryReady;
  switch (msg.type) {

    /* ── 开始录制（来自 popup）────────────────────────── */
    case 'START_RECORDING': {
      // 重入守卫：录制中/倒计时中/保存中不允许再起一段，否则旧引擎失去引用
      // 仍在录制（幽灵录制），且旧链的 RECORDING_STOPPED 会把新状态掐掉
      if (state.status !== 'idle' || state.processing) {
        return { error: '已有录制进行中或仍在保存，请先停止' };
      }
      const durable = await durableStore.list();
      if (durable.length) {
        return { error: '发现未完成的录制，请先恢复保存或明确丢弃' };
      }
      resetSaveResult();
      setState({
        saveGeneration: state.saveGeneration + 1,
        segmented: !!msg.segmentEnabled, segmentSessionId: '', processingSegmentIds: [],
        segmentIndex: 0, savedSegments: 0, savingSegments: 0,
        savingSegmentIndex: 0, downloadRecordingId: '', completedRecordingIds: [],
      });
      if (msg.source === 'tab' && !msg.compatMode) return await startTabRecording(msg);
      if (msg.source === 'tab' && msg.compatMode)  return await startCompatTabRecording(msg);
      return await startDesktopRecording(msg);
    }

    /* ── 停止录制 ─────────────────────────────────────── */
    case 'STOP_RECORDING': {
      if (state.status === 'preparing') {
        if (state.mode === 'desktop' && state.recorderWindowId) {
          try { await chrome.windows.remove(state.recorderWindowId); } catch (_) {}
        }
        setState({
          status: 'idle', startTime: 0, recorderWindowId: 0, recorderTabId: 0,
          processing: false, countdownRemaining: 0,
        });
        badge('idle');
        return { ok: 1 };
      }
      const finalizing = state.status === 'recording' || state.status === 'paused';
      // 发停止指令让引擎跑完 onStopped（保存文件）；
      // desktop 模式引擎保存完会自己关窗口，无需在这里直接 remove
      await sendToRecorderEngine('OFF_STOP');
      if (finalizing) {
        setState({ status: 'idle', processing: true, savePhase: 'processing', processingStage: 'finalizing' });
        badge('saving');
      } else {
        setState({ status: 'idle' });
        badge('idle');
      }
      return { ok: 1 };
    }

    /* ── 暂停 / 恢复 ──────────────────────────────────── */
    case 'PAUSE_RECORDING': {
      await sendToRecorderEngine('OFF_PAUSE');
      setState({ status: 'paused', pauseStart: Date.now() });
      badge('paused');
      return { ok: 1 };
    }
    case 'RESUME_RECORDING': {
      await sendToRecorderEngine('OFF_RESUME');
      setState({
        pausedTime: state.pausedTime + (Date.now() - state.pauseStart),
        status: 'recording',
      });
      badge('recording');
      return { ok: 1 };
    }

    /* ── 丢弃 ─────────────────────────────────────────── */
    case 'DISCARD_RECORDING': {
      if (state.processing && (state.savePhase !== 'error' || !state.saveCanRetry)) {
        return { error: '视频正在保存，暂不能丢弃' };
      }
      await sendToRecorderEngine('OFF_DISCARD');
      setState({ status: 'idle', fileSize: 0, processing: false });
      resetSaveResult();
      badge('idle');
      return { ok: 1 };
    }

    /* ── 状态查询（popup 轮询）────────────────────────── */
    case 'GET_STATE': {
      await reconcileEngineContext();
      const records = await durableStore.list();
      return { ...state, recoveryCount: records.length, durableBytes: durableBytes(records) };
    }

    case 'OPEN_RECORDER_WINDOW': {
      if (state.mode !== 'desktop' || !state.recorderWindowId) {
        return { error: '当前没有可打开的录制窗口' };
      }
      const windowId = state.recorderWindowId;
      try {
        await chrome.windows.update(windowId, { focused: true });
        return { ok: 1, windowId };
      } catch (_) {
        try {
          await chrome.windows.get(windowId);
          return { error: '录制窗口暂时无法聚焦' };
        } catch (_) {
          if (windowId !== state.recorderWindowId) return { error: '录制窗口已变化' };
          setState({ recorderWindowId: 0, recorderTabId: 0 });
          if (state.processing || state.status !== 'preparing' && state.status !== 'idle') {
            markSaveContextLost('录制窗口已关闭，录制已中止');
          } else if (state.status === 'preparing') {
            setState({ status: 'idle', startTime: 0, processing: false });
            badge('idle');
          }
          return { error: '录制窗口已关闭或不可用' };
        }
      }
    }

    case 'OPEN_SAVE_WINDOW': {
      if (state.mode !== 'tab' && !state.recoveryAvailable) return { error: '当前录制使用桌面保存窗口' };
      return { ok: 1, windowId: await openSaveWindow() };
    }

    case 'RECOVER_RECORDING':
      return await recoverExistingRecording();

    case 'RECOVERY_COMPLETE': {
      const entry = msg.historyEntry;
      if (!entry || !entry.recordingId) return { error: '恢复完成记录无效' };
      const records = await durableStore.list();
      const meta = records.find(record => record.id === entry.recordingId);
      if (!meta) return { ok: 1 };
      return await finishRecovery(meta, entry);
    }

    case 'DISCARD_RECOVERY':
      return await discardRecovery();

    case 'RETRY_SAVE': {
      if (state.recoveryAvailable) return await recoverExistingRecording();
      if (state.savePhase !== 'error' || !state.saveCanRetry) {
        return { error: '当前没有可重试的保存任务' };
      }
      const generation = state.saveGeneration + 1;
      setState({
        processing: true, savePhase: 'processing', processingStage: 'download',
        downloadId: 0, saveError: '', saveReceived: 0, saveTotal: 0,
        saveGeneration: generation,
      });
      badge('saving');
      const result = await sendToRecorderEngine('OFF_RETRY_SAVE');
      if (generation !== state.saveGeneration) return { error: '保存任务已替换，忽略过期结果' };
      if (result === true || result?.ok === 1) return { ok: 1 };
      const message = result?.error || '重试请求未送达或保存尚未完成，请保持录制上下文打开后重试';
      setState({
        status: 'idle', processing: true, savePhase: 'error', processingStage: '',
        saveError: message, saveCanRetry: true,
      });
      badge('error');
      return { error: message };
    }

    case 'SAVE_FILE': {
      if (!state.processing) return { error: '当前没有待保存的录制' };
      const newSegment = state.segmented && msg.recordingId && msg.recordingId !== state.downloadRecordingId;
      if (newSegment && state.downloadId) {
        const [previous] = await chrome.downloads.search({ id: state.downloadId });
        if (!previous || previous.state !== 'complete') return { error: '上一段尚未下载完成' };
      }
      if (state.savePhase === 'downloading' && state.downloadId && !newSegment) {
        return { error: '当前录制已有下载任务' };
      }
      if (state.savePhase === 'complete' && !newSegment) {
        return { error: '当前录制已有下载任务' };
      }
      if (typeof msg.url !== 'string' || !msg.url.startsWith('blob:') || !msg.filename) {
        return { error: '保存参数无效' };
      }
      if (newSegment) {
        setState({
          saveGeneration: state.saveGeneration + 1,
          savePhase: 'processing', processingStage: '', downloadId: 0,
          saveError: '', saveFilename: '', saveCanRetry: true,
          saveReceived: 0, saveTotal: 0, downloadRecordingId: msg.recordingId,
        });
      }
      const generation = state.saveGeneration;
      const records = await durableStore.list();
      const durableBefore = msg.recordingId
        ? records.find(record => record.id === msg.recordingId) : records[0];
      if (durableBefore) {
        await durableStore.upsert({
          ...durableBefore, phase: 'processing', downloadId: 0,
          downloadIntent: { filename: msg.filename, url: msg.url, startedAt: Date.now(), generation },
        });
      }
      const downloadId = await chrome.downloads.download({
        url: msg.url,
        filename: msg.filename,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      if (generation !== state.saveGeneration) {
        return { error: '保存任务已替换，忽略过期下载' };
      }
      setState({
        savePhase: 'downloading', processingStage: 'download', downloadId,
        saveError: '', saveFilename: msg.filename, saveCanRetry: true,
        saveReceived: 0, saveTotal: 0,
        downloadRecordingId: msg.recordingId || state.downloadRecordingId,
      });
      if (durableBefore) {
        await durableStore.upsert({
          ...durableBefore, phase: 'downloading', downloadId, downloadIntent: null,
        });
      }
      return { downloadId };
    }

    case 'GET_DOWNLOAD_STATUS':
      return await refreshDownloadStatus(msg.downloadId);

    /* ── offscreen / recorder 窗口取 tab 的 streamId ──────
       延迟到录制真正开始前才取：getMediaStreamId 的 id 应尽快消费，
       提前取好再等待倒计时/选屏（可达数分钟）有失效风险 ── */
    case 'GET_STREAM_ID': {
      try {
        return { streamId: await getStreamId(msg.tabId) };
      } catch (e) {
        return { error: e.message };
      }
    }

    /* ── 来自 offscreen / recorder 的事件 ─────────────── */
    case 'SEGMENT_STARTED': {
      if (!state.segmented || state.status === 'idle' || !isCurrentSegment(msg)) {
        return { error: '分段会话已替换' };
      }
      setState({
        segmented: true,
        segmentIndex: Math.max(state.segmentIndex, msg.segmentIndex || 0),
        savingSegmentIndex: msg.segmentIndex || 0,
      });
      return { ok: 1 };
    }
    case 'SEGMENT_SAVED': {
      if (!isCurrentSegment(msg)) return { error: '分段会话已替换' };
      const entry = msg.historyEntry;
      if (!entry || entry.recordingId !== msg.recordingId) return { error: '分段完成记录无效' };
      const records = await durableStore.list();
      const meta = records.find(record => record.id === msg.recordingId);
      let completed = (state.completedRecordingIds || []).includes(msg.recordingId);
      if (!completed && meta && meta.downloadId) {
        const [item] = await chrome.downloads.search({ id: meta.downloadId });
        completed = !!item && item.state === 'complete';
      }
      if (!completed) return { error: '分段尚未下载完成' };
      await saveHistory(entry);
      if (!state.segmented) {
        setState({ savePhase: 'complete', saveCanRetry: false });
        return { ok: 1 };
      }
      const ids = (state.processingSegmentIds || []).filter(id => id !== msg.recordingId);
      setState({
        segmented: true,
        savedSegments: Math.max(state.savedSegments, msg.segmentIndex || 0),
        processingStage: ids.length ? state.processingStage : '',
        ...segmentProcessingPatch(ids),
      });
      badge(state.status);
      return { ok: 1 };
    }
    case 'RECORDING_STOPPED':
    case 'RECORDER_STOPPED': {
      if (msg.captureFailed && state.status === 'preparing' &&
          state.mode === 'desktop' && state.recorderWindowId) {
        resetSaveResult();
        setState({
          status: 'preparing', startTime: 0, pausedTime: 0, pauseStart: 0,
          fileSize: 0, processing: false,
        });
        badge('preparing');
        return { ok: 1 };
      }
      await durableStore.clear();
      setState({ status: 'idle', fileSize: 0, recorderWindowId: 0, recorderTabId: 0,
        processing: false, recoveryAvailable: false, recoveryBusy: false, durableBytes: 0,
        segmented: false, processingSegmentIds: [], segmentIndex: 0, savedSegments: 0, savingSegments: 0,
        savingSegmentIndex: 0, downloadRecordingId: '' });
      if (msg.discarded) {
        resetSaveResult();
      } else if (msg.historyEntry) {
        setState({ savePhase: 'complete', saveCanRetry: false });
        await saveHistory(msg.historyEntry);
      }
      badge('idle');
      return { ok: 1 };
    }

    case 'ENGINE_SAVE_ERROR': {
      const canRetry = msg.canRetry !== false;
      setState({
        status: 'idle',
        processing: canRetry,
        savePhase: 'error',
        processingStage: '',
        saveError: msg.message || '保存失败',
        saveCanRetry: canRetry,
      });
      badge(canRetry ? 'error' : 'idle');
      if (canRetry && state.mode === 'tab') await openSaveWindow();
      return { ok: 1 };
    }

    /* ── 引擎侧发起的暂停/恢复（recorder 窗口本地按钮）─────
       幂等：popup 下行路径（PAUSE/RESUME_RECORDING）已记账时不重复 ── */
    case 'ENGINE_PAUSED': {
      if (state.status === 'recording') {
        setState({ status: 'paused', pauseStart: Date.now() });
        badge('paused');
      }
      return { ok: 1 };
    }
    case 'ENGINE_RESUMED': {
      if (state.status === 'paused') {
        setState({
          pausedTime: state.pausedTime + (Date.now() - state.pauseStart),
          status: 'recording',
        });
        badge('recording');
      }
      return { ok: 1 };
    }
    case 'ENGINE_PROCESSING':   // 引擎进入/离开保存链（fixWebM/转码/下载）
      if (msg.scope === 'segment') {
        if (!state.segmented || !isCurrentSegment(msg)) return { ok: 1 };
        const id = msg.recordingId || `index-${msg.segmentIndex || 0}`;
        const previous = state.processingSegmentIds || [];
        const ids = msg.active ? [...new Set([...previous, id])] : previous.filter(item => item !== id);
        setState(msg.active ? {
          segmented: true,
          savePhase: msg.stage === 'download' ? 'downloading' :
            (state.savePhase === 'error' || state.savePhase === 'downloading' ? state.savePhase : 'processing'),
          processingStage: msg.stage || state.processingStage, saveCanRetry: true,
          savingSegmentIndex: msg.segmentIndex || 0,
          ...segmentProcessingPatch(ids),
        } : {
          ...segmentProcessingPatch(ids),
          processingStage: ids.length ? state.processingStage : '',
          savingSegmentIndex: ids.length ? state.savingSegmentIndex : 0,
        });
        badge(state.status);
        return { ok: 1 };
      }
      if (msg.active) {
        setState({
          status: 'idle',
          processing: true,
          savePhase: msg.stage === 'download' ? 'downloading' : 'processing',
          processingStage: msg.stage || '',
          saveCanRetry: true,
        });
        badge('saving');
        if (state.mode === 'tab') await openSaveWindow();
      } else {
        setState({ processing: false, processingStage: '' });
      }
      return { ok: 1 };
    case 'RECORDER_STARTED': {
      const senderTabId = sender.tab && sender.tab.id;
      if (state.mode !== 'desktop' || state.status !== 'preparing' || !state.recorderWindowId) {
        return { error: '录制已开始或已取消' };
      }
      if (state.recorderTabId && senderTabId && senderTabId !== state.recorderTabId) {
        return { error: '录制窗口不匹配' };
      }
      setState({
        status: 'recording',
        startTime: Date.now(),
        pausedTime: 0,
      });
      badge('recording');
      return { ok: 1 };
    }
    case 'FILE_SIZE_UPDATE':
      setState({ fileSize: msg.size || 0 });
      return { ok: 1 };
    case 'COUNTDOWN_TICK':
      setState({ countdownRemaining: msg.remaining || 0 });
      return { ok: 1 };

    case 'DURABLE_CLEANUP': {
      await durableStore.remove(msg.id);
      const records = await durableStore.list();
      setState({ durableBytes: durableBytes(records) });
      return { ok: 1 };
    }

    case 'DURABLE_UPDATE': {
      const patch = msg.patch;
      if (!patch || typeof patch.id !== 'string' || !patch.id) return { error: '暂存元数据无效' };
      await durableStore.upsert(patch);
      if (Number.isFinite(patch.bytes)) {
        const records = await durableStore.list();
        setState({ durableBytes: durableBytes(records) });
      }
      return { ok: 1 };
    }

    default:
      return null;
  }
}

/* ═══════════════════════════════════════════════════════
   指令转发：把 popup 的控制指令送到对应的录制引擎
     - mode==='tab'     → offscreen document（chrome.runtime.sendMessage）
     - mode==='desktop' → recorder 窗口里的 tab（chrome.tabs.sendMessage）
   ═══════════════════════════════════════════════════════ */

async function sendToRecorderEngine(type, extra = {}) {
  if (state.mode === 'tab') {
    try {
      return await chrome.runtime.sendMessage({ type, target: 'offscreen', ...extra });
    } catch (_) { return null; }
  } else if (state.mode === 'desktop' && state.recorderTabId) {
    try {
      return await chrome.tabs.sendMessage(state.recorderTabId, { type, ...extra });
    } catch (_) { return null; }
  }
  return null;
}

/* ═══════════════════════════════════════════════════════
   标签页录制 → offscreen document
   ═══════════════════════════════════════════════════════ */

async function startTabRecording(msg) {
  await ensureOffscreen();

  const tab = await activeTab();
  if (!tab) throw new Error('未找到活动标签页');

  setState({ status: 'countdown', mode: 'tab' });

  // 不传 streamId：offscreen 倒计时结束后通过 GET_STREAM_ID 现取现用
  const result = await chrome.runtime.sendMessage({
    type: 'OFF_START',
    target: 'offscreen',
    tabId: tab.id,
    playTabAudio: msg.playTabAudio,
    width: msg.width,
    height: msg.height,
    fps: msg.fps,
    quality: msg.quality,
    timeLimit: msg.timeLimit || 0,
    countdownSec: msg.countdownSec || 0,
    outputFormat: msg.outputFormat || 'webm',
    segmentEnabled: !!msg.segmentEnabled,
    segmentMinutes: msg.segmentMinutes || 30,
  });

  if (result?.error) {
    // OFF_START 失败（取流被拒、倒计时被取消等）：回滚状态，否则会永远卡在 countdown
    setState({ status: 'idle', countdownRemaining: 0 });
    badge('idle');
    throw new Error(result.error);
  }

  setState({
    status: 'recording',
    startTime: Date.now(),
    pausedTime: 0, pauseStart: 0, fileSize: 0,
    timeLimit: msg.timeLimit || 0,
    countdownRemaining: 0,
  });
  badge('recording');
  return { ok: 1 };
}

/* ═══════════════════════════════════════════════════════
   兼容模式（云桌面 / RDP：tabCapture 音频劫持失效）
   - 画面：tabCapture 仅取视频（不劫持音频 → 标签页仍可发声）
   - 声音：getDisplayMedia 取系统音频
   ═══════════════════════════════════════════════════════ */

async function startCompatTabRecording(msg) {
  const tab = await activeTab();
  if (!tab) throw new Error('未找到活动标签页');

  const params = new URLSearchParams({
    source: 'tab-compat',
    playTabAudio: msg.playTabAudio ? '1' : '0',
    width: String(msg.width || 1920),
    height: String(msg.height || 1080),
    fps: String(msg.fps || 30),
    quality: String(msg.quality || 8000000),
    timeLimit: String(msg.timeLimit || 0),
    tabId: String(tab.id),   // streamId 由 recorder 窗口选屏结束后经 GET_STREAM_ID 现取
    outputFormat: msg.outputFormat || 'webm',
    segmentEnabled: msg.segmentEnabled ? '1' : '0',
    segmentMinutes: String(msg.segmentMinutes || 30),
  });
  return await openRecorderWindow(params, msg.timeLimit || 0);
}

/* ═══════════════════════════════════════════════════════
   窗口 / 屏幕录制 → recorder 窗口（getDisplayMedia 需用户手势）
   ═══════════════════════════════════════════════════════ */

async function startDesktopRecording(msg) {
  const params = new URLSearchParams({
    source: msg.source,            // 'window' | 'screen'
    width: String(msg.width || 1920),
    height: String(msg.height || 1080),
    fps: String(msg.fps || 30),
    quality: String(msg.quality || 8000000),
    timeLimit: String(msg.timeLimit || 0),
    outputFormat: msg.outputFormat || 'webm',
    segmentEnabled: msg.segmentEnabled ? '1' : '0',
    segmentMinutes: String(msg.segmentMinutes || 30),
  });
  return await openRecorderWindow(params, msg.timeLimit || 0);
}

async function openRecorderWindow(params, timeLimit) {
  const url = chrome.runtime.getURL('recorder.html') + '#' + params.toString();
  const win = await chrome.windows.create({
    url,
    type: 'popup',
    width: 400,
    height: 380,
    focused: true,
  });

  // popup 窗口自带一个 tab；记录其 id，用于转发暂停/停止指令
  const tabId = win.tabs && win.tabs[0] ? win.tabs[0].id : 0;

  setState({
    mode: 'desktop',
    recorderWindowId: win.id,
    recorderTabId: tabId,
    status: 'preparing',
    startTime: 0,
    pausedTime: 0,
    fileSize: 0,
    timeLimit: timeLimit || 0,
  });
  badge('preparing');

  return { ok: 1 };
}

/* ═══════════════════════════════════════════════════════
   工具函数
   ═══════════════════════════════════════════════════════ */

function getStreamId(tabId) {
  return new Promise((res, rej) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, id => {
      if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
      else res(id);
    });
  });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function badge(mode) {
  const m = {
    recording: { text: 'REC', color: '#ff4757' },
    preparing: { text: 'WAIT', color: '#ffa502' },
    paused:    { text: '❚❚', color: '#ffa502' },
    saving:    { text: 'SAVE', color: '#ffa502' },
    error:     { text: '!',   color: '#ff4757' },
    idle:      { text: '',    color: '#000' },
  };
  const b = m[mode] || m.idle;
  chrome.action.setBadgeText({ text: b.text });
  chrome.action.setBadgeBackgroundColor({ color: b.color });
}

let historyWriteQueue = Promise.resolve();

function saveHistory(entry) {
  const write = historyWriteQueue.then(async () => {
    const data = await chrome.storage.local.get('recordingHistory');
    const h = data.recordingHistory || [];
    if (entry.recordingId && h.some(item => item.recordingId === entry.recordingId)) return;
    h.unshift(entry);
    if (h.length > 30) h.length = 30;
    await chrome.storage.local.set({ recordingHistory: h });
  });
  historyWriteQueue = write.catch(() => {});
  return write;
}

/* ── 安装时写入默认设置 ────────────────────────────────── */

chrome.runtime.onInstalled.addListener(d => {
  if (d.reason === 'install') {
    chrome.storage.local.set({
      recorderSettings: {
        source: 'tab',
        playTabAudio: true,
        compatMode: false,
        countdown: '3',
        width: 1920,
        height: 1080,
        fps: 30,
        quality: '8000000',
        outputFormat: 'webm',
        segmentEnabled: false, segmentMinutes: '30',
        tlH: '0', tlM: '0', tlS: '0',
      },
      recordingHistory: [],
    });
  }
});
