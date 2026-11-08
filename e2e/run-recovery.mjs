/**
 * 真实 MediaRecorder + 生产引擎的异常恢复 E2E。
 * 输入流用合成画面/音频以便无人值守；OPFS、消息路由、修复、下载均为生产代码。
 * 强杀仅针对当前测试 profile 对应的浏览器进程树。
 */
import { chromium } from 'playwright';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWebMSeekStructure, checkWebMKeyframeCues } from './lib-webmcheck.mjs';
import { makeCheckMp4 } from './lib-mp4check.mjs';

const E2E = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(E2E, '..');
const BUILD = path.join(E2E, '.recovery-ext-build');
const PROFILE = path.join(E2E, '.recovery-profile');
const DOWNLOADS = path.join(E2E, 'recovery-downloads');
const RECORD_MS = Math.max(3000, Number(process.env.E2E_RECOVERY_SECONDS || 12) * 1000);
let failed = 0;
function ok(name, condition, extra = '') {
  console.log(`${condition ? '  ✅' : '  ❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!condition) failed++;
}
const checkMp4 = makeCheckMp4(ok);

function copyExt(src, dst) {
  const rel = path.relative(ROOT, src);
  if (rel === '.git' || rel.startsWith('.git' + path.sep)
      || rel === 'e2e' || rel.startsWith('e2e' + path.sep)
      || rel.startsWith('lib' + path.sep + 'ffmpeg')) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) copyExt(path.join(src, name), path.join(dst, name));
  } else fs.copyFileSync(src, dst);
}
fs.rmSync(BUILD, { recursive: true, force: true });
copyExt(ROOT, BUILD);
function patch(file, anchor, replacement) {
  const target = path.join(BUILD, file);
  const source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  if (!source.includes(anchor)) throw new Error(`探针注入点不存在: ${file}`);
  fs.writeFileSync(target, source.replace(anchor, replacement));
}
patch('background.js', `  switch (msg.type) {`, `  switch (msg.type) {
    case 'E2E_PAUSE_DOWNLOAD_ID':
      await chrome.storage.session.set({ e2ePauseDownloadId: true });
      console.log('E2E_GATE_SET');
      return { ok: 1 };`);
patch('background.js', `      if (generation !== state.saveGeneration) {
        return { error: '保存任务已替换，忽略过期下载' };`, `      console.log('E2E_GATE_CHECK', msg.recordingId,
        (await chrome.storage.session.get('e2ePauseDownloadId')).e2ePauseDownloadId);
      while ((await chrome.storage.session.get('e2ePauseDownloadId')).e2ePauseDownloadId) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (generation !== state.saveGeneration) {
        return { error: '保存任务已替换，忽略过期下载' };`);
fs.appendFileSync(path.join(BUILD, 'offscreen.js'), `
let recoveryE2EEngine = null;
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type !== 'E2E_RECOVERY_START' || msg.target !== 'offscreen') return false;
  (async () => {
    recoveryE2EEngine = (msg.segmented ? createSegmentedRecorderEngine : createRecorderEngine)({
      getStream: async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 320; canvas.height = 180;
        const draw = canvas.getContext('2d');
        let frame = 0;
        const paint = () => {
          draw.fillStyle = 'hsl(' + (frame++ % 360) + ' 75% 45%)';
          draw.fillRect(0, 0, 320, 180);
          draw.fillStyle = 'white'; draw.font = '24px sans-serif';
          draw.fillText('RECOVERY ' + frame, 25, 95);
        };
        paint();
        const interval = setInterval(paint, 1000 / 30);
        const video = canvas.captureStream(30);
        const audio = new AudioContext();
        await audio.resume();
        const oscillator = audio.createOscillator();
        const destination = audio.createMediaStreamDestination();
        oscillator.connect(destination); oscillator.start();
        const stream = new MediaStream([...video.getVideoTracks(), ...destination.stream.getAudioTracks()]);
        stream.addEventListener('removetrack', () => {});
        const originalStop = stream.getTracks();
        for (const track of originalStop) track.addEventListener('ended', () => {
          clearInterval(interval); audio.close().catch(() => {});
        });
        return stream;
      },
      onEvent: (name, data) => onEvent(name, data),
      saveFile: (blob, filename, extra) => saveFileViaBackground(blob, filename, extra),
    });
    const started = await recoveryE2EEngine.start({
      outputFormat: msg.outputFormat, quality: 1000000, segmentMinutes: msg.segmentMinutes,
    });
    return started ? { ok: 1 } : { error: 'start failed' };
  })().then(reply).catch(error => reply({ error: error.message }));
  return true;
});
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type !== 'E2E_RECOVERY_STOP' || msg.target !== 'offscreen') return false;
  if (recoveryE2EEngine) recoveryE2EEngine.stop();
  reply({ ok: 1 });
  return false;
});
`);

const options = {
  headless: false,
  acceptDownloads: true,
  downloadsPath: DOWNLOADS,
  args: [
    `--disable-extensions-except=${BUILD}`, `--load-extension=${BUILD}`,
    '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check',
  ],
};
async function launch() {
  const ctx = await chromium.launchPersistentContext(PROFILE, options);
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  sw.on('console', msg => console.log('[SW]', msg.text()));
  return { ctx, sw };
}
async function hardKill(ctx) {
  const browser = ctx.browser();
  const cdp = await browser.newBrowserCDPSession();
  const info = await cdp.send('SystemInfo.getProcessInfo');
  const processInfo = info.processInfo.find(item => item.type === 'browser');
  if (!processInfo || !Number.isInteger(processInfo.id)) throw new Error('找不到测试浏览器 PID');
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/pid', String(processInfo.id), '/t', '/f'], { stdio: 'pipe' });
  } else {
    process.kill(processInfo.id, 'SIGKILL');
  }
  try { await ctx.close(); } catch (_) {}
}
async function state(popup) {
  return await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
}
async function waitSw(sw, predicate, timeout = RECORD_MS) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await sw.evaluate(predicate)) return;
    if (Date.now() > deadline) {
      const diagnostic = await sw.evaluate(async () => ({
        records: await durableStore.list(),
        completedRecordingIds: state.completedRecordingIds,
        status: state.status, processing: state.processing, savePhase: state.savePhase,
        segmentIndex: state.segmentIndex, savedSegments: state.savedSegments,
      }));
      throw new Error(`等待恢复场景条件超时：${JSON.stringify(diagnostic)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

for (const format of process.env.E2E_RECOVERY_SCENARIOS ? [] : ['webm', 'mp4']) {
  console.log(`\n恢复场景：${format.toUpperCase()} 强杀 → 重启 → 恢复`);
  for (const target of [PROFILE, DOWNLOADS]) fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  let { ctx, sw } = await launch();
  const extId = new URL(sw.url()).host;
  await sw.evaluate(async () => {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'E2E durable recording recovery',
    });
  });
  const started = await sw.evaluate(format => chrome.runtime.sendMessage({
    type: 'E2E_RECOVERY_START', target: 'offscreen', outputFormat: format,
  }), format);
  if (!started || started.error) throw new Error(JSON.stringify(started));
  await new Promise(resolve => setTimeout(resolve, RECORD_MS));
  const meta = await sw.evaluate(async () => (await durableStore.list())[0]);
  ok(`${format} 录制中持续暂存`, meta && meta.bytes > 10000 && meta.phase === 'recording', JSON.stringify(meta));
  await hardKill(ctx);

  ({ ctx, sw } = await launch());
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  const recoveredState = await state(popup);
  ok(`${format} 重启后发现未完成录制`, recoveredState.recoveryAvailable === true);
  const results = await Promise.all([
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'RECOVER_RECORDING' })),
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'RECOVER_RECORDING' })),
  ]);
  ok(`${format} 重复恢复请求均成功且只下载一次`, results.every(result => result?.ok === 1));
  const files = fs.readdirSync(DOWNLOADS).filter(name => !name.endsWith('.crdownload'));
  ok(`${format} 恢复只产生一个文件`, files.length === 1, JSON.stringify(files));
  if (files.length !== 1) throw new Error('恢复下载数量错误');
  const file = path.join(DOWNLOADS, files[0]);
  const media = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_name,codec_type',
    '-of', 'json', file,
  ], { encoding: 'utf8' });
  const decode = spawnSync('ffmpeg', ['-v', 'warning', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  ok(`${format} ffprobe 可解析`, media.status === 0, media.stderr.trim());
  ok(`${format} 完整解码成功`, decode.status === 0, decode.stderr.trim());
  ok(`${format} 无异常提前结束警告`, !decode.stderr.includes('File ended prematurely'), decode.stderr.trim());
  if (media.status === 0) {
    const info = JSON.parse(media.stdout);
    ok(`${format} 包含音视频且恢复时长合理`, info.streams.some(s => s.codec_type === 'video') &&
      info.streams.some(s => s.codec_type === 'audio') && Number(info.format.duration) >= 2 &&
      Number(info.format.duration) <= RECORD_MS / 1000 + 2, JSON.stringify(info.format));
  }
  if (format === 'webm') {
    const bytes = fs.readFileSync(file);
    const seek = checkWebMSeekStructure(bytes);
    const cues = checkWebMKeyframeCues(bytes);
    ok('WebM 恢复后 SeekHead/Cue 精确', seek.errors.length === 0, seek.errors.join('；'));
    ok('WebM 恢复后 Cue 均指向关键帧', cues.errors.length === 0, cues.errors.join('；'));
  } else {
    checkMp4(file, { minMs: 2000, maxMs: RECORD_MS + 2000 });
  }
  const after = await state(popup);
  ok(`${format} 恢复完成后解除恢复状态`, !after.recoveryAvailable && after.savePhase === 'complete');
  await ctx.close();
}

if (!process.env.E2E_RECOVERY_SCENARIOS || process.env.E2E_RECOVERY_SCENARIOS === 'segments') {
  console.log('\n恢复场景：多分段强杀 → 重启 → 按段恢复');
  for (const target of [PROFILE, DOWNLOADS]) fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  let { ctx, sw } = await launch();
  const extId = new URL(sw.url()).host;
  await sw.evaluate(async () => {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'E2E segmented recording recovery',
    });
  });
  // 直通引擎也必须具备正式 START 的会话归属，否则段级事件会被正确拒绝。
  await sw.evaluate(() => setState({ segmented: true, status: 'recording', mode: 'tab' }));
  await sw.evaluate(() => chrome.runtime.sendMessage({
    type: 'E2E_RECOVERY_START', target: 'offscreen', outputFormat: 'webm',
    segmented: true, segmentMinutes: 0.05,
  }));
  await waitSw(sw, () => state.completedRecordingIds.length >= 1);
  // service worker 的 sendMessage 不会回投给自身，直接设置同一个测试门闩。
  await sw.evaluate(() => chrome.storage.session.set({ e2ePauseDownloadId: true }));
  ok('下载 ID 门闩已生效', await sw.evaluate(async () =>
    (await chrome.storage.session.get('e2ePauseDownloadId')).e2ePauseDownloadId === true));
  await waitSw(sw, async () => {
    const records = await durableStore.list();
    const pending = records.filter(record => !state.completedRecordingIds.includes(record.id));
    return pending.length >= 2 && pending.every(record => record.bytes > 0);
  });
  const records = await sw.evaluate(() => durableStore.list());
  const completedIds = await sw.evaluate(() => state.completedRecordingIds || []);
  const pendingIds = records.filter(record => !completedIds.includes(record.id)).map(record => record.id);
  ok('多分段同时有已完成记录与至少两个未下载段', pendingIds.length >= 2 && completedIds.length >= 1 &&
    records.every(record => record.bytes > 0),
  JSON.stringify({ pending: records.map(record => ({ segment: record.segmentIndex, bytes: record.bytes, phase: record.phase })),
    completed: completedIds.length }));
  await hardKill(ctx);

  ({ ctx, sw } = await launch());
  await sw.evaluate(() => chrome.storage.session.remove('e2ePauseDownloadId'));
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  const recoveredState = await state(popup);
  ok('多分段重启后显示数量和恢复入口', recoveredState.recoveryAvailable === true && recoveredState.recoveryCount >= 2,
    JSON.stringify({ count: recoveredState.recoveryCount, bytes: recoveredState.durableBytes }));
  const results = await Promise.all([
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'RECOVER_RECORDING' })),
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'RECOVER_RECORDING' })),
  ]);
  ok('多分段重复恢复互斥且全部成功', results.every(result => result?.ok === 1), JSON.stringify(results));
  const files = fs.readdirSync(DOWNLOADS).filter(name => !name.endsWith('.crdownload'));
  const history = await popup.evaluate(() => chrome.storage.local.get('recordingHistory')
    .then(data => data.recordingHistory || []));
  ok('每个未下载 recordingId 都有独立恢复历史', pendingIds.every(id =>
    history.filter(entry => entry.recordingId === id).length === 1), JSON.stringify({ pendingIds, history }));
  ok('多分段恢复产生全部文件', files.length >= 2, JSON.stringify(files));
  for (const name of files) {
    const file = path.join(DOWNLOADS, name);
    const decode = spawnSync('ffmpeg', ['-v', 'warning', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
    ok(`分段 ${name} 完整解码`, decode.status === 0 && !decode.stderr.includes('File ended prematurely'), decode.stderr.trim());
    const bytes = fs.readFileSync(file);
    ok(`分段 ${name} 关键帧索引正确`, checkWebMKeyframeCues(bytes).errors.length === 0);
  }
  const after = await state(popup);
  ok('全部分段完成后才清恢复状态', !after.recoveryAvailable && after.recoveryCount === 0 && after.savePhase === 'complete',
    JSON.stringify(after));
  await ctx.close();
}

const scenarios = (process.env.E2E_RECOVERY_SCENARIOS
  ? process.env.E2E_RECOVERY_SCENARIOS.split(',') : ['offscreen', 'reload', 'discard', 'download-intent'])
  .filter(name => name !== 'segments');
for (const scenario of scenarios) {
  console.log(`\n恢复场景：${scenario}`);
  for (const target of [PROFILE, DOWNLOADS]) fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  let { ctx, sw } = await launch();
  const extId = new URL(sw.url()).host;
  await sw.evaluate(async () => {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'E2E recovery context lifecycle',
    });
  });
  await sw.evaluate(() => chrome.runtime.sendMessage({
    type: 'E2E_RECOVERY_START', target: 'offscreen', outputFormat: 'webm',
  }));
  await sw.evaluate(() => setState({ status: 'recording', mode: 'tab' }));
  await new Promise(resolve => setTimeout(resolve, Math.min(RECORD_MS, 6000)));
  const meta = await sw.evaluate(async () => (await durableStore.list())[0]);
  ok(`${scenario} 暂存已写入`, meta && meta.bytes > 10000);

  if (scenario === 'download-intent') {
    const control = await ctx.newPage();
    await control.goto(`chrome-extension://${extId}/popup.html`);
    await control.evaluate(() => chrome.runtime.sendMessage({ type: 'E2E_PAUSE_DOWNLOAD_ID' }));
    await sw.evaluate(() => chrome.runtime.sendMessage({ type: 'E2E_RECOVERY_STOP', target: 'offscreen' }));
    let intentSeen = false;
    for (let i = 0; i < 100; i++) {
      const current = await sw.evaluate(async () => (await durableStore.list())[0]);
      const files = fs.readdirSync(DOWNLOADS).filter(name => !name.endsWith('.crdownload'));
      intentSeen = !!current?.downloadIntent && !current.downloadId && files.length > 0;
      if (intentSeen) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    ok('下载已创建但 id 未落盘的故障窗口已触发', intentSeen);
    await hardKill(ctx);
    ({ ctx, sw } = await launch());
  } else if (scenario === 'reload') {
    const extensions = await ctx.newPage();
    await extensions.goto('chrome://extensions');
    const card = extensions.locator('extensions-item').first();
    const reload = card.locator('#dev-reload-button');
    try {
      await reload.waitFor({ state: 'visible', timeout: 3000 });
    } catch (_) {
      const devMode = extensions.locator('extensions-manager #devMode');
      if (await devMode.count() && await devMode.getAttribute('checked') === null) await devMode.click();
    }
    await reload.click({ timeout: 15000 });
    const enabled = card.locator('#enableToggle');
    const unavailable = await enabled.evaluate(el => el.disabled ||
      el.getAttribute('aria-disabled') === 'true' || el.getAttribute('aria-checked') === 'false');
    if (unavailable) {
      console.log('  ⚠️ SKIP：CfT 管理策略在 reload 后禁用侧载扩展，无法完成真实 reload 恢复测试');
      await extensions.close();
      await ctx.close();
      continue;
    }
    await extensions.close();
  } else {
    await sw.evaluate(() => chrome.offscreen.closeDocument());
  }
  let popup = null;
  for (let attempt = 0; attempt < 40 && !popup; attempt++) {
    const candidate = await ctx.newPage();
    try {
      await candidate.goto(`chrome-extension://${extId}/popup.html`);
      popup = candidate;
    } catch (error) {
      await candidate.close();
      if (scenario !== 'reload' || !error.message.includes('ERR_BLOCKED_BY_CLIENT')) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  if (!popup) throw new Error('reload 后扩展页面未恢复');
  const lost = await state(popup);
  ok(`${scenario} 后显示恢复入口`, lost.recoveryAvailable === true, JSON.stringify(lost));

  if (scenario === 'discard') {
    const discarded = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'DISCARD_RECOVERY' }));
    const fileExists = await popup.evaluate(async fileName => {
      try {
        const root = await navigator.storage.getDirectory();
        await root.getFileHandle(fileName);
        return true;
      } catch (_) { return false; }
    }, meta.fileName);
    const afterDiscard = await state(popup);
    ok('明确丢弃删除 OPFS 文件且不清下载', discarded?.ok === 1 && !fileExists &&
      !afterDiscard.recoveryAvailable && fs.readdirSync(DOWNLOADS).length === 0);
  } else {
    const recovered = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'RECOVER_RECORDING' }));
    const files = fs.readdirSync(DOWNLOADS).filter(name => !name.endsWith('.crdownload'));
    ok(`${scenario} 后恢复下载成功`, recovered?.ok === 1 && files.length === 1,
      JSON.stringify({ recovered, files }));
    if (files.length === 1) {
      const decode = spawnSync('ffmpeg', ['-v', 'warning', '-i', path.join(DOWNLOADS, files[0]), '-f', 'null', '-'], { encoding: 'utf8' });
      ok(`${scenario} 恢复文件完整解码`, decode.status === 0 && !decode.stderr.includes('File ended prematurely'), decode.stderr.trim());
    }
  }
  await ctx.close();
}

console.log(failed ? `\n${failed} 项失败 ❌` : '\n异常恢复 E2E 全部通过 🎉');
process.exit(failed ? 1 : 0);
