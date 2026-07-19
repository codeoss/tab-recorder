/**
 * popup.js — 弹窗 UI 控制器
 *
 * 薄层：把指令发给后台、轮询状态。
 *   - 标签页录制：在 offscreen 内进行，弹窗可关闭。
 *   - 窗口/屏幕：后台会打开 recorder.html 窗口。
 */

const $ = id => document.getElementById(id);
const el = {
  rec: $('recBtn'), label: $('recLabel'), timer: $('timer'),
  limTxt: $('limTxt'), pWrap: $('pWrap'), pBar: $('pBar'),
  ctrls: $('ctrls'), pause: $('pauseBtn'), discard: $('discardBtn'),
  dot: $('dot'), stxt: $('stxt'), size: $('sizeInfo'), fmtInfo: $('fmtInfo'),
  sp: $('sp'), cdOvl: $('cdOvl'), cdNum: $('cdNum'),
  res: $('res'), fps: $('fps'), qual: $('qual'),
  pta: $('pta'), ptaRow: $('ptaRow'),
  compat: $('compat'), compatRow: $('compatRow'), compatNote: $('compatNote'),
  cd: $('cd'), cdRow: $('cdRow'),
  fmt: $('fmt'),
  tlH: $('tlH'), tlM: $('tlM'), tlS: $('tlS'),
  hist: $('hist'), deskNote: $('deskNote'),
};

let src = 'tab';
let state = 'idle';
let tick = null;
let poll = null;
let bgStart = 0, bgPaused = 0, bgLimit = 0;

/* ── 初始化 ──────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  events();
  restore();
  poll = setInterval(pollState, 1500);
});

function events() {
  el.rec.addEventListener('click', toggle);
  el.pause.addEventListener('click', togglePause);
  el.discard.addEventListener('click', discard);

  document.querySelectorAll('.sb').forEach(b => b.addEventListener('click', () => {
    if (state !== 'idle') return;
    document.querySelectorAll('.sb').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    src = b.dataset.source;
    updateSourceUI();
    save();
  }));

  [el.res, el.fps, el.qual, el.pta, el.compat, el.cd, el.fmt, el.tlH, el.tlM, el.tlS].forEach(
    e => e.addEventListener('change', () => { updateSourceUI(); save(); })
  );
}

function updateSourceUI() {
  const isTab = src === 'tab';
  const isCompat = el.compat.checked;
  el.compatRow.classList.toggle('hidden', !isTab);
  el.compatNote.classList.toggle('hidden', !isTab || !isCompat);
  // 「保持标签页声音」仅对普通标签页模式（兼容模式不劫持音频）
  el.ptaRow.classList.toggle('hidden', !isTab || isCompat);
  el.cdRow.classList.toggle('hidden', !isTab);
  // 桌面 / 兼容模式都弹独立窗口
  el.deskNote.classList.toggle('hidden', isTab && !isCompat);

  // 输出格式显示
  el.fmtInfo.textContent = '格式: ' + (el.fmt.value === 'mp4' ? 'MP4' : 'WebM');
}

/* ── 设置存取 ────────────────────────────────────────── */

function getRes() {
  const [w, h] = (el.res.value || '1920x1080').split('x').map(Number);
  return { width: w || 1920, height: h || 1080 };
}

function save() {
  const r = getRes();
  chrome.storage.local.set({ recorderSettings: {
    source: src,
    playTabAudio: el.pta.checked,
    compatMode: el.compat.checked,
    countdown: el.cd.value,
    width: r.width, height: r.height,
    fps: parseInt(el.fps.value) || 30,
    quality: el.qual.value,
    outputFormat: el.fmt.value,
    tlH: el.tlH.value, tlM: el.tlM.value, tlS: el.tlS.value,
  }});
}

