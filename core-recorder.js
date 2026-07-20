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
 * 通过两个钩子由调用方注入「上下文相关」的差异：
 *   getStream(opts) → Promise<MediaStream>
 *       取流逻辑。tab 模式走 tabCapture，desktop 走 getDisplayMedia，
 *       兼容模式合成双流。
 *   onEvent(name, data)
 *       状态回调。调用方据此更新 UI / 通知 background。
 *   releaseExtra()（可选）
 *       释放本上下文额外持有的资源（如兼容模式的 screenAudioStream）。
 *
 * 暴露全局：createRecorderEngine(options) → engine
 *   engine.start(opts) / .stop() / .pause() / .resume() / .discard()
 *   engine.isRecording() / .isBusy()   // 录制中？处理中（关窗会丢视频）？
 *
 * 依赖（调用方 HTML 里要先加载）：
 *   fix-webm.js → fixWebMBlob
 *   transcoder.js → webmToMp4（webm 转 mp4 时用）/ mp4Faststart（原生 mp4 修 faststart 时用）
 */

(function (G) {
  'use strict';

  /**
   * @param {Object} opts
   * @param {(opts: Object) => Promise<MediaStream>} opts.getStream
   * @param {(name: string, data?: Object) => void} [opts.onEvent]
   * @param {() => void} [opts.releaseExtra]
   */
  function createRecorderEngine({ getStream, onEvent, releaseExtra }) {
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
    let limitMs = 0;
    let outputFormat = 'webm';

    /* ── 开始录制 ────────────────────────────────────── */

    async function start(opts) {
      opts = opts || {};
      limitMs = (opts.timeLimit || 0) * 1000;
      outputFormat = opts.outputFormat || 'webm';
      isProcessing = false;

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
      chunks = [];
      if (stopTimer)  { clearTimeout(stopTimer);  stopTimer = null; }
      if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
      if (recorder && recorder.state !== 'inactive') {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        try { recorder.stop(); } catch (_) {}
      }
      releaseAll();
      emit('stopped', { historyEntry: null, discarded: true });
    }

    /* ── 录制结束：修复 WebM → 可选 MP4 转码 → 下载 ─── */

    async function onStopped() {
      releaseAll(); stopTick();
      isProcessing = true;
      emit('processing', { active: true });

      if (!chunks.length) {
        isProcessing = false;
        emit('processing', { active: false });
        emit('stopped', { historyEntry: null });
        return;
      }

      const durMs = elapsed();
      let blob = new Blob(chunks, { type: mime });
      chunks = [];

      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      let filename = recordedIsMp4 ? `TabRecord_${ts}.mp4` : `TabRecord_${ts}.webm`;
      let finalBlob = blob;

      if (recordedIsMp4) {
        // 原生 MP4 录制：文件能播放，但 Chrome 的 MediaRecorder 把 moov atom
        // 写在末尾，导致播放器必须下载完整文件才能 seek（进度条拖不动）。
        // 用 ffmpeg -c copy -movflags +faststart 把 moov 搬到开头（流复制，
        // 不重编码，比转码快一个数量级）。失败则回退到原始 blob（能播不能拖）。
        // TODO(额外C): ffmpeg.wasm 走 callMain 同步阻塞主线程，后续切 worker 版。
        try {
          finalBlob = await mp4Faststart(blob);
        } catch (e) {
          console.warn('MP4 faststart 失败，保留原始文件（进度条可能拖不动）：', e);
        }
      } else {
        // WebM：补 Cues 索引 + Duration，使其可拖动进度条
        try { blob = await fixWebMBlob(blob, durMs); } catch (e) { console.warn(e); }
        finalBlob = blob;

        // 用户要 MP4 但原生不支持 → ffmpeg.wasm 转码
        // TODO(额外C): 当前 ffmpeg.wasm 走 callMain 同步阻塞主线程，转码期间
        //   引擎无法响应任何消息。后续应切到 @ffmpeg/ffmpeg 的 worker 版。
        //   现阶段靠 onEvent('processing') 让 UI 提示「转码中请勿关闭」。
        if (outputFormat === 'mp4') {
          try {
            finalBlob = await webmToMp4(blob);
            filename = `TabRecord_${ts}.mp4`;
          } catch (e) {
            console.warn('MP4 转码失败，回退 WebM：', e);
          }
        }
      }

      dl(finalBlob, filename);
      emit('stopped', {
        historyEntry: {
          filename, size: finalBlob.size,
          duration: fmtDur(durMs), date: new Date().toLocaleString('zh-CN'),
          format: finalBlob.type.includes('mp4') ? 'mp4' : 'webm',
        },
      });
      emit('saved', { filename });

      isProcessing = false;
      emit('processing', { active: false });
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

    function dl(blob, name) {
      const u = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = u; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(u), 30000);
    }

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
      start, stop, pause, resume, discard,
      isRecording, isBusy, isPaused: () => paused_,
    };
  }

  G.createRecorderEngine = createRecorderEngine;
})(self);
