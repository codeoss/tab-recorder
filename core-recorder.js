/**
 * core-recorder.js — 公共录制引擎
 *
 * 抽出 offscreen.js 和 recorder.js 中一字不差的录制逻辑：
 *   - MediaRecorder 生命周期（start/pause/resume/stop/discard）
 *   - 分片累积 / 定时合并（compact）
 *   - 定时停止 / 倒计时无关
 *   - onStopped 异步链：fix-webm → 可选 mp4 转码 → 下载 → 上报历史
 *   - elapsed 计时、pickFormat、fmtDur 等纯工具
 *
 * 通过三个钩子由调用方注入「上下文相关」的差异：
 *   getStream(opts) → Promise<MediaStream>
 *       取流逻辑。tab 模式走 tabCapture，desktop 走 getDisplayMedia，
 *       兼容模式合成双流。
 *   onEvent(name, data)
 *       状态回调。调用方据此更新 UI / 通知 background。
 *   releaseExtra()（可选）
 *       释放本上下文额外持有的资源（如兼容模式的 screenAudioStream）。
 *   saveFile(blob, filename) → Promise<{filename, path}>
 *       由 background 确认真实落盘；完成前不得上报 saved/成功历史。
 *
 * 暴露全局：createRecorderEngine(options) → engine
 *   engine.start(opts) / .stop() / .pause() / .resume() / .discard() / .retrySave()
 *   engine.isRecording() / .isBusy()   // 录制、保存及失败待处理均为 busy
 *
 * 依赖（调用方 HTML 里要先加载）：
 *   fix-webm.js → fixWebMBlob
 *   transcoder.js → webmToMp4（webm 转 mp4 时用）/ mp4Faststart（原生 mp4 修 faststart 时用）
 *                  （两者内部都跑在 Web Worker，转码期间主线程不阻塞）
 *   save-file.js → saveFileViaBackground（创建 Blob URL 并等待下载终态）
 */

