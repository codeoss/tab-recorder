/**
 * offscreen.js — 标签页录制（接入 core-recorder 引擎）
 *
 * 仅负责「标签页」录制（窗口/屏幕走 recorder.html）。
 * 录制引擎逻辑（MediaRecorder 生命周期、onStopped、计时等）见
 * core-recorder.js。本文件只负责：
 *   1. 接收 background 的 OFF_* 消息，转调 engine
 *   2. 实现 getStream：用 chromeMediaSource:'tab' 一次拿到视频+标签页音频
 *   3. 防静音回环：把劫持走的标签页音频接回 destination（可选）
 *   4. 倒计时（OFF_START 的 countdownSec 参数）
 *   5. onEvent：把状态/大小/历史通知回 background
 *
 * 关键点：
 *   - 跑在 offscreen document 内，popup 关闭、Chrome 最小化均不中断。
 *   - tabCapture 会把标签页音频「劫持」走，导致用户听不到；
 *     用 AudioContext 把音频接到 destination，录制时用户仍能听到声音。
 */

let audioCtx = null;
let engine = null;

/* ── 消息处理：把 background 的 OFF_* 转成 engine 方法 ── */

chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.target !== 'offscreen') return false;
  const h = {
    OFF_START:   () => doStart(msg),
    OFF_STOP:    () => { engine && engine.stop();    return { ok: 1 }; },
    OFF_PAUSE:   () => { engine && engine.pause();   return { ok: 1 }; },
    OFF_RESUME:  () => { engine && engine.resume();  return { ok: 1 }; },
    OFF_DISCARD: () => { engine && engine.discard(); return { ok: 1 }; },
  };
  const fn = h[msg.type];
  if (!fn) return false;
  const r = fn();
  if (r instanceof Promise) { r.then(reply).catch(e => reply({ error: e.message })); return true; }
  reply(r); return false;
});

/* ── 倒计时 → 创建引擎 → 启动 ─────────────────────── */

async function doStart(opts) {
  if (opts.countdownSec > 0) await countdown(opts.countdownSec);

  engine = createRecorderEngine({
    getStream: (o) => getTabStream(o),
    onEvent: (name, data) => onEvent(name, data),
    releaseExtra: () => releaseAudioCtx(),
  });

  const ok = await engine.start(opts);
  return ok ? { ok: 1 } : { error: '取流失败' };
}

/* ── 取流：tabCapture 视频音频同流 ─────────────────── */

async function getTabStream(opts) {
  const { streamId, playTabAudio, width, height, fps } = opts;
  const stream = await navigator.mediaDevices.getUserMedia({
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
  return stream;
}

/* ── onEvent → 通知 background ─────────────────────── */

function onEvent(name, data) {
  switch (name) {
    case 'stopped':  notify('RECORDING_STOPPED', { historyEntry: data && data.historyEntry }); break;
    case 'size':     notify('FILE_SIZE_UPDATE',  { size: data.bytes }); break;
    case 'tick':     /* offscreen 不显示计时，由 popup 自己算 */ break;
    case 'processing':
    case 'started':
    case 'paused':
    case 'resumed':
    case 'saved':    /* offscreen 无 UI，无需处理 */ break;
  }
}

/* ── 辅助 ────────────────────────────────────────────── */

function notify(type, extra) {
  try { chrome.runtime.sendMessage({ type, ...extra }).catch(() => {}); } catch (_) {}
}

function releaseAudioCtx() {
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
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
