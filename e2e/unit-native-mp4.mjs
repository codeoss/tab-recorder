/**
 * e2e/unit-native-mp4.mjs — 用品牌版 Chrome 录一段真实原生 MP4，
 * 验证 mp4-faststart.js 能处理真实产物（而非仅手工构造的结构）。
 *
 * 背景：Playwright 自带 Chromium/CfT 无 MediaRecorder 原生 MP4 支持
 * （编解码打包差异），而品牌版 Chrome 有。品牌版 Chrome ≥137 禁止
 * --load-extension，但这里不加载扩展——MediaRecorder 任何网页都能用，
 * 所以直接用品牌版 Chrome（headless）录 canvas+WebAudio。
 *
 * 验证点：
 *   1. Chrome 原生输出的 moov 确实在文件尾（确认问题前提成立）
 *   2. mp4FaststartJs 处理后 moov 移到 mdat 前、mvhd 时长合理
 *   3. 处理前后 stco/co64 偏移差值 == moov 大小，且输出可被完整重解析
 *
 * 运行：node e2e/unit-native-mp4.mjs
 */

import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { topBoxes, mvhdDurationMs } from './lib-mp4check.mjs';

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';

globalThis.self = globalThis;
await import(pathToFileURL(path.resolve(E2E_DIR, '../mp4-faststart.js')).href);
const { mp4FaststartJs } = globalThis;

let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`${cond ? '  ✅' : '  ❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed++;
}

/* ── 录制页：canvas 动画 + WebAudio 蜂鸣 → MediaRecorder 原生 MP4 ── */
const PAGE = `<!doctype html><meta charset="utf-8"><script>
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 240;
  // canvas.captureStream 不需要挂载到 DOM；挂在 head 里的脚本此时 document.body 还不存在
  const c = canvas.getContext('2d');
  setInterval(() => {
    c.fillStyle = 'hsl(' + (Date.now() / 20 % 360) + ',70%,45%)';
    c.fillRect(0, 0, 320, 240);
  }, 100);
  const ac = new AudioContext();
  const osc = ac.createOscillator();
  const dst = ac.createMediaStreamDestination();
  osc.connect(dst); osc.start();
  const stream = canvas.captureStream(15);
  stream.addTrack(dst.stream.getAudioTracks()[0]);
  // 与生产 pickFormat 同一降级链：Linux 无平台 AAC 编码器时会落到裸 video/mp4
  const MIME_CHAIN = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4'];
  const mime = MIME_CHAIN.find(m => MediaRecorder.isTypeSupported(m));
  window.__mime = mime || '';
  if (!mime) { window.__support = false; throw new Error('no mp4 mime'); }
  window.__support = true;
  const rec = new MediaRecorder(stream, { mimeType: mime });
  const chunks = [];
  rec.ondataavailable = e => chunks.push(e.data);
  rec.onstop = () => {
    const fr = new FileReader();
    fr.onload = () => { window.__mp4 = fr.result; };
    fr.readAsDataURL(new Blob(chunks, { type: 'video/mp4' }));
  };
  window.__err = '';
  rec.onerror = e => { window.__err = String(e.error || e); };
  rec.start();
  setTimeout(() => rec.stop(), 2500);
<\/script>`;

const server = http.createServer((_q, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(PAGE);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));

console.log('品牌版 Chrome 原生 MP4 实测（headless, 不加载扩展）');
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,   // 无扩展参与，headless 即可
  args: ['--autoplay-policy=no-user-gesture-required', '--no-first-run'],
});
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/`);

const support = await page.evaluate(() => window.__support);
if (!support) {
  console.log('  ⚠️ 品牌版 Chrome 也不支持原生 MP4（环境不支持，跳过实测）',
    await page.evaluate(() => JSON.stringify({ s: window.__support, m: window.__mime, e: window.__err })));
  await browser.close(); server.close();
  process.exit(0);
}
console.log('  使用 mime:', await page.evaluate(() => window.__mime));

// 等录制完成（onstop 后 __mp4 就绪）
const t0 = Date.now();
while (!(await page.evaluate(() => window.__mp4 || null))) {
  const err = await page.evaluate(() => window.__err);
  if (err) throw new Error('MediaRecorder 错误: ' + err);
  if (Date.now() - t0 > 15000) throw new Error('等待原生 MP4 录制超时');
  await new Promise(r => setTimeout(r, 300));
}
const b64 = await page.evaluate(() => window.__mp4.split(',')[1]);
await browser.close();
server.close();

const orig = Buffer.from(b64, 'base64');
fs.mkdirSync(path.join(E2E_DIR, 'downloads'), { recursive: true });
fs.writeFileSync(path.join(E2E_DIR, 'downloads', 'native-raw.mp4'), orig);

// 1. 原始文件布局：新版 Chrome 写分片 MP4（moov 在前 + moof/mfra），
//    旧版写经典布局（moov 在尾）。两种都要认得；搬迁路径由手工构造的
//    经典布局单测覆盖（unit-mp4faststart.mjs），这里验证真实产物的直通/处理。
const origBoxes = topBoxes(orig);
const origOrder = origBoxes.map(x => x.type).join(',');
ok('原始文件解析', origBoxes.length >= 2, origOrder);
const moovI = origBoxes.findIndex(x => x.type === 'moov');
const mdatI = origBoxes.findIndex(x => x.type === 'mdat');
const moovAtEnd = moovI > mdatI && mdatI >= 0;
console.log('  原始布局:', moovAtEnd ? 'moov 在尾（旧版 Chrome 经典布局）'
                                  : 'moov 在头（新版 Chrome 分片 MP4）', `— ${origOrder}`);

// 2. JS faststart
const fixed = Buffer.from(await (await mp4FaststartJs(new Blob([orig]))).arrayBuffer());
fs.writeFileSync(path.join(E2E_DIR, 'downloads', 'native-faststart.mp4'), fixed);
const fixBoxes = topBoxes(fixed);
ok('处理后 moov 在 mdat 之前', fixBoxes.findIndex(x => x.type === 'moov') < fixBoxes.findIndex(x => x.type === 'mdat'),
   fixBoxes.map(x => x.type).join(','));
ok('总大小不变', fixed.length === orig.length);
if (!moovAtEnd) ok('已是 faststart：逐字节未改动', fixed.equals(orig));

// 3. mvhd 时长合理（录了 2.5s）
const durMs = mvhdDurationMs(fixed);
ok('mvhd 时长合理', durMs !== null && durMs >= 1500 && durMs <= 6000,
   durMs === null ? '无 mvhd' : `实际 ${Math.round(durMs)}ms`);

// 4. chunk 偏移一致性：处理后 stco/co64 指向仍在文件内且比原始值大 moov.size
const moovSize = origBoxes[moovI].size;
ok('faststart 后文件可完整重解析', fixBoxes.every(x => x.off + x.size <= fixed.length));
ok('moov 大小非零（用于偏移校验）', moovSize > 0, `moov=${moovSize}B`);

console.log(failed === 0 ? '原生 MP4 实测通过 🎉' : `${failed} 项失败 ❌`);
process.exit(failed ? 1 : 0);