async function restore() {
  chrome.storage.local.get('recorderSettings', d => {
    const s = d.recorderSettings; if (!s) return;
    src = s.source || 'tab';
    el.pta.checked = s.playTabAudio !== false;
    el.compat.checked = s.compatMode || false;
    el.cd.value = s.countdown || '3';
    el.res.value = `${s.width || 1920}x${s.height || 1080}`;
    el.fps.value = String(s.fps || 30);
    el.qual.value = s.quality || '8000000';
    el.fmt.value = s.outputFormat || 'webm';
    el.tlH.value = s.tlH || '0';
    el.tlM.value = s.tlM || '0';
    el.tlS.value = s.tlS || '0';
    document.querySelectorAll('.sb').forEach(b => b.classList.toggle('on', b.dataset.source === src));
    updateSourceUI();
  });

  // 检测是否有进行中的录制
  try {
    const bg = await send('GET_STATE');
    if (bg && bg.status !== 'idle') {
      state = bg.status;
      bgStart = bg.startTime; bgPaused = bg.pausedTime; bgLimit = bg.timeLimit;
      ui();
      if (state === 'recording') startTick();
      showLimit();
      if (bg.fileSize > 0) el.size.textContent = fmtMB(bg.fileSize);
    }
  } catch (_) {}

  loadHistory();
}

/* ── 录制控制 ────────────────────────────────────────── */

async function toggle() {
  if (state === 'idle') await start();
  else await stop();
}

function timeLimitSec() {
  return (parseInt(el.tlH.value) || 0) * 3600
       + (parseInt(el.tlM.value) || 0) * 60
       + (parseInt(el.tlS.value) || 0);
}

async function start() {
  el.rec.style.pointerEvents = 'none';
  status('rdy', '准备中...');

  const isCompatTab = src === 'tab' && el.compat.checked;
  // 仅普通标签页模式走倒计时（兼容/桌面模式会弹独立窗口）
  const countdownSec = (src === 'tab' && !isCompatTab) ? (parseInt(el.cd.value) || 0) : 0;
  if (countdownSec > 0) showCountdown(countdownSec);

  const r = getRes();
  try {
    const res = await send('START_RECORDING', {
      source: src,
      playTabAudio: el.pta.checked,
      compatMode: el.compat.checked,
      width: r.width,
      height: r.height,
      fps: parseInt(el.fps.value) || 30,
      quality: el.qual.value,
      timeLimit: timeLimitSec(),
      outputFormat: el.fmt.value,
      countdownSec,
    });
    if (res?.error) throw new Error(res.error);

    el.cdOvl.classList.add('hidden');

    const usesRecorderWindow = (src !== 'tab') || isCompatTab;
    state = 'recording';
    bgStart = Date.now(); bgPaused = 0; bgLimit = timeLimitSec();
    ui(); startTick(); showLimit();
    if (usesRecorderWindow) {
      status('rec', isCompatTab ? '云桌面兼容模式录制中' : '录制窗口已打开');
    }
  } catch (e) {
    el.cdOvl.classList.add('hidden');
    status('rdy', `错误: ${e.message}`);
    state = 'idle'; ui();
  }
  el.rec.style.pointerEvents = 'auto';
}

async function stop() {
  try { await send('STOP_RECORDING'); } catch (_) {}
  state = 'idle'; stopTick(); ui();
  status('rdy', '录制完成');
  hideLimit();
  setTimeout(loadHistory, 600);
}

async function togglePause() {
  if (state === 'recording') {
    await send('PAUSE_RECORDING');
    state = 'paused'; stopTick(); ui();
  } else if (state === 'paused') {
    await send('RESUME_RECORDING');
    try { const bg = await send('GET_STATE'); bgPaused = bg.pausedTime; } catch (_) {}
    state = 'recording'; startTick(); ui();
  }
}

async function discard() {
  if (!confirm('确定丢弃此次录制？')) return;
  try { await send('DISCARD_RECORDING'); } catch (_) {}
  state = 'idle'; stopTick();
  el.timer.textContent = '00:00:00';
  el.size.textContent = '';
  hideLimit(); ui();
  status('rdy', '已丢弃');
}

/* ── 计时 ────────────────────────────────────────────── */

