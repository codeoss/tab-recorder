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
 *   6. saveFile：经 save-file.js 等待真实下载结果；OFF_RETRY_SAVE 只重试下载。
 *      本上下文没有 UI，保存进度由 background 打开的 save-status.html 展示
 *
 * 关键点：
 *   - 跑在 offscreen document 内，popup 关闭、Chrome 最小化均不中断。
 *   - tabCapture 会把标签页音频「劫持」走，导致用户听不到；
 *     用 AudioContext 把音频接到 destination，录制时用户仍能听到声音。
 */

let audioCtx = null;
let engine = null;
let startGen = 0;   // 启动代次：每次新启动或取消都递增，旧代次的 pending 启动自动失效

/* ── 消息处理：把 background 的 OFF_* 转成 engine 方法 ── */

chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.target !== 'offscreen') return false;
  const h = {
    OFF_START:   () => doStart(msg),
    // 停止/丢弃一律递增代次：任何还在倒计时/取 streamId 途中的旧启动都会失效
    OFF_STOP:    () => { startGen++; if (engine) engine.stop();    return { ok: 1 }; },
    OFF_PAUSE:   () => { engine && engine.pause();   return { ok: 1 }; },
    OFF_RESUME:  () => { engine && engine.resume();  return { ok: 1 }; },
    OFF_DISCARD: () => { startGen++; if (engine) engine.discard(); return { ok: 1 }; },
    OFF_RETRY_SAVE: () => engine ? engine.retrySave() : Promise.resolve(false),
  };
  const fn = h[msg.type];
  if (!fn) return false;
  const r = fn();
  if (r instanceof Promise) { r.then(reply).catch(e => reply({ error: e.message })); return true; }
  reply(r); return false;
});

/* ── 倒计时 → 创建引擎 → 启动 ─────────────────────── */

async function doStart(opts) {
  // 上一段还在录制/保存（onStopped 异步链未完）时拒绝：
  // 旧链完成时会发 RECORDING_STOPPED，会把新录制的状态掐掉
  if (engine && engine.isBusy()) return { error: '上一段录制仍在保存中，请稍候' };

  const gen = ++startGen;   // 本代启动的令牌；之后每个 await 检查点都校验
  if (opts.countdownSec > 0) {
    const completed = await countdown(opts.countdownSec, gen);
    if (!completed) return { error: '已取消' };   // 倒计时期间被停止/丢弃/新启动取代
  }

  // 倒计时结束后才向 background 取 streamId：getMediaStreamId 的 id 应
  // 尽快消费；提前取好再等倒计时（最长 10s+）可能失效，导致 getUserMedia 挂起
  const idMsg = await chrome.runtime.sendMessage({ type: 'GET_STREAM_ID', tabId: opts.tabId });
  if (gen !== startGen) return { error: '已取消' };   // 取 id 往返期间被取消/取代
  if (!idMsg || !idMsg.streamId) {
    return { error: (idMsg && idMsg.error) || '获取 streamId 失败' };
  }
  opts.streamId = idMsg.streamId;

  engine = createRecorderEngine({
    // 取流返回后也可能代次已失效（取消/新启动落在 getUserMedia 期间）：
    // 立即停掉刚到手的流并抛错，绝不让它变成没人持有的孤儿录制
    getStream: async (o) => {
      const s = await getTabStream(o);
      if (gen !== startGen) {
        s.getTracks().forEach(t => t.stop());
        throw new Error('已取消');
      }
      return s;
    },
    onEvent: (name, data) => onEvent(name, data),
    releaseExtra: () => releaseAudioCtx(),
    saveFile: (blob, filename) => saveFileViaBackground(blob, filename),
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
    case 'stopped':
      notify('RECORDING_STOPPED', {
        historyEntry: data && data.historyEntry,
        discarded: !!(data && data.discarded),
      });
      break;
    case 'size':     notify('FILE_SIZE_UPDATE',  { size: data.bytes }); break;
    case 'processing':
      notify('ENGINE_PROCESSING', { active: !!(data && data.active), stage: data && data.stage });
      break;
    case 'saveerror':
      notify('ENGINE_SAVE_ERROR', { message: data && data.message, canRetry: true });
      break;
    case 'tick':     /* offscreen 不显示计时，由 popup 自己算 */ break;
    case 'started':
    case 'paused':
    case 'resumed':  /* offscreen 无本地 UI，暂停/恢复只能来自 background 下行，无需回传 */
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

// 返回 Promise<boolean>：true = 倒计时跑完；false = 期间被取消/被新启动取代
function countdown(sec, gen) {
  return new Promise(resolve => {
    let r = sec;
    const tick = () => {
      if (gen !== startGen) { resolve(false); return; }
      if (r <= 0) { resolve(true); return; }
      notify('COUNTDOWN_TICK', { remaining: r });
      r--; setTimeout(tick, 1000);
    };
    tick();
  });
}
