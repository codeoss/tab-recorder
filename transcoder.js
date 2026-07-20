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
 *   webmToMp4 默认 5 分钟，mp4Faststart 默认 1 分钟（流复制应该很快）。
 *   terminate 后下次调用自动重建 worker。
 *
 * 安装 ffmpeg.wasm（见 README「可选：启用 MP4 转码」）：
 *   将以下文件放入 lib/ffmpeg/：
 *     ffmpeg-core.js          (UMD 入口，约 100KB)
 *     ffmpeg-core.wasm        (约 30MB)
 *   来源：@ffmpeg/core@0.12.x（解压 node_modules/@ffmpeg/core/dist/）
 *   注意：worker 化后不再需要 ffmpeg-core.worker.js（那是 wrapper 版的文件）。
 *
 * 暴露全局：
 *   webmToMp4(blob, opts?) -> Promise<Blob>   WebM 转 MP4（重编码）
 *   mp4Faststart(blob, opts?) -> Promise<Blob> MP4 重包装（流复制，搬 moov）
 */

(function (G) {
  'use strict';

  const CORE_URL = chrome.runtime.getURL('lib/ffmpeg/ffmpeg-core.js');
  const WORKER_URL = chrome.runtime.getURL('transcoder-worker.js');

  let worker = null;
  let nextId = 1;
  const pending = new Map();   // id → { resolve, reject, timer }

  /* ── Worker 生命周期 ──────────────────────────────── */

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(WORKER_URL);
    worker.onmessage = (e) => {
      const { id, type } = e.data || {};
      if (!id) return;   // progress 等无 id 的消息忽略（本次不接 UI）
      const task = pending.get(id);
      if (!task) return;
      if (type === 'done') {
        clearTimeout(task.timer);
        pending.delete(id);
        task.resolve(new Blob([e.data.out], { type: 'video/mp4' }));
      } else if (type === 'error') {
        clearTimeout(task.timer);
        pending.delete(id);
        task.reject(new Error(e.data.message || 'ffmpeg 转码失败'));
      }
      // type === 'progress' 暂不处理
    };
    worker.onerror = (e) => {
      // worker 级别的错误（加载失败等），所有 pending 任务全部 reject
      const err = new Error('ffmpeg worker 错误：' + (e.message || '未知'));
      for (const [id, task] of pending) {
        clearTimeout(task.timer);
        task.reject(err);
      }
      pending.clear();
      worker = null;   // 下次 ensureWorker 会重建
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

  function transcode(blob, args, timeoutMs) {
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
        reject(new Error('ffmpeg 转码超时（>' + (timeoutMs / 1000) + 's）'));
      }, timeoutMs);

      pending.set(id, { resolve, reject, timer });

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

  /** WebM → MP4（H.264/AAC 重编码，+faststart 让 moov 在开头可拖动）。失败抛错。 */
  function webmToMp4(blob, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 5 * 60 * 1000;   // 默认 5 分钟
    const args = [
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac',
      '-movflags', '+faststart',
    ];
    return transcode(blob, args, timeoutMs);
  }

  /**
   * 原生 MediaRecorder 录的 MP4 → faststart（moov atom 搬到开头）。
   * -c copy 流复制，不重编码，速度比转码快一个数量级。失败抛错。
   *
   * 为什么需要：Chrome MediaRecorder 录的 MP4 把 moov 写在末尾，
   * 播放器必须等整个文件下载完才能 seek。faststart 把 moov 搬到开头，
   * 进度条才能正常拖动。
   */
  function mp4Faststart(blob, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 60 * 1000;   // 默认 1 分钟（流复制应该很快）
    const args = ['-c', 'copy', '-movflags', '+faststart'];
    return transcode(blob, args, timeoutMs);
  }

  G.webmToMp4 = webmToMp4;
  G.mp4Faststart = mp4Faststart;
})(self);