function startTick() {
  stopTick();
  tick = setInterval(() => {
    const ms = Date.now() - bgStart - bgPaused;
    el.timer.textContent = fmtMs(ms);
    if (bgLimit > 0) el.pBar.style.width = Math.min(100, (ms / (bgLimit * 1000)) * 100) + '%';
  }, 250);
}
function stopTick() { if (tick) { clearInterval(tick); tick = null; } }

function showLimit() {
  if (bgLimit > 0) {
    el.limTxt.textContent = '/ ' + fmtMs(bgLimit * 1000);
    el.limTxt.classList.remove('hidden');
    el.pWrap.classList.remove('hidden');
    el.pBar.style.width = '0';
  }
}
function hideLimit() { el.limTxt.classList.add('hidden'); el.pWrap.classList.add('hidden'); }

function showCountdown(sec) { el.cdNum.textContent = sec; el.cdOvl.classList.remove('hidden'); }

/* ── 状态轮询 ────────────────────────────────────────── */

async function pollState() {
  try {
    const bg = await send('GET_STATE');
    if (!bg) return;
    if (bg.fileSize > 0 && state !== 'idle') el.size.textContent = fmtMB(bg.fileSize);

    if (bg.status === 'countdown' && bg.countdownRemaining > 0) showCountdown(bg.countdownRemaining);

    // 自动停止检测
    if (bg.status === 'idle' && state !== 'idle') {
      el.cdOvl.classList.add('hidden');
      state = 'idle'; stopTick(); ui();
      status('rdy', bgLimit > 0 ? '定时录制完成' : '录制完成');
      hideLimit();
      setTimeout(loadHistory, 600);
    }

    // 倒计时后开始录制
    if (bg.status === 'recording' && state === 'idle') {
      el.cdOvl.classList.add('hidden');
      state = 'recording';
      bgStart = bg.startTime; bgPaused = bg.pausedTime; bgLimit = bg.timeLimit;
      ui(); startTick(); showLimit();
    }
  } catch (_) {}
}

/* ── UI 状态 ─────────────────────────────────────────── */

function ui() {
  switch (state) {
    case 'idle':
      el.rec.className = 'rb'; el.label.textContent = '点击开始录制';
      el.ctrls.classList.add('hidden'); el.timer.classList.remove('on');
      status('rdy', '就绪 — 关闭面板不影响录制');
      break;
    case 'recording':
      el.rec.className = 'rb rec'; el.label.textContent = '点击停止录制';
      el.ctrls.classList.remove('hidden'); el.pause.innerHTML = '⏸ 暂停';
      el.timer.classList.add('on');
      status('rec', '录制中… 可安全关闭面板');
      break;
    case 'paused':
      el.rec.className = 'rb pau'; el.label.textContent = '点击停止录制';
      el.ctrls.classList.remove('hidden'); el.pause.innerHTML = '▶ 继续';
      el.timer.classList.add('on');
      status('pau', '已暂停');
      break;
  }
  el.sp.classList.toggle('dis', state !== 'idle');
}

function status(type, txt) { el.dot.className = `sd ${type}`; el.stxt.textContent = txt; }

/* ── 历史记录 ────────────────────────────────────────── */

function loadHistory() {
  chrome.storage.local.get('recordingHistory', d => {
    const h = d.recordingHistory || [];
    if (!h.length) { el.hist.innerHTML = ''; return; }
    let s = '<div class="sl" style="margin-top:6px">最近录制</div>';
    h.slice(0, 5).forEach(r => {
      const tag = r.format === 'mp4' ? '🎥' : '🎬';
      s += `<div class="hi"><div class="rn">${tag} ${r.filename}</div><div class="rm">${r.duration} · ${fmtMB(r.size)} · ${r.date}</div></div>`;
    });
    el.hist.innerHTML = s;
  });
}

/* ── 辅助 ────────────────────────────────────────────── */

function fmtMs(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60]
    .map(v => String(v).padStart(2, '0')).join(':');
}
function fmtMB(b) { return (b / 1048576).toFixed(1) + ' MB'; }
function send(type, extra) { return chrome.runtime.sendMessage({ type, ...extra }); }
