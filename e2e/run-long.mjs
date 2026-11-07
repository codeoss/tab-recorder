/**
 * 真实 tabCapture 长时录制压测。
 *
 * 生产录制代码不变；测试副本仅增加快捷键与诊断消息。持续记录状态、
 * offscreen JS 堆、浏览器进程 RSS/Pss、OPFS 用量和已确认暂存字节，
 * 结束后仍走生产修复与真实下载链，并抽查前/中/后段解码。
 *
 * 示例：DISPLAY=:99 E2E_LONG_MINUTES=270 node run-long.mjs
 */
import { chromium } from 'playwright';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(E2E, '..');
const WORK = path.join(E2E, '.cache', 'long-recording');
const BUILD = path.join(WORK, 'ext');
const PROFILE = path.join(WORK, 'profile');
const DOWNLOADS = path.join(WORK, 'downloads');
const SAMPLES = path.join(WORK, 'samples.jsonl');
const REPORT = path.join(WORK, 'report.json');
const DURATION_MS = Math.max(1, Number(process.env.E2E_LONG_MINUTES || 270)) * 60000;
const SAMPLE_MS = Math.max(5, Number(process.env.E2E_LONG_SAMPLE_SECONDS || 60)) * 1000;
const SAVE_TIMEOUT_MS = Math.max(5, Number(process.env.E2E_LONG_SAVE_TIMEOUT_MINUTES || 60)) * 60000;
const config = {
  width: Number(process.env.E2E_LONG_WIDTH || 1920),
  height: Number(process.env.E2E_LONG_HEIGHT || 1080),
  fps: Number(process.env.E2E_LONG_FPS || 30),
  quality: String(Number(process.env.E2E_LONG_BITRATE || 8000000)),
  outputFormat: process.env.E2E_LONG_FORMAT || 'webm',
  playTabAudio: true,
  compatMode: false,
  countdownSec: 0,
  timeLimit: Math.ceil(DURATION_MS / 1000) + 120,
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const mib = bytes => Number((bytes / 1048576).toFixed(1));
const hours = ms => (ms / 3600000).toFixed(3);

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });

