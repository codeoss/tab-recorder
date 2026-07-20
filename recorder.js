/**
 * recorder.js — 窗口 / 屏幕 / 兼容模式 录制（接入 core-recorder 引擎）
 *
 * 这个页面以独立 popup 窗口形式打开。为什么不能用 offscreen？
 *   - getDisplayMedia 必须由「可见页面内的用户手势」触发。
 *   - 所以窗口/屏幕采集必须在此可见窗口里发起。
 *
 * 该窗口可最小化：getDisplayMedia / getUserMedia 的流与窗口可见性无关，
 * 最小化后录制继续进行。
 *
 * 录制引擎逻辑（MediaRecorder/onStopped/计时/转码/下载等）由 core-recorder.js
 * 接管。本文件保留的差异部分：
 *   1. UI 绑定（按钮、计时显示、进度条、状态点、错误提示）
 *   2. 三种 getStream 实现（desktop / window / tab-compat 双流）
 *   3. beforeunload 关窗保护（录制中/处理中弹原生确认框）
 *   4. 接收 background 的 OFF_* 消息，转调 engine
 *
 * 配置通过 URL hash 传入。
 */

let engine = null;
let screenAudioStream = null;   // 兼容模式 getDisplayMedia 的系统音频流
let limitMs = 0;

// DOM
const startScreen = document.getElementById('startScreen');
const startBtn    = document.getElementById('startBtn');
const errMsg      = document.getElementById('errMsg');
const recPanel    = document.getElementById('recPanel');
const timerEl     = document.getElementById('timer');
const limitTxt    = document.getElementById('limitTxt');
const pWrap       = document.getElementById('pWrap');
const pBar        = document.getElementById('pBar');
const dot         = document.getElementById('dot');
const stxt        = document.getElementById('stxt');
const sizeInfo    = document.getElementById('sizeInfo');
const pauseBtn    = document.getElementById('pauseBtn');
const stopBtn     = document.getElementById('stopBtn');

/* ── 解析 URL hash 配置 ─────────────────────────────── */

function getConfig() {
  const p = new URLSearchParams(window.location.hash.slice(1));
  return {
    source:      p.get('source') || 'screen',
    playTabAudio:p.get('playTabAudio') === '1',
    width:       parseInt(p.get('width'))  || 1920,
    height:      parseInt(p.get('height')) || 1080,
    fps:         parseInt(p.get('fps'))    || 30,
    quality:     parseInt(p.get('quality'))|| 8000000,
    timeLimit:   parseInt(p.get('timeLimit')) || 0,
    tabStreamId: p.get('tabStreamId') || '',
    outputFormat:p.get('outputFormat') || 'webm',
  };
}

const config = getConfig();
limitMs = config.timeLimit * 1000;
const isCompatMode = config.source === 'tab-compat' && config.tabStreamId;

if (isCompatMode) {
  document.getElementById('title').textContent = '☁️ 云桌面兼容录制';
  document.getElementById('subtitle').innerHTML =
    '点击按钮后，请在选择器中选择<b>「整个屏幕」</b><br>并勾选<b>「分享系统音频」</b>，仅采集音频，画面仍录制标签页';
  document.getElementById('startBtn').textContent = '选择屏幕以采集系统音频';
}

/* ── 事件 ────────────────────────────────────────────── */

startBtn.addEventListener('click', startRecording);
pauseBtn.addEventListener('click', () => engine && engine.pause());
stopBtn.addEventListener('click',  () => engine && engine.stop());

/* ── 接收来自 background 的指令（popup 操作转发过来）─────────
   desktop 模式下 popup 操作原本到不了这个窗口，这条通道补齐了
   「UI 显示暂停 ⇄ 真实 MediaRecorder 仍录制」的脱节。
   按钮和 background 消息统一走 engine 同一组方法。
   ────────────────────────────────────────────────────────── */
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!engine) return false;
  const h = {
    OFF_STOP:    () => { engine.stop();    return { ok: 1 }; },
    OFF_PAUSE:   () => { engine.pause();   return { ok: 1 }; },
    OFF_RESUME:  () => { engine.resume();  return { ok: 1 }; },
    OFF_DISCARD: () => { engine.discard(); return { ok: 1 }; },
  };
  const fn = h[msg.type];
  if (!fn) return false;
  reply(fn());
  return false;
});

// 关闭窗口：录制中/处理中时提示会丢视频（onStopped 是异步链，关窗即中断）
window.addEventListener('beforeunload', e => {
  if (engine && engine.isBusy()) {
    e.preventDefault();
    e.returnValue = '录制尚未停止并保存，关闭窗口将丢失视频。';
    return e.returnValue;
  }
});

/* ── 开始录制 ────────────────────────────────────────── */

async function startRecording() {
  errMsg.classList.add('hidden');

  engine = createRecorderEngine({
    getStream: () => getCaptureStream(),
    onEvent:   (name, data) => onEvent(name, data),
    releaseExtra: () => releaseExtraStreams(),
  });

  const ok = await engine.start({
    quality: config.quality,
    timeLimit: config.timeLimit,
    outputFormat: config.outputFormat,
  });

  if (ok) {
    startScreen.style.display = 'none';
    recPanel.classList.add('on');
    if (limitMs > 0) {
      limitTxt.textContent = '/ ' + fmtMs(limitMs);
      limitTxt.classList.remove('hidden');
      pWrap.classList.remove('hidden');
    }
  }
}

