/**
 * transcoder.js — ffmpeg.wasm 转码主线程入口（worker 化版）
 *
 * 设计目标：
 *   - 懒加载：只有用户选择「MP4」输出时才加载 ffmpeg，平时零开销。
 *   - 完全离线：从扩展内 lib/ffmpeg/ 加载 core wasm，不联网。
 *   - 失败优雅降级：转码出错时调用方回退为 WebM。
 *   - **主线程不阻塞**（v2 关键改进）：ffmpeg 跑在独立 Web Worker 里，
 *     转码几十秒期间 offscreen/recorder 主线程保持空闲，chrome.runtime.
 *     onMessage 正常响应。
 *
 * 架构：
 *   transcoder.js（主线程，本文件）
 *     ↓ postMessage({ id, coreURL, blob, args })
 *   transcoder-worker.js（worker，加载 ffmpeg-core.js 并跑 callMain）
 *     ↑ postMessage({ id, type: 'done'|'error'|'progress', ... })
 *
 * 超时保护：每个转码任务挂 setTimeout，到点 worker.terminate() + reject。
 *   默认超时随输入大小缩放（防固定上限误杀长视频）：
 *   webmToMp4 = max(5min, 3s/MB)，mp4Faststart = max(1min, 0.2s/MB)，
 *   均可用 opts.timeoutMs 覆盖。terminate 后下次调用自动重建 worker。
 *
 * 安装 ffmpeg.wasm（见 README「可选：启用 MP4 输出」）：
 *   将以下文件放入 lib/ffmpeg/：
 *     ffmpeg-core.js          (UMD 入口，约 100KB)
 *     ffmpeg-core.wasm        (约 30MB)
 *   来源：@ffmpeg/core@0.12.x（解压 node_modules/@ffmpeg/core/dist/）
 *   注意：ffmpeg-core.worker.js 不需要——那是 @ffmpeg/core-mt（多线程版）
 *   的文件；0.12 单线程版 dist 里不存在，经核实 ffmpeg-core.js 全文无引用。
 *
 * 暴露全局：
 *   webmToMp4(blob, opts?) -> Promise<Blob>   WebM 转 MP4（重编码）
 *   mp4Faststart(blob, opts?) -> Promise<Blob> MP4 重包装（流复制，搬 moov）
 */

