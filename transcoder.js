/**
 * transcoder.js — WebM → MP4 转码（基于 ffmpeg.wasm）
 *
 * 设计目标：
 *   - 懒加载：只有用户选择「MP4」输出时才加载 ffmpeg，平时零开销。
 *   - 完全离线：从扩展内 lib/ffmpeg/ 加载 core wasm，不联网。
 *   - 失败优雅降级：转码出错时调用方回退为 WebM。
 *
 * 安装 ffmpeg.wasm（见 README「可选：启用 MP4 转码」）：
 *   将以下文件放入 lib/ffmpeg/：
 *     ffmpeg-core.js          (UMD 入口，约 100KB)
 *     ffmpeg-core.wasm        (约 30MB)
 *     ffmpeg-core.worker.js   (约 100KB)
 *   来源：@ffmpeg/core@0.12.x（解压 node_modules/@ffmpeg/core/dist/）
 *
 * 命令：-i in.webm -c:v libx264 -preset fast -crf 23 -c:a aac -movflags +faststart out.mp4
 *
 * 暴露全局：webmToMp4(blob) -> Promise<Blob>
 */

(function (G) {
  'use strict';

  let corePromise = null;   // 单例，避免重复加载

  /** 懒加载 ffmpeg-core，返回 FFmpegCore 实例。 */
  function loadFFmpeg() {
    if (corePromise) return corePromise;
    corePromise = (async () => {
      const base = chrome.runtime.getURL('lib/ffmpeg/');
      // 动态 import UMD 入口。core 的 mainFileName/options 由具体版本决定；
      // 用 importScripts 兜底，兼容 @ffmpeg/core 0.12 的导出形式。
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = base + 'ffmpeg-core.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('ffmpeg-core.js 加载失败，请按 README 放入 lib/ffmpeg/'));
        document.head.appendChild(s);
      });

      const FF = G.FFmpegWASM || G.FFmpegCore || G.createFFmpegCore || G.FFmpeg;
      if (!FF) throw new Error('未找到 ffmpeg-core 导出，请确认版本');

      // @ffmpeg/core 0.12：导出 createFFmpegCore 工厂
      const factory = FF.createFFmpegCore || FF;
      const core = await factory({
        mainName: 'main',
        locateFile: (path) => base + path,
      });
      return core;
    })();
    return corePromise;
  }

  /** 把 WebM Blob 转成 MP4 Blob。失败抛错。 */
  async function webmToMp4(blob) {
    const core = await loadFFmpeg();

    const inName = 'in.webm';
    const outName = 'out.mp4';

    // 写入虚拟 FS
    const buf = new Uint8Array(await blob.arrayBuffer());
    core.FS.writeFile(inName, buf);

    // 运行转码
    const code = core.callMain
      ? core.callMain(['-i', inName, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
                       '-c:a', 'aac', '-movflags', '+faststart', outName])
      : core.exec(['-i', inName, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
                   '-c:a', 'aac', '-movflags', '+faststart', outName]);
    // exec 返回码或无返回；callMain 返回退出码（0 = 成功）
    if (typeof code === 'number' && code !== 0) throw new Error('ffmpeg 退出码 ' + code);

    const out = core.FS.readFile(outName);
    core.FS.unlink(inName);
    try { core.FS.unlink(outName); } catch (_) {}

    return new Blob([out], { type: 'video/mp4' });
  }

  /**
   * 把原生 MediaRecorder 录的 MP4 重包装为 faststart（moov atom 搬到开头）。
   * 用 -c copy 不重编码，只搬 moov，速度比转码快一个数量级。
   * 失败抛错（调用方可回退到原始 blob，文件能播放但不能拖动进度条）。
   *
   * 为什么需要：Chrome MediaRecorder 录的 MP4 通常把 moov 写在文件末尾，
   * 播放器必须等整个文件下载完才能 seek。faststart 把 moov 搬到开头，
   * 进度条才能正常拖动。
   */
  async function mp4Faststart(blob) {
    const core = await loadFFmpeg();

    const inName = 'in.mp4';
    const outName = 'out.mp4';

    const buf = new Uint8Array(await blob.arrayBuffer());
    core.FS.writeFile(inName, buf);

    // -c copy：流复制，不重编码（H.264/AAC 原样保留）
    // -movflags +faststart：把 moov atom 从末尾搬到开头
    const code = core.callMain
      ? core.callMain(['-i', inName, '-c', 'copy', '-movflags', '+faststart', outName])
      : core.exec(['-i', inName, '-c', 'copy', '-movflags', '+faststart', outName]);
    if (typeof code === 'number' && code !== 0) throw new Error('ffmpeg 退出码 ' + code);

    const out = core.FS.readFile(outName);
    core.FS.unlink(inName);
    try { core.FS.unlink(outName); } catch (_) {}

    return new Blob([out], { type: 'video/mp4' });
  }

  G.webmToMp4 = webmToMp4;
  G.mp4Faststart = mp4Faststart;
})(self);