/* ── 取流：三种模式分支 ─────────────────────────────── */

async function getCaptureStream() {
  if (isCompatMode) return await startCompatCapture();
  return await startDesktopCapture();
}

/** 兼容模式：音频走系统（getDisplayMedia）、视频走 tabCapture(仅视频) */
async function startCompatCapture() {
  // 1. getDisplayMedia 拿系统音频（用户需选「整个屏幕」+ 勾「分享系统音频」）
  let sysStream;
  try {
    sysStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (e) {
    showError(e.name === 'NotAllowedError'
      ? '用户取消了选择。请选择「整个屏幕」并勾选「分享系统音频」'
      : '获取系统音频失败: ' + e.message);
    notifyBg('RECORDER_STOPPED', { historyEntry: null });
    return null;
  }

  const sysAudioTracks = sysStream.getAudioTracks();
  sysStream.getVideoTracks().forEach(t => t.stop());   // 视频丢弃
  screenAudioStream = sysStream;   // 保留音频流引用，releaseExtra 里释放

  if (sysAudioTracks.length === 0) {
    showError('未获取到系统音频。请确保勾选了「分享系统音频」');
    notifyBg('RECORDER_STOPPED', { historyEntry: null });
    return null;
  }

  // 2. tabCapture 仅取视频（不劫持音频 → 标签页仍可发声）
  let tabVideoStream;
  try {
    tabVideoStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: {
        chromeMediaSource: 'tab', chromeMediaSourceId: config.tabStreamId,
        maxWidth: config.width, maxHeight: config.height, maxFrameRate: config.fps,
      } },
    });
  } catch (e) {
    showError('获取标签页画面失败: ' + e.message);
    sysAudioTracks.forEach(t => t.stop());
    screenAudioStream = null;
    notifyBg('RECORDER_STOPPED', { historyEntry: null });
    return null;
  }

  // 合成：tab 视频轨 + 系统音频轨
  return new MediaStream([...tabVideoStream.getVideoTracks(), ...sysAudioTracks]);
}

/** 窗口 / 屏幕采集（getDisplayMedia） */
async function startDesktopCapture() {
  const constraints = {
    video: {
      width: { ideal: config.width },
      height: { ideal: config.height },
      frameRate: { ideal: config.fps },
      displaySurface: config.source === 'window' ? 'window' : 'monitor',
    },
    audio: true,   // 系统/共享音频
  };
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
    if (!stream || stream.getVideoTracks().length === 0) throw new Error('未获取到视频流');
    return stream;
  } catch (e) {
    showError(e.name === 'NotAllowedError' ? '用户取消了选择' : '获取媒体流失败: ' + e.message);
    notifyBg('RECORDER_STOPPED', { historyEntry: null });
    return null;
  }
}

/* ── onEvent → 更新 UI / 通知 background ────────────── */

function onEvent(name, data) {
  switch (name) {
    case 'started':
      setStatus('rec', '录制中');
      pauseBtn.textContent = '⏸ 暂停';
      dot.classList.remove('paused');
      notifyBg('RECORDER_STARTED', {});
      break;

    case 'paused':
      setStatus('pau', '已暂停');
      pauseBtn.textContent = '▶ 继续';
      dot.classList.add('paused');
      break;

    case 'resumed':
      setStatus('rec', '录制中');
      pauseBtn.textContent = '⏸ 暂停';
      dot.classList.remove('paused');
      break;

    case 'tick':
      timerEl.textContent = fmtMs(data.elapsedMs);
      if (limitMs > 0) pBar.style.width = Math.min(100, (data.elapsedMs / limitMs) * 100) + '%';
      break;

    case 'size':
      sizeInfo.textContent = (data.bytes / 1048576).toFixed(1) + ' MB';
      notifyBg('FILE_SIZE_UPDATE', { size: data.bytes });
      break;

    case 'processing':
      // 额外 C：转码期间提示用户不要关窗
      if (data.active) {
        stxt.textContent = '处理中...（转码中请勿关闭窗口）';
        dot.style.animation = 'none';
      }
      break;

    case 'stopped':
      notifyBg('RECORDER_STOPPED', { historyEntry: data && data.historyEntry });
      if (data && data.historyEntry) {
        // 正常停止：等 saved 事件再关窗
      } else {
        // discard 或空录制：直接关窗
        setTimeout(() => window.close(), 100);
      }
      break;

    case 'saved':
      stxt.textContent = '已保存: ' + data.filename;
      setTimeout(() => window.close(), 2000);
      break;
  }
}

/* ── 辅助 ────────────────────────────────────────────── */

function setStatus(state, txt) { dot.className = state === 'pau' ? 'dot paused' : 'dot'; stxt.textContent = txt; }

function fmtMs(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map(v => String(v).padStart(2, '0')).join(':');
}

function showError(msg) { errMsg.textContent = '❌ ' + msg; errMsg.classList.remove('hidden'); }
function notifyBg(type, extra) { try { chrome.runtime.sendMessage({ type, ...extra }).catch(() => {}); } catch (_) {} }

/** 释放兼容模式额外持有的 getDisplayMedia 音频流（主流由 core 释放） */
function releaseExtraStreams() {
  if (screenAudioStream) {
    try { screenAudioStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    screenAudioStream = null;
  }
}