(function (G) {
  'use strict';

  // 本文件跑在 offscreen document / recorder.html，二者都是 chrome-extension:// 页面，
  // 所以 worker 继承扩展源、worker 内 importScripts 内核也是同源加载 —— 无需
  // web_accessible_resources（WAR 只用于把资源暴露给扩展源之外的上下文，
  // 加上反而让任意网页可探测本扩展是否安装）。
  const CORE_URL = chrome.runtime.getURL('lib/ffmpeg/ffmpeg-core.js');
  const WORKER_URL = chrome.runtime.getURL('transcoder-worker.js');

  let worker = null;
  let nextId = 1;
  const pending = new Map();   // id → { resolve, reject, timer, onProgress }

  /* ── Worker 生命周期 ──────────────────────────────── */

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(WORKER_URL);
    worker.onmessage = (e) => {
      const { id, type } = e.data || {};
      if (!id) return;
      const task = pending.get(id);
      if (!task) return;
      if (type === 'progress') {
        if (task.onProgress) task.onProgress(e.data.progress);
      } else if (type === 'done') {
        clearTimeout(task.timer);
        pending.delete(id);
        task.resolve(new Blob([e.data.out], { type: 'video/mp4' }));
      } else if (type === 'error') {
        clearTimeout(task.timer);
        pending.delete(id);
        task.reject(new Error(e.data.message || 'ffmpeg 转码失败'));
      }
    };
    worker.onerror = (e) => {
      // worker 级别的错误（加载失败、wasm OOM 崩溃等），所有 pending 任务全部 reject
      const w = worker;
      worker = null;                        // 先置空，下次 ensureWorker 会重建
      try { w && w.terminate(); } catch (_) {}   // 杀掉可能还活着的 worker，防泄漏
      const err = new Error('ffmpeg worker 错误：' + (e.message || '未知'));
      for (const [id, task] of pending) {
        clearTimeout(task.timer);
        task.reject(err);
      }
      pending.clear();
    };
    return worker;
  }

  /** terminate 并清空（超时或外部调用）。下次转码自动重建。 */
  function killWorker() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    for (const [id, task] of pending) {
      clearTimeout(task.timer);
      task.reject(new Error('ffmpeg worker 已终止'));
    }
    pending.clear();
  }

  /* ── 通用转码入口 ─────────────────────────────────── */

  /**
   * 按输入大小缩放超时：固定 5 分钟对长视频必然误杀（wasm 里 x264 常跑不到
   * 实时速度），超时本应只是防死锁的兜底。
   * @param baseMs  保底超时
   * @param perMbMs 每 MB 输入追加的毫秒数
   */
  function scaledTimeout(baseMs, perMbMs, blob) {
    const mb = blob.size / 1048576;
    return Math.max(baseMs, Math.ceil(mb * perMbMs));
  }

  function transcode(blob, args, timeoutMs, onProgress) {
    return new Promise((resolve, reject) => {
      let id;
      try {
        ensureWorker();
        id = nextId++;
      } catch (e) {
        reject(new Error('创建 ffmpeg worker 失败：' + (e && e.message || e)));
        return;
      }

      const timer = setTimeout(() => {
        // 超时：terminate worker（杀掉正在跑的 ffmpeg），重建下次可用
        pending.delete(id);
        killWorker();
        reject(new Error('ffmpeg 转码超时（>' + Math.round(timeoutMs / 1000) +
          's）。视频可能过长，可改用 WebM 输出或缩短录制时长'));
      }, timeoutMs);

      pending.set(id, { resolve, reject, timer, onProgress });

      try {
        worker.postMessage({ id, coreURL: CORE_URL, blob, args });
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error('向 ffmpeg worker 发消息失败：' + (e && e.message || e)));
      }
    });
  }

  /* ── 对外 API ─────────────────────────────────────── */

  /**
   * WebM → MP4（H.264/AAC 重编码，+faststart 让 moov 在开头可拖动）。失败抛错。
   * opts.timeoutMs：默认 max(5min, 3s/MB)。8Mbps 约 1MB/s，3s/MB ≈ 3 倍实时余量，
   *   长视频（如 1h ≈ 3.6GB）超时放宽到 ~3 小时，不再被 5 分钟硬上限误杀。
   * opts.onProgress(0..1)：转码进度回调（可选）。
   */
  function webmToMp4(blob, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || scaledTimeout(5 * 60 * 1000, 3000, blob);
    const args = [
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac',
      '-movflags', '+faststart',
    ];
    return transcode(blob, args, timeoutMs, opts && opts.onProgress);
  }

  /**
   * 原生 MediaRecorder 录的 MP4 → faststart（moov atom 搬到开头）。
   * -c copy 流复制，不重编码，速度比转码快一个数量级。失败抛错。
   * opts.timeoutMs：默认 max(1min, 0.2s/MB)（流复制主要开销是内存读写）。
   *
   * 为什么需要：Chrome MediaRecorder 录的 MP4 把 moov 写在末尾，
   * 播放器必须等整个文件下载完才能 seek。faststart 把 moov 搬到开头，
   * 进度条才能正常拖动。
   */
  function mp4Faststart(blob, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || scaledTimeout(60 * 1000, 200, blob);
    const args = ['-c', 'copy', '-movflags', '+faststart'];
    return transcode(blob, args, timeoutMs, opts && opts.onProgress);
  }

  G.webmToMp4 = webmToMp4;
  G.mp4Faststart = mp4Faststart;
})(self);
