/**
 * recorder.js — 窗口 / 屏幕 / 兼容模式 录制
 *
 * 这个页面以独立 popup 窗口形式打开。为什么不能用 offscreen？
 *   - getDisplayMedia 必须由「可见页面内的用户手势」触发。
 *   - 所以窗口/屏幕采集必须在此可见窗口里发起。
 *
 * 该窗口可最小化：getDisplayMedia / getUserMedia 的流与窗口可见性无关，
 * 最小化后录制继续进行。
 *
 * 配置通过 URL hash 传入。
 */

let recorder = null;
let chunks   = [];
let stream   = null;
let audioCtx = null;
let mime     = '';
let startTs  = 0;
let pausedMs = 0;
let pauseTs  = 0;
let stopTimer = null;
let limitMs  = 0;
let flushTimer = null;
let tickInterval = null;
let isPaused = false;
let screenAudioStream = null;   // 兼容模式 getDisplayMedia 的系统音频流
let outputFormat = 'webm';

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
outputFormat = config.outputFormat;
const isCompatMode = config.source === 'tab-compat' && config.tabStreamId;

if (isCompatMode) {
  document.getElementById('title').textContent = '☁️ 云桌面兼容录制';
  document.getElementById('subtitle').innerHTML =
    '点击按钮后，请在选择器中选择<b>「整个屏幕」</b><br>并勾选<b>「分享系统音频」</b>，仅采集音频，画面仍录制标签页';
  document.getElementById('startBtn').textContent = '选择屏幕以采集系统音频';
}

/* ── 事件 ────────────────────────────────────────────── */

startBtn.addEventListener('click', startRecording);
pauseBtn.addEventListener('click', togglePause);
stopBtn.addEventListener('click', stopRecording);

// 关闭窗口 → 干净收尾
window.addEventListener('beforeunload', () => {
  if (recorder?.state !== 'inactive') doStop();
});

/* ── 开始录制 ────────────────────────────────────────── */

async function startRecording() {
  errMsg.classList.add('hidden');
  let recStream;

  if (isCompatMode) {
    // ═══ 兼容模式：音频走系统、视频走 tabCapture(仅视频) ═══
    recStream = await startCompatCapture();
    if (!recStream) return;
  } else {
    // ═══ 窗口 / 屏幕 ═══
    recStream = await startDesktopCapture();
    if (!recStream) return;
  }

  mime = pickWebM();
  chunks = [];
  recorder = new MediaRecorder(recStream, {
    mimeType: mime,
    videoBitsPerSecond: config.quality,
  });

  recorder.ondataavailable = e => { if (e.data?.size > 0) { chunks.push(e.data); updateSize(); } };
  recorder.onstop = () => onStopped();

  // Chrome 原生「停止共享」条 → 干净收尾
  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    if (recorder?.state !== 'inactive') stopRecording();
  });

  recorder.start(1000);
  startTs = Date.now();
  pausedMs = 0;
  isPaused = false;

  startScreen.style.display = 'none';
  recPanel.classList.add('on');
  startTick();

  if (limitMs > 0) {
    limitTxt.textContent = '/ ' + fmtMs(limitMs);
    limitTxt.classList.remove('hidden');
    pWrap.classList.remove('hidden');
    stopTimer = setTimeout(() => stopRecording(), limitMs);
  }
  flushTimer = setInterval(compact, 60000);

  notifyBg('RECORDER_STARTED', {});
}

/* ── 兼容模式采集 ───────────────────────────────────── */

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
  screenAudioStream = sysStream;

  if (sysAudioTracks.length === 0) {
    showError('未获取到系统音频。请确保勾选了「分享系统音频」');
    notifyBg('RECORDER_STOPPED', { historyEntry: null });
    return null;
  }

  // 2. tabCapture 仅取视频（不劫持音频 → 标签页仍可发声）
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: {
        chromeMediaSource: 'tab', chromeMediaSourceId: config.tabStreamId,
        maxWidth: config.width, maxHeight: config.height, maxFrameRate: config.fps,
      } },
    });
  } catch (e) {
    showError('获取标签页画面失败: ' + e.message);
    sysAudioTracks.forEach(t => t.stop());
    notifyBg('RECORDER_STOPPED', { historyEntry: null });
    return null;
  }

  return new MediaStream([...stream.getVideoTracks(), ...sysAudioTracks]);
}

