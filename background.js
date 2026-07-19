/**
 * background.js — Service Worker (MV3)
 *
 * 职责：
 *   1. 维护全局录制状态机 (idle | countdown | recording | paused)
 *   2. 消息路由：把 popup 的指令分发给 offscreen / recorder 窗口
 *   3. 通过 chrome.tabCapture.getMediaStreamId 取得 streamId 并跨上下文传递
 *   4. 管理录制窗口生命周期与历史记录
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
  countdownRemaining: 0,
};

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
   消息路由
   ═══════════════════════════════════════════════════════ */

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  route(msg, sender).then(reply).catch(e => reply({ error: e.message }));
  return true; // 异步回复
});

async function route(msg) {
  switch (msg.type) {

    /* ── 开始录制（来自 popup）────────────────────────── */
    case 'START_RECORDING': {
      if (msg.source === 'tab' && !msg.compatMode) return await startTabRecording(msg);
      if (msg.source === 'tab' && msg.compatMode)  return await startCompatTabRecording(msg);
      return await startDesktopRecording(msg);
    }

    /* ── 停止录制 ─────────────────────────────────────── */
    case 'STOP_RECORDING': {
      if (state.mode === 'tab') {
        try { await chrome.runtime.sendMessage({ type: 'OFF_STOP', target: 'offscreen' }); } catch (_) {}
      } else if (state.mode === 'desktop' && state.recorderWindowId) {
        try { chrome.windows.remove(state.recorderWindowId); } catch (_) {}
      }
      state.status = 'idle'; badge('idle');
      return { ok: 1 };
    }

    /* ── 暂停 / 恢复 ──────────────────────────────────── */
    case 'PAUSE_RECORDING': {
      if (state.mode === 'tab') {
        await chrome.runtime.sendMessage({ type: 'OFF_PAUSE', target: 'offscreen' });
      }
      state.status = 'paused'; state.pauseStart = Date.now();
      badge('paused');
      return { ok: 1 };
    }
    case 'RESUME_RECORDING': {
      if (state.mode === 'tab') {
        await chrome.runtime.sendMessage({ type: 'OFF_RESUME', target: 'offscreen' });
      }
      state.pausedTime += Date.now() - state.pauseStart;
      state.status = 'recording'; badge('recording');
      return { ok: 1 };
    }

    /* ── 丢弃 ─────────────────────────────────────────── */
    case 'DISCARD_RECORDING': {
      if (state.mode === 'tab') {
        try { await chrome.runtime.sendMessage({ type: 'OFF_DISCARD', target: 'offscreen' }); } catch (_) {}
      } else if (state.recorderWindowId) {
        try { chrome.windows.remove(state.recorderWindowId); } catch (_) {}
      }
      state.status = 'idle'; state.fileSize = 0; badge('idle');
      return { ok: 1 };
    }

    /* ── 状态查询（popup 轮询）────────────────────────── */
    case 'GET_STATE':
      return { ...state };

    /* ── 来自 offscreen / recorder 的事件 ─────────────── */
    case 'RECORDING_STOPPED':
    case 'RECORDER_STOPPED': {
      state.status = 'idle'; state.fileSize = 0;
      state.recorderWindowId = 0;
      badge('idle');
      if (msg.historyEntry) saveHistory(msg.historyEntry);
      return { ok: 1 };
    }
    case 'RECORDER_STARTED': {
      state.status = 'recording';
      state.startTime = Date.now();
      state.pausedTime = 0;
      badge('recording');
      return { ok: 1 };
    }
    case 'FILE_SIZE_UPDATE':
      state.fileSize = msg.size || 0;
      return { ok: 1 };
    case 'COUNTDOWN_TICK':
      state.countdownRemaining = msg.remaining || 0;
      return { ok: 1 };

    default:
      return null;
  }
}

/* ═══════════════════════════════════════════════════════
   标签页录制 → offscreen document
   ═══════════════════════════════════════════════════════ */

async function startTabRecording(msg) {
  await ensureOffscreen();

  const tab = await activeTab();
  if (!tab) throw new Error('未找到活动标签页');

  // MV3 取 streamId，offscreen 用 chromeMediaSourceId 消费它
  const streamId = await getStreamId(tab.id);

  state.status = 'countdown';
  state.mode = 'tab';

  const result = await chrome.runtime.sendMessage({
    type: 'OFF_START',
    target: 'offscreen',
    streamId,
    playTabAudio: msg.playTabAudio,
    width: msg.width,
    height: msg.height,
    fps: msg.fps,
    quality: msg.quality,
    timeLimit: msg.timeLimit || 0,
    countdownSec: msg.countdownSec || 0,
    outputFormat: msg.outputFormat || 'webm',
  });

  if (result?.error) throw new Error(result.error);

  Object.assign(state, {
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
  const streamId = await getStreamId(tab.id);

  const params = new URLSearchParams({
    source: 'tab-compat',
    playTabAudio: msg.playTabAudio ? '1' : '0',
    width: String(msg.width || 1920),
    height: String(msg.height || 1080),
    fps: String(msg.fps || 30),
    quality: String(msg.quality || 8000000),
    timeLimit: String(msg.timeLimit || 0),
    tabStreamId: streamId,
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

  state.mode = 'desktop';
  state.recorderWindowId = win.id;
  state.status = 'recording';
  state.startTime = Date.now();
  state.pausedTime = 0;
  state.fileSize = 0;
  state.timeLimit = timeLimit || 0;
  badge('recording');

  // 用户关闭录制窗口 → 归位状态
  chrome.windows.onRemoved.addListener(function listener(windowId) {
    if (windowId === win.id) {
      chrome.windows.onRemoved.removeListener(listener);
      if (state.status !== 'idle') {
        state.status = 'idle';
        state.recorderWindowId = 0;
        badge('idle');
      }
    }
  });

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
