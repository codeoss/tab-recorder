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
  savePanel: $('savePanel'), saveText: $('saveText'), saveProgress: $('saveProgress'),
  openSaveBtn: $('openSaveBtn'), retrySaveBtn: $('retrySaveBtn'), discardSaveBtn: $('discardSaveBtn'),
};

let src = 'tab';
let state = 'idle';
let tick = null;
let poll = null;
let bgStart = 0, bgPaused = 0, bgLimit = 0;
let wasProcessing = false;   // 上次轮询时引擎是否在保存/转码（用于完成时刻刷历史）
let saveActive = false;      // 保存/下载/可重试失败期间，禁止开始与修改设置

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
  el.openSaveBtn.addEventListener('click', () => send('OPEN_SAVE_WINDOW'));
  el.retrySaveBtn.addEventListener('click', async () => {
    const res = await send('RETRY_SAVE');
    if (res && res.error) status('pau', res.error);
    await pollState();
  });
  el.discardSaveBtn.addEventListener('click', discard);
  // 倒计时覆盖层全屏盖住弹窗，本身即取消按钮（大点击目标）
  el.cdOvl.addEventListener('click', () => { if (state === 'countdown') stop(); });

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
    if (bg) renderSaveState(bg);
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
  saveActive = false;
  el.savePanel.classList.add('hidden');
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
    state = 'idle'; ui();   // ui() 会重置状态文案，先调用
    status('rdy', e.message === '已取消' ? '已取消' : `错误: ${e.message}`);
  }
  el.rec.style.pointerEvents = 'auto';
}

async function stop() {
  const cancelling = state === 'countdown';
  try { await send('STOP_RECORDING'); } catch (_) {}
  state = 'idle'; stopTick(); ui();
  el.cdOvl.classList.add('hidden');   // 取消倒计时时必须收掉覆盖层，否则会停在最后的秒数
  hideLimit();
  if (cancelling) {
    status('rdy', '已取消');
  } else {
    let bg = null;
    try { bg = await send('GET_STATE'); } catch (_) {}
    renderSaveState({ ...(bg || {}), processing: true, savePhase: (bg && bg.savePhase) || 'processing' });
  }
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
  let result;
  try { result = await send('DISCARD_RECORDING'); }
  catch (error) { result = { error: error.message }; }
  if (!result || result.error || result.ok === 0) {
    let bg = null;
    try { bg = await send('GET_STATE'); } catch (_) {}
    renderSaveState(bg || { processing: true, savePhase: 'processing' });
    status('pau', result?.error || '丢弃失败，请查看保存状态');
    return;
  }
  state = 'idle'; stopTick();
  el.timer.textContent = '00:00:00';
  el.size.textContent = '';
  hideLimit();
  wasProcessing = false;
  renderSaveState({ processing: false, savePhase: '' });
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

    if (bg.status === 'countdown') {
      if (state !== 'countdown') { state = 'countdown'; ui(); }
      el.rec.style.pointerEvents = 'auto';
      if (bg.countdownRemaining > 0) showCountdown(bg.countdownRemaining);
    }

    if (bg.status === 'idle' && state !== 'idle') {
      el.cdOvl.classList.add('hidden');
      state = 'idle'; stopTick(); ui();
      hideLimit();
    }

    if (bg.status === 'recording' && (state === 'idle' || state === 'countdown')) {
      el.cdOvl.classList.add('hidden');
      state = 'recording';
      bgStart = bg.startTime; bgPaused = bg.pausedTime; bgLimit = bg.timeLimit;
      ui(); startTick(); showLimit();
    }

    if (bg.status === 'recording' && state === 'recording' &&
        bg.startTime && Math.abs(bg.startTime - bgStart) > 2000) {
      bgStart = bg.startTime; bgPaused = bg.pausedTime;
    }

    const active = !!bg.processing || (bg.savePhase === 'error' && !!bg.saveCanRetry);
    if (wasProcessing && !active && bg.savePhase === 'complete') setTimeout(loadHistory, 300);
    wasProcessing = active;
    renderSaveState(bg);
  } catch (_) {}
}

function renderSaveState(bg) {
  const phase = bg.savePhase || (bg.processing ? 'processing' : '');
  saveActive = !!bg.processing || (phase === 'error' && !!bg.saveCanRetry);
  el.savePanel.classList.toggle('hidden', !phase);
  el.openSaveBtn.hidden = !(bg.mode === 'tab' && (bg.processing || phase === 'error'));
  el.retrySaveBtn.hidden = !(phase === 'error' && bg.saveCanRetry);
  el.discardSaveBtn.hidden = el.retrySaveBtn.hidden;
  if (!phase) { ui(); return; }

  let title = '';
  let detail = '';
  let statusType = 'rdy';
  let statusText = '';
  if (phase === 'complete') {
    title = '已保存：' + (bg.saveFilename || '录制文件');
    detail = '下载已完成，可以开始新录制';
    statusText = '录制完成';
  } else if (phase === 'error') {
    title = '保存失败：' + (bg.saveError || '未知错误') + (bg.saveCanRetry ? '' : '（无法重试）');
    detail = bg.saveCanRetry ? '文件仍在内存，可重试或明确丢弃' : '保存上下文已关闭，无法重试';
    statusType = 'pau';
    statusText = bg.saveCanRetry ? '保存失败，可重试' : '保存上下文已关闭';
  } else {
    const stages = {
      'webm-fix': '正在整理 WebM 索引',
      'mp4-fix': '正在修复 MP4 时长与索引',
      transcode: '正在转码',
      download: '正在保存到下载目录',
    };
    title = phase === 'downloading' ? '正在保存到下载目录' : (stages[bg.processingStage] || '正在整理视频');
    if (phase === 'downloading' && bg.saveTotal > 0) {
      const percent = Math.min(100, Math.floor(bg.saveReceived / bg.saveTotal * 100));
      detail = `${percent}% · ${fmtMB(bg.saveReceived)} / ${fmtMB(bg.saveTotal)}`;
    } else {
      detail = '完成前请勿关闭浏览器';
    }
    statusText = phase === 'downloading' ? '正在保存到下载目录…' : '正在保存/整理视频…';
  }
  el.saveText.textContent = title;
  el.saveProgress.textContent = detail;
  ui();
  if (state === 'idle') status(statusType, statusText);
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
    case 'countdown':
      // 倒计时阶段：按钮可用作取消（stop 路径会中止 offscreen 的倒计时）
      el.rec.className = 'rb pau'; el.label.textContent = '点击取消倒计时';
      el.ctrls.classList.add('hidden'); el.timer.classList.remove('on');
      status('rdy', '倒计时中…');
      break;
  }
  el.sp.classList.toggle('dis', state !== 'idle' || saveActive);
  el.rec.style.pointerEvents = (state === 'idle' && saveActive) ? 'none' : 'auto';
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
