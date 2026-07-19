/**
 * offscreen.js — 标签页录制引擎
 *
 * 仅负责「标签页」录制（窗口/屏幕走 recorder.html）。
 * 关键点：
 *   1. 持久化：跑在 offscreen document 内，popup 关闭、Chrome 最小化均不中断。
 *   2. 音视频同流：getUserMedia({chromeMediaSource:'tab'}) 一次拿到视频+标签页音频。
 *   3. 防静音回环：tabCapture 会把标签页音频「劫持」走，导致用户听不到；
 *      这里用 AudioContext 把音频接到 destination，录制时用户仍能听到声音。
 *   4. 分辨率/帧率：通过 getUserMedia 的 maxWidth/maxHeight/maxFrameRate 约束控制。
 *   5. 输出：WebM（VP9/Opus）→ EBML 修复（补 Cues/Duration）→ 下载；
 *      可选 MP4 转码（transcoder.js）。
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
let outputFormat = 'webm';

/* ── 消息处理 ────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.target !== 'offscreen') return false;
  const h = {
    OFF_START:   () => doStart(msg),
    OFF_STOP:    () => { doStop();     return { ok: 1 }; },
    OFF_PAUSE:   () => { doPause();    return { ok: 1 }; },
    OFF_RESUME:  () => { doResume();   return { ok: 1 }; },
    OFF_DISCARD: () => { doDiscard();  return { ok: 1 }; },
  };
  const fn = h[msg.type];
  if (!fn) return false;
  const r = fn();
  if (r instanceof Promise) { r.then(reply).catch(e => reply({ error: e.message })); return true; }
  reply(r); return false;
});

/* ── 开始录制 ────────────────────────────────────────── */

async function doStart(opts) {
  const { streamId, playTabAudio, width, height, fps, quality, timeLimit } = opts;
  limitMs = (timeLimit || 0) * 1000;
  outputFormat = opts.outputFormat || 'webm';

  if (opts.countdownSec > 0) await countdown(opts.countdownSec);

  // 一次 getUserMedia 同时拿到标签页视频和音频
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: { mandatory: {
      chromeMediaSource: 'tab', chromeMediaSourceId: streamId,
      maxWidth:  width  || 1920,
      maxHeight: height || 1080,
      maxFrameRate: fps  || 30,
    } },
  });

  // 防静音：把劫持走的标签页音频回环到扬声器
  if (playTabAudio && stream.getAudioTracks().length > 0) {
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    src.connect(audioCtx.destination);
  }

  startRecorder(stream, quality);
  return { ok: 1 };
}

/* ── MediaRecorder 配置 ─────────────────────────────── */

function startRecorder(recStream, quality) {
  mime = pickWebM();
  chunks = [];
  recorder = new MediaRecorder(recStream, {
    mimeType: mime,
    videoBitsPerSecond: parseInt(quality) || 8000000,
  });

  recorder.ondataavailable = e => {
    if (e.data?.size > 0) { chunks.push(e.data); reportSize(); }
  };
  recorder.onstop = () => onStopped();

  // 用户在 Chrome「停止共享」条上点停止 → 干净收尾
  const vt = recStream.getVideoTracks()[0];
  if (vt) vt.addEventListener('ended', () => {
    if (recorder?.state !== 'inactive') doStop();
  });

  recorder.start(1000);          // 每秒一个分片
  startTs = Date.now();
  pausedMs = 0;

  if (limitMs > 0) stopTimer = setTimeout(() => doStop(), limitMs);
  flushTimer = setInterval(compact, 60000);  // 每 60s 合并分片，控制内存
}

/* ── 停止 / 暂停 / 恢复 / 丢弃 ─────────────────────── */

function doStop() {
  clearTimers();
  if (recorder?.state !== 'inactive') recorder.stop();
  else releaseAll();
}

function doPause() {
  if (recorder?.state === 'recording') {
    recorder.pause(); pauseTs = Date.now();
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
  }
}

function doResume() {
  if (recorder?.state === 'paused') {
    pausedMs += Date.now() - pauseTs;
    recorder.resume();
    if (limitMs > 0) {
      const rem = limitMs - elapsed();
      if (rem > 0) stopTimer = setTimeout(() => doStop(), rem);
      else doStop();
    }
  }
}

function doDiscard() {
  chunks = [];
  clearTimers();
  if (recorder?.state !== 'inactive') {
    recorder.ondataavailable = null; recorder.onstop = null; recorder.stop();
  }
  releaseAll();
  notify('RECORDING_STOPPED', { historyEntry: null });
}

/* ── 录制结束：修复 WebM → 下载（可选 MP4 转码）────── */

async function onStopped() {
  releaseAll();
  if (!chunks.length) { notify('RECORDING_STOPPED', { historyEntry: null }); return; }

  const durMs = elapsed();
  let blob = new Blob(chunks, { type: mime });
  chunks = [];

  // WebM：补 Cues 索引 + Duration，使其可拖动进度条
  try { blob = await fixWebMBlob(blob, durMs); } catch (e) { console.warn(e); }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let filename = `TabRecord_${ts}.webm`;
  let finalBlob = blob;

  // 可选 MP4 转码
  if (outputFormat === 'mp4') {
    try {
      finalBlob = await webmToMp4(blob);
      filename = `TabRecord_${ts}.mp4`;
    } catch (e) {
      console.warn('MP4 转码失败，回退 WebM：', e);
    }
  }

  dl(finalBlob, filename);

  notify('RECORDING_STOPPED', { historyEntry: {
    filename, size: finalBlob.size,
    duration: fmtDur(durMs), date: new Date().toLocaleString('zh-CN'),
    format: finalBlob.type.includes('mp4') ? 'mp4' : 'webm',
  } });
}

/* ── 辅助函数 ────────────────────────────────────────── */

function elapsed() { return Date.now() - startTs - pausedMs; }

function pickWebM() {
  for (const t of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'])
    if (MediaRecorder.isTypeSupported(t)) return t;
  return 'video/webm';
}

function reportSize() {
  const s = chunks.reduce((a, c) => a + c.size, 0);
  notify('FILE_SIZE_UPDATE', { size: s });
}

function notify(type, extra) { chrome.runtime.sendMessage({ type, ...extra }).catch(() => {}); }

function releaseAll() {
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  audioCtx?.close().catch(() => {}); audioCtx = null;
}

function clearTimers() {
  if (stopTimer)  { clearTimeout(stopTimer);  stopTimer = null; }
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
}

function compact() { if (chunks.length > 120) chunks = [new Blob(chunks, { type: mime })]; }

function dl(blob, name) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = u; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(u), 30000);
}

function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map(v => String(v).padStart(2, '0')).join(':');
}

function countdown(sec) {
  return new Promise(resolve => {
    let r = sec;
    const tick = () => {
      if (r <= 0) { resolve(); return; }
      notify('COUNTDOWN_TICK', { remaining: r });
      r--; setTimeout(tick, 1000);
    };
    tick();
  });
}
