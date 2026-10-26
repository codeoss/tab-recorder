/**
 * background.js — Service Worker (MV3)
 *
 * 职责：
 *   1. 维护全局录制状态机 (idle | countdown | recording | paused)
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

const state = {
  status: 'idle',          // idle | countdown | recording | paused
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

// 顶层立即发起恢复；route() 会 await 它
const stateReady = restoreState();

function downloadBasename(path) {
  return (path || '').replace(/\\/g, '/').split('/').pop() || '';
}

async function refreshDownloadStatus(downloadId) {
  if (!downloadId || downloadId !== state.downloadId) return { error: '下载任务不存在或已过期' };
  const [item] = await chrome.downloads.search({ id: downloadId });
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
    processing: false,
    savePhase: 'error',
    processingStage: '',
    saveError: message,
    saveCanRetry: false,
  });
  badge('error');
}

async function openSaveWindow() {
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
}

async function reconcileEngineContext() {
  if (!state.processing || state.savePhase === 'complete' || state.mode !== 'tab') return;
  if (!chrome.runtime.getContexts) return;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!contexts.length) markSaveContextLost('录制上下文已关闭，无法继续保存');
}

chrome.windows.onRemoved.addListener(async windowId => {
  await stateReady;   // SW 刚被唤醒时 state 可能尚未恢复
  if (windowId && windowId === state.saveWindowId && state.saveWindowId !== 0) {
    setState({ saveWindowId: 0 });
    return;
  }
  if (windowId && windowId === state.recorderWindowId && state.recorderWindowId !== 0) {
    setState({ recorderWindowId: 0, recorderTabId: 0 });
    if (state.processing && state.savePhase !== 'complete') {
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

async function route(msg) {
  await stateReady;   // 确保 SW 回收后已恢复 state
  switch (msg.type) {

    /* ── 开始录制（来自 popup）────────────────────────── */
    case 'START_RECORDING': {
      // 重入守卫：录制中/倒计时中/保存中不允许再起一段，否则旧引擎失去引用
      // 仍在录制（幽灵录制），且旧链的 RECORDING_STOPPED 会把新状态掐掉
      if (state.status !== 'idle' || state.processing) {
        return { error: '已有录制进行中或仍在保存，请先停止' };
      }
      resetSaveResult();
      if (msg.source === 'tab' && !msg.compatMode) return await startTabRecording(msg);
      if (msg.source === 'tab' && msg.compatMode)  return await startCompatTabRecording(msg);
      return await startDesktopRecording(msg);
    }

    /* ── 停止录制 ─────────────────────────────────────── */
    case 'STOP_RECORDING': {
      // 发停止指令让引擎跑完 onStopped（保存文件）；
      // desktop 模式引擎保存完会自己关窗口，无需在这里直接 remove
      await sendToRecorderEngine('OFF_STOP');
      setState({ status: 'idle' }); badge('idle');
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
    case 'GET_STATE':
      await reconcileEngineContext();
      return { ...state };

    case 'OPEN_SAVE_WINDOW': {
      if (state.mode !== 'tab') return { error: '当前录制使用桌面保存窗口' };
      return { ok: 1, windowId: await openSaveWindow() };
    }

    case 'RETRY_SAVE': {
      if (state.savePhase !== 'error' || !state.saveCanRetry) {
        return { error: '当前没有可重试的保存任务' };
      }
      setState({
        processing: true, savePhase: 'processing', processingStage: 'download',
        downloadId: 0, saveError: '', saveReceived: 0, saveTotal: 0,
      });
      badge('saving');
      const result = await sendToRecorderEngine('OFF_RETRY_SAVE');
      return { ok: result === false ? 0 : 1 };
    }

    case 'SAVE_FILE': {
      if (!state.processing) return { error: '当前没有待保存的录制' };
      if (state.savePhase === 'complete' || (state.savePhase === 'downloading' && state.downloadId)) {
        return { error: '当前录制已有下载任务' };
      }
      if (typeof msg.url !== 'string' || !msg.url.startsWith('blob:') || !msg.filename) {
        return { error: '保存参数无效' };
      }
      const downloadId = await chrome.downloads.download({
        url: msg.url,
        filename: msg.filename,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      setState({
        savePhase: 'downloading', processingStage: 'download', downloadId,
        saveError: '', saveFilename: msg.filename, saveCanRetry: true,
        saveReceived: 0, saveTotal: 0,
      });
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
    case 'RECORDING_STOPPED':
    case 'RECORDER_STOPPED': {
      setState({ status: 'idle', fileSize: 0, recorderWindowId: 0, recorderTabId: 0, processing: false });
      if (msg.discarded) {
        resetSaveResult();
      } else if (msg.historyEntry) {
        setState({ savePhase: 'complete', saveCanRetry: false });
        saveHistory(msg.historyEntry);
      }
      badge('idle');
      return { ok: 1 };
    }

    case 'ENGINE_SAVE_ERROR': {
      const canRetry = msg.canRetry !== false;
      setState({
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
      if (msg.active) {
        setState({
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
    status: 'recording',
    startTime: Date.now(),
    pausedTime: 0,
    fileSize: 0,
    timeLimit: timeLimit || 0,
  });
  badge('recording');

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
    paused:    { text: '❚❚', color: '#ffa502' },
    saving:    { text: 'SAVE', color: '#ffa502' },
    error:     { text: '!',   color: '#ff4757' },
    idle:      { text: '',    color: '#000' },
  };
  const b = m[mode] || m.idle;
  chrome.action.setBadgeText({ text: b.text });
  chrome.action.setBadgeBackgroundColor({ color: b.color });
}

function saveHistory(entry) {
  chrome.storage.local.get('recordingHistory', d => {
    const h = d.recordingHistory || [];
    h.unshift(entry);
    if (h.length > 30) h.length = 30;
    chrome.storage.local.set({ recordingHistory: h });
  });
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
        tlH: '0', tlM: '0', tlS: '0',
      },
      recordingHistory: [],
    });
  }
});
