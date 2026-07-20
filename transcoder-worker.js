/**
 * transcoder-worker.js — ffmpeg.wasm 的 Web Worker 宿主
 *
 * 为什么要有这个文件？
 *   @ffmpeg/core 的 core.callMain() 是同步阻塞调用。原先它在 offscreen/recorder
 *   主线程直接跑，几十秒转码期间页面完全卡死，chrome.runtime.onMessage 无法响应。
 *   把 callMain 搬到 worker 里，被阻塞的就是这条 worker 线程，主线程保持空闲。
 *
 * Worker 内没有 chrome.* API，所以 ffmpeg-core.js 的 URL 由主线程
 * （transcoder.js）算好后随消息发进来；本 worker 负责加载 + 执行。
 *
 * 协议（与 transcoder.js 约定）：
 *   主线程 → worker：{ id, coreURL, blob, args }
 *     - id：本次转码的唯一标识，用于匹配回调
 *     - coreURL：ffmpeg-core.js 的完整 URL（worker 无 chrome.* API）
 *     - blob：输入文件
 *     - args：转码参数，**不含 -i 输入名和输出名**（worker 用唯一名自动拼）
 *             例如 ['-c:v','libx264','-preset','fast','-crf','23','-c:a','aac','-movflags','+faststart']
 *   worker → 主线程：
 *     { id, type: 'progress', progress: 0..1 }      转码进度（本次暂不接 UI）
 *     { id, type: 'done', out: Uint8Array }         成功，out 为输出文件
 *     { id, type: 'error', message: string }        失败
 *
 * worker 内部单例 core 实例：第一次消息触发加载，后续复用，避免重复加载 30MB wasm。
 * 主线程要终止时调 worker.terminate()，下次会重新 new Worker，core 自然重建。
 */

'use strict';

let corePromise = null;   // 单例 Promise，跨多次转码复用同一 core 实例

/** 加载 ffmpeg-core（懒加载，主线程传 coreURL）。失败 reject。 */
function loadCore(coreURL) {
  if (corePromise) return corePromise;
  corePromise = (async () => {
    try {
      // Worker 内不能用 <script>，用 importScripts 加载 UMD 入口
      importScripts(coreURL);
    } catch (e) {
      corePromise = null;   // 允许下次重试
      throw new Error('ffmpeg-core.js 加载失败：' + (e && e.message || e));
    }

    // @ffmpeg/core 0.12 的导出名因版本而异，全部兜底
    const FF = self.FFmpegWASM || self.FFmpegCore || self.createFFmpegCore || self.FFmpeg;
    if (!FF) {
      corePromise = null;
      throw new Error('未找到 ffmpeg-core 导出，请确认 @ffmpeg/core 版本');
    }

    // coreURL 形如 chrome-extension://<id>/lib/ffmpeg/ffmpeg-core.js
    // locateFile 需要目录路径（用来找 .wasm）
    const base = coreURL.replace(/[^/]*$/, '');
    const factory = FF.createFFmpegCore || FF;
    const core = await factory({
      mainName: 'main',
      locateFile: (path) => base + path,
    });

    // 接 core 的进度回调（本次暂不接 UI，留作未来扩展）
    if (typeof core.setProgress === 'function') {
      core.setProgress(({ ratio }) => {
        // ratio 可能是 Infinity/NaN（ffmpeg 启动初期），过滤掉
        if (Number.isFinite(ratio)) {
          postMessage({ type: 'progress', progress: Math.max(0, Math.min(1, ratio)) });
        }
      });
    }
    return core;
  })();
  return corePromise;
}

/** 主消息处理 */
self.onmessage = async (e) => {
  const { id, coreURL, blob, args } = e.data;
  if (!id || !coreURL || !args) {
    postMessage({ id, type: 'error', message: '消息缺少必要字段 id/coreURL/args' });
    return;
  }

  try {
    const core = await loadCore(coreURL);

    // 写入虚拟 FS（每次用唯一名，避免并发或残留冲突）
    const inName = 'in_' + id;
    const outName = 'out_' + id + '.mp4';
    const buf = new Uint8Array(await blob.arrayBuffer());
    core.FS.writeFile(inName, buf);

    // callMain 同步阻塞——但这里在 worker，阻塞的是本 worker 线程
    // 完整命令：-nostdin -y -i <inName> ...args <outName>
    // Emscripten 正常退出会抛 exit(0) 异常，需要捕获并当成功
    const fullArgs = ['-nostdin', '-y', '-i', inName, ...args, outName];
    let exitCode = 0;
    try {
      const code = core.callMain
        ? core.callMain(fullArgs)
        : core.exec(fullArgs);
      if (typeof code === 'number') exitCode = code;
    } catch (err) {
      // exit(0) 抛异常是 Emscripten 的正常行为；非 0 退出才算真错
      const msg = String(err && err.message || err);
      if (!/exit\(0\)|PROXY_TO_PTHREAD/.test(msg)) {
        // 真错：清理后上报
        try { core.FS.unlink(inName); } catch (_) {}
        try { core.FS.unlink(outName); } catch (_) {}
        postMessage({ id, type: 'error', message: 'ffmpeg 异常：' + msg });
        return;
      }
      exitCode = 0;
    }

    if (exitCode !== 0) {
      try { core.FS.unlink(inName); } catch (_) {}
      try { core.FS.unlink(outName); } catch (_) {}
      postMessage({ id, type: 'error', message: 'ffmpeg 退出码 ' + exitCode });
      return;
    }

    // 读取输出 + 清理 FS（避免内存累积导致后续转码卡 99%）
    let out;
    try {
      out = core.FS.readFile(outName);
    } catch (e) {
      postMessage({ id, type: 'error', message: '读取输出失败：' + (e && e.message || e) });
      return;
    }
    try { core.FS.unlink(inName); } catch (_) {}
    try { core.FS.unlink(outName); } catch (_) {}

    postMessage({ id, type: 'done', out });
  } catch (err) {
    // 加载阶段失败等
    postMessage({ id, type: 'error', message: String(err && err.message || err) });
  }
};