(function (G) {
  'use strict';

  /**
   * @param {Object} opts
   * @param {(opts: Object) => Promise<MediaStream>} opts.getStream
   * @param {(name: string, data?: Object) => void} [opts.onEvent]
   * @param {() => void} [opts.releaseExtra]
   * @param {(blob: Blob, filename: string) => Promise<{filename: string, path: string}>} opts.saveFile
   */
  function createRecorderEngine({ getStream, onEvent, releaseExtra, saveFile }) {
    const emit = (name, data) => { try { onEvent && onEvent(name, data); } catch (_) {} };

    // ── 引擎状态 ─────────────────────────────────────────
    let recorder = null;
    let activeStream = null;     // getStream 返回的主流，core 自行管理释放
    let chunks = [];
    let mime = '';
    let recordedIsMp4 = false;   // 录制是否用原生 MP4（决定 onStopped 是否还要转码）
    let startTs = 0;
    let pausedMs = 0;
    let pauseTs = 0;
    let stopTimer = null;
    let flushTimer = null;
    let tickInterval = null;
    let paused_ = false;        // 是否处于暂停态（内部状态，外部用 isPaused() 查询）
    let isProcessing = false;   // onStopped 异步链进行中：关窗会丢视频
    let discarded = false;      // 处理中被丢弃：onStopped 链跑完后不下载、不写历史
    let pendingSave = null;     // 已整理完成、等待下载成功/重试/丢弃的最终产物
    let saveInFlight = false;   // saveFile Promise 尚未到终态，禁止并发重试
    let limitMs = 0;
    let outputFormat = 'webm';

    /* ── 开始录制 ────────────────────────────────────── */

    async function start(opts) {
      // 重入守卫：上一段还在录制/保存时拒绝。旧 engine 的 MediaRecorder 与
      // 媒体轨一旦失去引用就再无法停止，会变成幽灵录制
      if (isRecording() || isProcessing) return false;
      opts = opts || {};
      limitMs = (opts.timeLimit || 0) * 1000;
      outputFormat = opts.outputFormat || 'webm';
      isProcessing = false;
      discarded = false;
      pendingSave = null;
      saveInFlight = false;

      const recStream = await getStream(opts);
      if (!recStream) return false;   // 取流失败，调用方已在 onEvent('error') 上报
      activeStream = recStream;

      const fmt = pickFormat(outputFormat);
      mime = fmt.mime;
      recordedIsMp4 = fmt.isMp4;
      chunks = [];
      recorder = new MediaRecorder(recStream, {
        mimeType: mime,
        videoBitsPerSecond: parseInt(opts.quality) || 8000000,
      });

      recorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) { chunks.push(e.data); reportSize(); }
      };
      recorder.onstop = () => onStopped();

      // Chrome「停止共享」条 / 流被外部结束 → 干净收尾
      // 监听所有轨道：兼容模式下音频轨 ended 也要捕获（否则录制继续但无声）
      recStream.getTracks().forEach(t => {
        t.addEventListener('ended', () => {
          if (recorder && recorder.state !== 'inactive') stop();
        });
      });

      recorder.start(1000);
      startTs = Date.now();
      pausedMs = 0;
      paused_ = false;

      emit('started', { timeLimit: opts.timeLimit || 0 });
      startTick();
      if (limitMs > 0) stopTimer = setTimeout(() => stop(), limitMs);
      flushTimer = setInterval(compact, 60000);
      return true;
    }

    /* ── 停止 / 暂停 / 恢复 / 丢弃 ──────────────────── */

    function stop() {
      // 暂停态直接停止：先把这段暂停并入 pausedMs，否则 elapsed() 会把
      // 暂停时长算进结果，fixWebM 补出的 Duration 比真实内容长
      if (paused_ && pauseTs) { pausedMs += Date.now() - pauseTs; paused_ = false; }
      if (stopTimer)  { clearTimeout(stopTimer);  stopTimer = null; }
      if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      else releaseAll();
    }

    function pause() {
      if (!recorder || paused_ || recorder.state !== 'recording') return;
      recorder.pause(); paused_ = true; pauseTs = Date.now(); stopTick();
      if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
      emit('paused');
    }

    function resume() {
      if (!recorder || !paused_ || recorder.state !== 'paused') return;
      pausedMs += Date.now() - pauseTs;
      recorder.resume(); paused_ = false; startTick();
      if (limitMs > 0) {
        const rem = limitMs - elapsed();
        if (rem > 0) stopTimer = setTimeout(() => stop(), rem);
        else return stop();
      }
      emit('resumed');
    }

    function discard() {
      // 标记丢弃：若 onStopped 异步链（fixWebM/转码）正在进行，
      // 让它跑完后静默收尾——不下载、不写历史
      discarded = true;
      chunks = [];
      if (stopTimer)  { clearTimeout(stopTimer);  stopTimer = null; }
      if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
      if (pendingSave && !saveInFlight) {
        pendingSave = null;
        isProcessing = false;
        releaseAll();
        emit('processing', { active: false });
        emit('stopped', { historyEntry: null, discarded: true });
        return;
      }
      if (recorder && recorder.state !== 'inactive') {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        try { recorder.stop(); } catch (_) {}
      }
      releaseAll();
      emit('stopped', { historyEntry: null, discarded: true });
    }

    /* ── 录制结束：修复 WebM → 可选 MP4 转码 → 下载 ─── */

    async function persistFinalBlob() {
      if (!pendingSave || saveInFlight || discarded) return false;
      saveInFlight = true;
      const job = pendingSave;
      try {
        emit('processing', { active: true, stage: 'download' });
        const result = await saveFile(job.blob, job.filename);
        if (discarded) {
          pendingSave = null;
          isProcessing = false;
          saveInFlight = false;
          emit('processing', { active: false });
          return true;
        }
        const filename = (result && result.filename) || job.filename;
        const historyEntry = {
          filename, size: job.blob.size,
          duration: fmtDur(job.durMs), date: new Date().toLocaleString('zh-CN'),
          format: job.blob.type.includes('mp4') ? 'mp4' : 'webm',
        };
        pendingSave = null;
        emit('stopped', { historyEntry });
        emit('saved', { filename });
        isProcessing = false;
        saveInFlight = false;
        emit('processing', { active: false });
        return true;
      } catch (error) {
        saveInFlight = false;
        if (discarded) {
          pendingSave = null;
          isProcessing = false;
          emit('processing', { active: false });
          return true;
        }
        emit('saveerror', { message: error.message || String(error) });
        return false;
      }
    }

    async function retrySave() {
      if (!pendingSave || saveInFlight || discarded) return false;
      return await persistFinalBlob();
    }

    async function onStopped() {
      releaseAll(); stopTick();
      isProcessing = true;

      if (!chunks.length) {
        isProcessing = false;
        emit('processing', { active: false });
        emit('stopped', { historyEntry: null });
        return;
      }

      const durMs = elapsed();
      let blob = new Blob(chunks, { type: mime });
      chunks = [];
      emit('processing', { active: true, stage: recordedIsMp4 ? 'mp4-fix' : 'webm-fix' });

      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      let filename = recordedIsMp4 ? `TabRecord_${ts}.mp4` : `TabRecord_${ts}.webm`;
      let finalBlob = blob;

      if (recordedIsMp4) {
        // 原生 MP4：faststart / fMP4 时长修补；非常规布局才回退 wasm。
        try {
          finalBlob = await mp4FaststartJs(blob);
        } catch (e1) {
          console.warn('JS faststart 不适用，尝试 wasm：', e1);
          try {
            finalBlob = await mp4Faststart(blob);
          } catch (e2) {
            console.warn('MP4 faststart 失败，保留原始文件（进度条可能拖不动）：', e2);
          }
        }
      } else {
        // WebM：补 SeekHead/Cues/Duration，使 Chrome 与 WMP 均可拖动
        try { blob = await fixWebMBlob(blob, durMs); } catch (e) { console.warn(e); }
        finalBlob = blob;

        if (outputFormat === 'mp4') {
          emit('processing', { active: true, stage: 'transcode' });
          try {
            finalBlob = await webmToMp4(blob);
            filename = `TabRecord_${ts}.mp4`;
          } catch (e) {
            console.warn('MP4 转码失败，回退 WebM：', e);
          }
        }
      }

      if (discarded) {
        isProcessing = false;
        emit('processing', { active: false });
        return;
      }

      pendingSave = { blob: finalBlob, filename, durMs };
      await persistFinalBlob();
    }

    /* ── 计时 ────────────────────────────────────────── */

    function startTick() {
      stopTick();
      tickInterval = setInterval(() => {
        emit('tick', { elapsedMs: elapsed(), limitMs });
      }, 250);
    }
    function stopTick() {
      if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
    }

    /* ── 工具 ────────────────────────────────────────── */

    function elapsed() { return Date.now() - startTs - pausedMs; }

    /**
     * 选 MediaRecorder mimeType。
     *   - 用户要 mp4 时，优先尝试原生 MP4 支持（Chrome 130+ 的 avc1/mp4a），
     *     不行再回退 webm（onStopped 时再走 ffmpeg 转码）。
     *   - 用户要 webm 时，走原 VP9/VP8 链。
     * 返回 { mime, isMp4 }：isMp4 表示是否真正用原生 MP4 录制。
     */
    function pickFormat(outputFormat) {
      if (outputFormat === 'mp4') {
        // Chrome 130+ 支持 video/mp4;codecs=avc1,mp4a（H.264 + AAC）
        // avc1.42E01E = H.264 Baseline 3.0，兼容性最好；mp4a.40.2 = AAC-LC
        for (const t of [
          'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
          'video/mp4;codecs=avc1,mp4a',
          'video/mp4',
        ]) {
          if (MediaRecorder.isTypeSupported(t)) return { mime: t, isMp4: true };
        }
        // 原生不支持 → 回退 webm，onStopped 时转码
      }
      for (const t of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'])
        if (MediaRecorder.isTypeSupported(t)) return { mime: t, isMp4: false };
      return { mime: 'video/webm', isMp4: false };
    }

    function reportSize() {
      const s = chunks.reduce((a, c) => a + c.size, 0);
      emit('size', { bytes: s });
    }

    function compact() { if (chunks.length > 120) chunks = [new Blob(chunks, { type: mime })]; }

    function fmtDur(ms) {
      const s = Math.max(0, Math.floor(ms / 1000));
      return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
        .map(v => String(v).padStart(2, '0')).join(':');
    }

    function releaseAll() {
      // 主流由 core 管理（就是 getStream 返回、喂给 MediaRecorder 的那条）
      if (activeStream) {
        try { activeStream.getTracks().forEach(t => t.stop()); } catch (_) {}
        activeStream = null;
      }
      // 调用方额外持有的资源（兼容模式的 screenAudioStream、回环用的 audioCtx 等）
      try { releaseExtra && releaseExtra(); } catch (_) {}
    }

    /* ── 查询 ────────────────────────────────────────── */

    function isRecording() { return !!recorder && recorder.state !== 'inactive'; }
    function isBusy()      { return isRecording() || isProcessing; }

    return {
      start, stop, pause, resume, discard, retrySave,
      isRecording, isBusy, isPaused: () => paused_,
    };
  }

  G.createRecorderEngine = createRecorderEngine;
})(self);