/* ── 窗口/屏幕采集 ──────────────────────────────────── */

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
    stream = await navigator.mediaDevices.getDisplayMedia(constraints);
    if (!stream || stream.getVideoTracks().length === 0) throw new Error('未获取到视频流');
    return stream;
  } catch (e) {
    showError(e.name === 'NotAllowedError' ? '用户取消了选择' : '获取媒体流失败: ' + e.message);
    notifyBg('RECORDER_STOPPED', { historyEntry: null });
    return null;
  }
}

/* ── 停止 ────────────────────────────────────────────── */

function stopRecording() {
  if (stopTimer)  { clearTimeout(stopTimer);  stopTimer = null; }
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (recorder?.state !== 'inactive') recorder.stop();
  else releaseAll();
}
function doStop() { stopRecording(); }

/* ── 暂停 / 恢复 ─────────────────────────────────────── */

function togglePause() {
  if (!recorder) return;
  if (!isPaused && recorder.state === 'recording') {
    recorder.pause(); isPaused = true; pauseTs = Date.now(); stopTick();
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    pauseBtn.textContent = '▶ 继续';
    dot.classList.add('paused'); stxt.textContent = '已暂停';
  } else if (isPaused && recorder.state === 'paused') {
    pausedMs += Date.now() - pauseTs; recorder.resume(); isPaused = false; startTick();
    if (limitMs > 0) {
      const rem = limitMs - elapsed();
      if (rem > 0) stopTimer = setTimeout(() => stopRecording(), rem);
      else stopRecording();
    }
    pauseBtn.textContent = '⏸ 暂停';
    dot.classList.remove('paused'); stxt.textContent = '录制中';
  }
}

/* ── 录制结束 ────────────────────────────────────────── */

async function onStopped() {
  releaseAll(); stopTick();
  if (!chunks.length) { notifyBg('RECORDER_STOPPED', { historyEntry: null }); window.close(); return; }

  stxt.textContent = '处理中...';
  dot.style.animation = 'none';

  const durMs = elapsed();
  let blob = new Blob(chunks, { type: mime });
  chunks = [];

  try { blob = await fixWebMBlob(blob, durMs); } catch (e) { console.warn(e); }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let filename = `TabRecord_${ts}.webm`;
  let finalBlob = blob;

  if (outputFormat === 'mp4') {
    try { finalBlob = await webmToMp4(blob); filename = `TabRecord_${ts}.mp4`; }
    catch (e) { console.warn('MP4 转码失败，回退 WebM：', e); }
  }

  dl(finalBlob, filename);
  notifyBg('RECORDER_STOPPED', { historyEntry: {
    filename, size: finalBlob.size,
    duration: fmtMs(durMs), date: new Date().toLocaleString('zh-CN'),
    format: finalBlob.type.includes('mp4') ? 'mp4' : 'webm',
  } });

  stxt.textContent = '已保存: ' + filename;
  setTimeout(() => window.close(), 2000);
}

/* ── 计时 ────────────────────────────────────────────── */

function startTick() {
  stopTick();
  tickInterval = setInterval(() => {
    const ms = elapsed();
    timerEl.textContent = fmtMs(ms);
    if (limitMs > 0) pBar.style.width = Math.min(100, (ms / limitMs) * 100) + '%';
  }, 250);
}
function stopTick() { if (tickInterval) { clearInterval(tickInterval); tickInterval = null; } }

/* ── 辅助 ────────────────────────────────────────────── */

function elapsed() { return Date.now() - startTs - pausedMs; }

function pickWebM() {
  for (const t of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'])
    if (MediaRecorder.isTypeSupported(t)) return t;
  return 'video/webm';
}

function updateSize() {
  const s = chunks.reduce((a, c) => a + c.size, 0);
  sizeInfo.textContent = (s / 1048576).toFixed(1) + ' MB';
  notifyBg('FILE_SIZE_UPDATE', { size: s });
}

function compact() { if (chunks.length > 120) chunks = [new Blob(chunks, { type: mime })]; }

function dl(blob, name) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = u; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(u), 30000);
}

function fmtMs(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map(v => String(v).padStart(2, '0')).join(':');
}

function showError(msg) { errMsg.textContent = '❌ ' + msg; errMsg.classList.remove('hidden'); }
function notifyBg(type, extra) { chrome.runtime.sendMessage({ type, ...extra }).catch(() => {}); }

function releaseAll() {
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  screenAudioStream?.getTracks().forEach(t => t.stop()); screenAudioStream = null;
  audioCtx?.close().catch(() => {}); audioCtx = null;
}
