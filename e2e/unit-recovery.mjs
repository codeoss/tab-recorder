import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.self = globalThis;
let storedFile = null;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { getDirectory: async () => ({
  async getFileHandle() { return { getFile: async () => storedFile }; },
}) } } });
globalThis.mp4FaststartJs = async blob => blob;
globalThis.mp4Faststart = async blob => blob;
let webmConfirmed = -1;
globalThis.fixWebMRecoveryBlob = async (blob, _duration, bytes) => { webmConfirmed = bytes; return blob; };
globalThis.webmToMp4 = async blob => blob;
await import(pathToFileURL(path.join(ROOT, 'recovery.js')).href);

let failed = 0;
function ok(name, condition, extra = '') {
  console.log(`${condition ? '  ✅' : '  ❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!condition) failed++;
}
function box(type, payload = new Uint8Array(4)) {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(payload, 8);
  return out;
}
function meta(bytes, mp4 = true) {
  return {
    id: 'r', fileName: 'tab-record-r.media', bytes, startedAt: 1700000000000,
    mediaTimeMs: 1000, recordedIsMp4: mp4, outputFormat: mp4 ? 'mp4' : 'webm', mime: mp4 ? 'video/mp4' : 'video/webm',
  };
}

{
  storedFile = new File([box('ftyp'), box('moov')], 'header-only');
  const error = await recoverDurableBlob(meta(storedFile.size)).then(() => '', value => value.message);
  ok('只有 MP4 头时拒绝伪造恢复成功', error.includes('没有可恢复的媒体数据'));
}

{
  const prefix = new Blob([box('ftyp'), box('moov'), box('moof'), box('mdat', new Uint8Array(20))]);
  const truncated = new Uint8Array(16);
  new DataView(truncated.buffer).setUint32(0, 32);
  truncated.set(new TextEncoder().encode('mdat'), 4);
  storedFile = new File([prefix, truncated], 'truncated-tail');
  const recovered = await recoverDurableBlob(meta(storedFile.size));
  ok('MP4 只保留完整 moof/mdat 前缀', recovered.blob.size === prefix.size);
}

{
  storedFile = new File([box('ftyp'), box('moov'), box('moof'), box('mdat')], 'complete');
  const recovered = await recoverDurableBlob(meta(storedFile.size));
  ok('完整 MP4 分片原样进入 faststart', recovered.blob.size === storedFile.size && recovered.filename.endsWith('.mp4'));
}

{
  storedFile = new File(['already-flushed'], 'unconfirmed');
  const error = await recoverDurableBlob(meta(0, false)).then(() => '', value => value.message);
  ok('确认点为 0 时不得使用整个 OPFS 文件', error.includes('没有已确认') && webmConfirmed === -1);
}

{
  const prefix = new Blob([box('ftyp'), box('moov'), box('moof'), box('mdat', new Uint8Array(20))]);
  storedFile = new File([prefix, box('moof')], 'orphan-moof');
  const recovered = await recoverDurableBlob(meta(storedFile.size));
  ok('末尾孤儿 moof 不得进入恢复产物', recovered.blob.size === prefix.size);
}

console.log(failed ? `\n${failed} 项失败 ❌` : '\n恢复模块测试全部通过 🎉');
process.exit(failed ? 1 : 0);