function copyExt(src, dst) {
  const rel = path.relative(ROOT, src);
  if (rel === '.git' || rel.startsWith('.git' + path.sep)
      || rel === '.cache' || rel.startsWith('.cache' + path.sep)
      || rel === '.tmp' || rel.startsWith('.tmp' + path.sep)
      || rel === 'e2e' || rel.startsWith('e2e' + path.sep)
      || rel.startsWith('lib' + path.sep + 'ffmpeg')) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) copyExt(path.join(src, name), path.join(dst, name));
  } else fs.copyFileSync(src, dst);
}
copyExt(ROOT, BUILD);
const manifestPath = path.join(BUILD, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.commands = { _execute_action: { suggested_key: { default: 'Ctrl+Shift+E' } } };
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

fs.appendFileSync(path.join(BUILD, 'offscreen.js'), `
globalThis.__longEvents = [];
addEventListener('error', event => {
  globalThis.__longEvents.push({ type: 'error', message: event.message, at: Date.now() });
});
addEventListener('unhandledrejection', event => {
  globalThis.__longEvents.push({ type: 'unhandledrejection', message: String(event.reason), at: Date.now() });
});
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type !== 'E2E_LONG_DIAG_FROM_BG' || msg.target !== 'offscreen') return false;
  (async () => {
    const storage = await navigator.storage.estimate();
    reply({
      ok: 1,
      at: Date.now(),
      recording: engine ? engine.isRecording() : false,
      busy: engine ? engine.isBusy() : false,
      visibility: document.visibilityState,
      heap: performance.memory ? {
        used: performance.memory.usedJSHeapSize,
        total: performance.memory.totalJSHeapSize,
        limit: performance.memory.jsHeapSizeLimit,
      } : null,
      storage,
      events: globalThis.__longEvents.splice(0),
    });
  })().catch(error => reply({ error: error.message }));
  return true;
});
`);
const backgroundPath = path.join(BUILD, 'background.js');
let backgroundSource = fs.readFileSync(backgroundPath, 'utf8');
const routeAnchor = '  switch (msg.type) {';
if (!backgroundSource.includes(routeAnchor)) throw new Error('诊断消息注入点不存在');
backgroundSource = backgroundSource.replace(routeAnchor, `  switch (msg.type) {
    case 'E2E_LONG_DIAG':
      try {
        return await chrome.runtime.sendMessage({ type: 'E2E_LONG_DIAG_FROM_BG', target: 'offscreen' });
      } catch (error) { return { error: error.message }; }`);
fs.writeFileSync(backgroundPath, backgroundSource);
fs.appendFileSync(backgroundPath, `
globalThis.__longBootId = Date.now() + '-' + Math.random();
`);
for (const file of ['offscreen.js', 'background.js']) {
  execFileSync(process.execPath, ['--check', path.join(BUILD, file)]);
}

const pageHtml = `<!doctype html>
<meta charset="utf-8"><title>tab-recorder long recording</title>
<style>html,body{margin:0;background:#111;overflow:hidden}canvas{width:100vw;height:100vh}</style>
<canvas id="c" width="1920" height="1080"></canvas>
<script>
const canvas = document.getElementById('c');
const draw = canvas.getContext('2d');
const tiles = [];
for (let i = 0; i < 12; i++) {
  const tile = document.createElement('canvas');
  tile.width = 240; tile.height = 135;
  const tc = tile.getContext('2d');
  const image = tc.createImageData(tile.width, tile.height);
  let seed = 1234567 + i * 991;
  for (let p = 0; p < image.data.length; p += 4) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    image.data[p] = seed; image.data[p + 1] = seed >> 8;
    image.data[p + 2] = seed >> 16; image.data[p + 3] = 255;
  }
  tc.putImageData(image, 0, 0); tiles.push(tile);
}
function paint() {
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    draw.drawImage(tiles[(Math.random() * tiles.length) | 0], x * 480, y * 270, 480, 270);
  }
  draw.fillStyle = 'rgba(0,0,0,.7)'; draw.fillRect(30, 30, 720, 90);
  draw.fillStyle = 'white'; draw.font = '42px sans-serif';
  draw.fillText('LONG ' + new Date().toISOString(), 50, 90);
}
paint(); setInterval(paint, 100);
const ac = new AudioContext();
const oscillator = ac.createOscillator();
const gain = ac.createGain(); gain.gain.value = 0.02;
oscillator.connect(gain).connect(ac.destination); oscillator.start();
</script>`;
const server = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(pageHtml);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/long.html`;

const samples = [];
const crashEvents = [];
let closing = false;
let ctx = null;
let cdp = null;
let popup = null;
let testPage = null;
let result = { passed: false, version: manifest.version, config, durationMs: DURATION_MS };
let recordingStartedAt = 0;
let recordedBytes = 0;

function watchPage(page) {
  page.on('crash', () => {
    const event = { type: 'page-crash', url: page.url(), at: Date.now() };
    crashEvents.push(event);
    console.error('页面崩溃:', JSON.stringify(event));
  });
}

async function invokeExtension() {
  for (let attempt = 1; attempt <= 4; attempt++) {
    execFileSync('xdotool', ['key', 'ctrl+shift+e']);
    await sleep(1000);
    const granted = await popup.evaluate(() => new Promise(resolve => {
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabs[0] && tabs[0].id }, id => {
          resolve(!!id && !chrome.runtime.lastError);
        });
      });
    }));
    if (granted) return;
    console.log(`快捷键授权第 ${attempt} 次未生效，重试`);
  }
  throw new Error('activeTab 调用授权失败');
}

function readProc(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const rssKb = Number(status.match(/^VmRSS:\s+(\d+) kB$/m)?.[1] || 0);
    let pssKb = 0;
    try {
      const smaps = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
      pssKb = Number(smaps.match(/^Pss:\s+(\d+) kB$/m)?.[1] || 0);
    } catch (_) {}
    return { rssKb, pssKb };
  } catch (_) {
    return { rssKb: 0, pssKb: 0 };
  }
}

async function processSnapshot() {
  const info = await cdp.send('SystemInfo.getProcessInfo');
  const processes = info.processInfo.map(item => ({
    id: item.id, type: item.type, cpuTime: item.cpuTime, ...readProc(item.id),
  }));
  return {
    processes,
    totalRssKb: processes.reduce((sum, item) => sum + item.rssKb, 0),
    totalPssKb: processes.reduce((sum, item) => sum + item.pssKb, 0),
  };
}

async function collectSample() {
  const state = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
  const extra = await popup.evaluate(async () => {
    const stored = await chrome.storage.local.get('durableRecording');
    const contexts = chrome.runtime.getContexts ? await chrome.runtime.getContexts({}) : [];
    let diag = null;
    let diagError = '';
    try {
      diag = await Promise.race([
        chrome.runtime.sendMessage({ type: 'E2E_LONG_DIAG', target: 'offscreen' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('诊断消息超时')), 10000)),
      ]);
    } catch (error) { diagError = error.message; }
    return {
      durable: stored.durableRecording || null,
      offscreenContexts: contexts.filter(item => item.contextType === 'OFFSCREEN_DOCUMENT').length,
      diag, diagError,
    };
  });
  let bootId = '';
  const sw = ctx.serviceWorkers().find(worker => worker.url().includes('/background.js'));
  if (sw) {
    try { bootId = await sw.evaluate(() => globalThis.__longBootId || ''); } catch (_) {}
  }
  let processes = null;
  let processError = '';
  try { processes = await processSnapshot(); } catch (error) { processError = error.message; }
  return {
    at: Date.now(),
    elapsedMs: recordingStartedAt ? Math.min(Date.now(), recordingStartedAt + DURATION_MS) - recordingStartedAt : 0,
    state, ...extra, bootId, processes, processError,
    crashEvents: crashEvents.slice(),
  };
}

function recordSample(sample) {
  samples.push(sample);
  fs.appendFileSync(SAMPLES, JSON.stringify(sample) + '\n');
  const heap = sample.diag?.heap?.used || 0;
  const rssKb = sample.processes?.totalRssKb || 0;
  console.log(
    `[${hours(sample.elapsedMs)}h] 暂存=${mib(sample.state.fileSize || 0)}MiB ` +
    `JS堆=${mib(heap)}MiB 总RSS=${(rssKb / 1048576).toFixed(2)}GiB ` +
    `offscreen=${sample.offscreenContexts} boot=${sample.bootId || '未知'}`
  );
}

function seriesStats(values) {
  if (!values.length) return null;
  const points = values.filter(item => Number.isFinite(item.y) && Number.isFinite(item.x));
  if (!points.length) return null;
  const ys = points.map(item => item.y);
  const xMean = points.reduce((sum, item) => sum + item.x, 0) / points.length;
  const yMean = points.reduce((sum, item) => sum + item.y, 0) / points.length;
  let numerator = 0, denominator = 0;
  for (const item of points) {
    numerator += (item.x - xMean) * (item.y - yMean);
    denominator += (item.x - xMean) ** 2;
  }
  return {
    firstMiB: mib(ys[0]), lastMiB: mib(ys[ys.length - 1]),
    minMiB: mib(Math.min(...ys)), maxMiB: mib(Math.max(...ys)),
    slopeMiBPerHour: denominator ? Number((numerator / denominator / 1048576).toFixed(2)) : 0,
  };
}

function memorySummary() {
  return {
    offscreenHeap: seriesStats(samples.map(item => ({
      x: item.elapsedMs / 3600000, y: item.diag?.heap?.used,
    }))),
    browserTotalRss: seriesStats(samples.map(item => ({
      x: item.elapsedMs / 3600000, y: (item.processes?.totalRssKb || 0) * 1024,
    }))),
    browserTotalPss: seriesStats(samples.map(item => ({
      x: item.elapsedMs / 3600000, y: (item.processes?.totalPssKb || 0) * 1024,
    }))),
  };
}

async function saveReport(extra = {}) {
  const report = {
    ...result,
    browser: ctx?.browser()?.version() || '',
    actualRecordingMs: recordingStartedAt ? Math.min(Date.now(), recordingStartedAt + DURATION_MS) - recordingStartedAt : 0,
    recordedBytes,
    sampleCount: samples.length,
    serviceWorkerBoots: [...new Set(samples.map(item => item.bootId).filter(Boolean))].length,
    crashEvents,
    memory: memorySummary(),
    lastSample: samples[samples.length - 1] || null,
    ...extra,
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
}

function probeMedia(file) {
  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration,size:stream=codec_name,codec_type',
    '-of', 'json', file,
  ], { encoding: 'utf8' });
  if (probe.error) return { available: false, error: probe.error.message };
  const output = { available: true, status: probe.status, stderr: probe.stderr.trim(), seeks: [] };
  if (probe.status === 0) {
    const info = JSON.parse(probe.stdout);
    output.info = info;
    const duration = Number(info.format?.duration || 0);
    for (const second of [0, Math.max(0, duration / 2 - 1), Math.max(0, duration - 3)]) {
      const decode = spawnSync('ffmpeg', [
        '-v', 'error', '-ss', String(second), '-i', file, '-t', '2', '-f', 'null', '-',
      ], { encoding: 'utf8', timeout: 120000 });
      output.seeks.push({ second, status: decode.status, stderr: decode.stderr.trim(), error: decode.error?.message || '' });
    }
  }
  return output;
}

try {
  console.log(`启动长录制：${(DURATION_MS / 3600000).toFixed(2)} 小时，${config.width}x${config.height}@${config.fps}，${Number(config.quality) / 1000000} Mbps`);
  ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: config.width, height: config.height },
    acceptDownloads: true,
    downloadsPath: DOWNLOADS,
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
    args: [
      `--disable-extensions-except=${BUILD}`, `--load-extension=${BUILD}`,
      '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check',
    ],
  });
  ctx.browser().on('disconnected', () => {
    if (closing) return;
    const event = { type: 'browser-disconnected', at: Date.now() };
    crashEvents.push(event);
    console.error('浏览器断开:', JSON.stringify(event));
  });
  cdp = await ctx.browser().newBrowserCDPSession();
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  testPage = await ctx.newPage(); watchPage(testPage);
  await testPage.goto(pageUrl);
  popup = await ctx.newPage(); watchPage(popup);
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await testPage.bringToFront();
  await sleep(500);
  await invokeExtension();
  try { execFileSync('xdotool', ['key', 'Escape']); } catch (_) {}
  await sleep(500);

  await testPage.bringToFront();
  const started = await popup.evaluate(options => chrome.runtime.sendMessage({
    type: 'START_RECORDING', source: 'tab', ...options,
  }), config);
  if (!started || started.error) throw new Error(`启动失败：${JSON.stringify(started)}`);
  const initial = await collectSample();
  if (initial.state.status !== 'recording') throw new Error(`未进入录制态：${JSON.stringify(initial.state)}`);
  recordingStartedAt = initial.state.startTime || Date.now();
  recordSample(await collectSample());

  let stagnantSamples = 0;
  while (Date.now() - recordingStartedAt < DURATION_MS) {
    const remaining = DURATION_MS - (Date.now() - recordingStartedAt);
    await sleep(Math.min(SAMPLE_MS, Math.max(1, remaining)));
    const sample = await collectSample();
    recordSample(sample);
    recordedBytes = Math.max(recordedBytes, sample.state.fileSize || 0, sample.durable?.bytes || 0);
    if (crashEvents.length) throw new Error(`检测到崩溃：${JSON.stringify(crashEvents)}`);
    if (sample.state.status !== 'recording' || sample.state.processing) {
      throw new Error(`录制提前退出：${JSON.stringify(sample.state)}`);
    }
    if (sample.offscreenContexts !== 1 || sample.diag?.recording !== true) {
      throw new Error(`offscreen 录制上下文异常：${JSON.stringify({
        offscreenContexts: sample.offscreenContexts, diag: sample.diag, diagError: sample.diagError,
      })}`);
    }
    const previous = samples.length > 1 ? samples[samples.length - 2].state.fileSize || 0 : 0;
    stagnantSamples = (sample.state.fileSize || 0) > previous ? 0 : stagnantSamples + 1;
    if (sample.elapsedMs > 120000 && stagnantSamples >= 3) {
      throw new Error(`暂存连续 ${stagnantSamples} 个采样周期未增长：${sample.state.fileSize}`);
    }
    if (sample.diag?.events?.length) throw new Error(`offscreen 异常：${JSON.stringify(sample.diag.events)}`);
  }

  console.log('到达目标时长，走生产停止/修复/下载链…');
  const stopped = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }));
  if (stopped?.error) throw new Error(`停止失败：${JSON.stringify(stopped)}`);
  const saveDeadline = Date.now() + SAVE_TIMEOUT_MS;
  let finalState;
  for (;;) {
    const sample = await collectSample();
    recordSample(sample);
    finalState = sample.state;
    recordedBytes = Math.max(recordedBytes, sample.durable?.bytes || 0, sample.state.fileSize || 0);
    if (finalState.savePhase === 'error') throw new Error(`保存失败：${finalState.saveError}`);
    if (finalState.savePhase === 'complete' && !finalState.processing) break;
    if (Date.now() > saveDeadline) throw new Error(`保存超时：${JSON.stringify(finalState)}`);
    await sleep(Math.min(SAMPLE_MS, 15000));
  }

  const files = fs.readdirSync(DOWNLOADS).filter(name => !name.endsWith('.crdownload'));
  if (files.length !== 1) throw new Error(`下载文件数量异常：${JSON.stringify(files)}`);
  const file = path.join(DOWNLOADS, files[0]);
  const size = fs.statSync(file).size;
  if (size < recordedBytes) throw new Error(`下载文件小于已确认暂存：${size} < ${recordedBytes}`);
  const media = probeMedia(file);
  const duration = Number(media.info?.format?.duration || 0);
  const expectedSeconds = DURATION_MS / 1000;
  const seeks = media.seeks || [];
  const decodeErrors = seeks.flatMap(item => item.stderr.split('\n').filter(line =>
    line.trim() && !line.includes('Application provided invalid, non monotonically increasing dts to muxer')));
  const mediaOk = media.available && media.status === 0 && media.info?.streams?.some(s => s.codec_type === 'video')
    && media.info?.streams?.some(s => s.codec_type === 'audio')
    && duration >= expectedSeconds - 10 && duration <= expectedSeconds + 30
    && seeks.every(item => item.status === 0) && decodeErrors.length === 0;
  result = {
    ...result, passed: mediaOk && crashEvents.length === 0,
    output: { file, size, media, finalState },
  };
  if (!mediaOk) throw new Error(`媒体校验失败：${JSON.stringify(media)}`);
  console.log(`通过：${(size / 1073741824).toFixed(2)} GiB，时长 ${duration.toFixed(1)}s，报告 ${REPORT}`);
} catch (error) {
  result = { ...result, error: error.stack || String(error) };
  console.error('长录制测试失败:', error.stack || error);
  try {
    const sample = await collectSample();
    recordSample(sample);
  } catch (diagError) {
    console.error('失败现场诊断也不可用:', diagError.message);
  }
} finally {
  closing = true;
  await saveReport();
  if (ctx) {
    try { await ctx.close(); } catch (_) {}
  }
  server.close();
}

process.exitCode = result.passed ? 0 : 1;
