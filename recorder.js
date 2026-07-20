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
let isProcessing = false;       // onStopped 异步链进行中（fixWebM/转码/dl），关窗会丢视频
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

/* ── 接收来自 background 的指令（popup 操作转发过来）─────────
   把按钮事件和 background 消息统一到同一组函数，避免状态分裂。
   desktop 模式下，popup 的暂停/停止/丢弃原本无法触达这个窗口，
   这条通道补齐了「UI 显示暂停 ⇄ 真实 MediaRecorder 仍录制」的脱节。
   ────────────────────────────────────────────────────────── */
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const handlers = {
    OFF_STOP:    () => { stopRecording(); return { ok: 1 }; },
    OFF_PAUSE:   () => { doPause();       return { ok: 1 }; },
    OFF_RESUME:  () => { doResume();      return { ok: 1 }; },
    OFF_DISCARD: () => { doDiscard();     return { ok: 1 }; },
  };
  const fn = handlers[msg.type];
  if (!fn) return false;
  reply(fn());
  return false;
});

// 关闭窗口：录制中/处理中时提示会丢视频（onStopped 是异步链，关窗即中断）
// 现代浏览器忽略自定义文案，但仍需返回非空字符串才会弹原生确认框。
window.addEventListener('beforeunload', e => {
  const recording = recorder && recorder.state !== 'inactive';
  if (recording || isProcessing) {
    e.preventDefault();
    e.returnValue = '录制尚未停止并保存，关闭窗口将丢失视频。';
    return e.returnValue;
  }
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
  // 监听录制流的所有轨道：
  //   - 普通桌面模式：视频轨 ended 即可
  //   - 兼容模式：视频来自 tabCapture、音频来自 getDisplayMedia，
  //     用户点「停止共享」只会让 getDisplayMedia 的音频轨 ended，
  //     必须监听音频轨才能捕获，否则录制继续但从此刻起没声音
  recStream.getTracks().forEach(t => {
    t.addEventListener('ended', () => {
      if (recorder?.state !== 'inactive') stopRecording();
    });
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

/* ── 暂停 / 恢复 / 丢弃 ───────────────────────────────────
   doPause/doResume/doDiscard 是「明确语义」版本，既被按钮（togglePause）
   也被 background 消息调用，保证 popup 操作和窗口内操作走同一逻辑。
   ────────────────────────────────────────────────────────── */

function doPause() {
  if (!recorder || isPaused || recorder.state !== 'recording') return;
  recorder.pause(); isPaused = true; pauseTs = Date.now(); stopTick();
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
  if (pauseBtn) pauseBtn.textContent = '▶ 继续';
  if (dot) dot.classList.add('paused');
  if (stxt) stxt.textContent = '已暂停';
}

function doResume() {
  if (!recorder || !isPaused || recorder.state !== 'paused') return;
  pausedMs += Date.now() - pauseTs; recorder.resume(); isPaused = false; startTick();
  if (limitMs > 0) {
    const rem = limitMs - elapsed();
    if (rem > 0) stopTimer = setTimeout(() => stopRecording(), rem);
    else return stopRecording();
  }
  if (pauseBtn) pauseBtn.textContent = '⏸ 暂停';
  if (dot) dot.classList.remove('paused');
  if (stxt) stxt.textContent = '录制中';
}

function doDiscard() {
  chunks = [];
  if (stopTimer)  { clearTimeout(stopTimer);  stopTimer = null; }
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (recorder && recorder.state !== 'inactive') {
    recorder.ondataavailable = null;
    recorder.onstop = null;
    try { recorder.stop(); } catch (_) {}
  }
  releaseAll();
  notifyBg('RECORDER_STOPPED', { historyEntry: null });
  setTimeout(() => window.close(), 100);   // 等 message 发出再关窗
}

function togglePause() {
  if (!recorder) return;
  if (!isPaused) doPause();
  else doResume();
}

/* ── 录制结束 ────────────────────────────────────────── */

async function onStopped() {
  releaseAll(); stopTick();
  isProcessing = true;   // 进入异步保存链：期间关窗会丢视频，beforeunload 要拦
  if (!chunks.length) {
    isProcessing = false;
    notifyBg('RECORDER_STOPPED', { historyEntry: null });
    window.close();
    return;
  }

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

  isProcessing = false;   // 保存完成，允许关窗
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
