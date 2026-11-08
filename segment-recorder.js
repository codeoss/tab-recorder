/**
 * segment-recorder.js — 同一媒体流上的重叠分段会话。
 *
 * 每段仍使用核心引擎的 OPFS 与修复链；控制器负责段切换、总计时、
 * 串行处理和共享资源所有权。启动中的段与活动段分开跟踪，停止、暂停和
 * 丢弃不会因为 writer 尚未就绪而丢失目标或留下孤儿 recorder。
 */
(function (G) {
  'use strict';

  function createSegmentedRecorderEngine({ getStream, onEvent, releaseExtra, saveFile }) {
    const emit = (name, data) => { try { return onEvent && onEvent(name, data); } catch (_) { return undefined; } };
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    let stream = null;
    let active = null;
    let rotation = null;
    let segments = [];
    let sessionId = '';
    let startGeneration = 0;
    let nextIndex = 0;
    let options = {};
    let segmentMs = 30 * 60000;
    let limitMs = 0;
    let startTs = 0;
    let pausedMs = 0;
    let pauseTs = 0;
    let paused_ = false;
    let tickTimer = null;
    let limitTimer = null;
    let stopTimer = null;
    let stopRequested = false;
    let stoppingPromise = null;
    let discarded = false;
    let finalized = false;
    let sessionActive = false;
    let sessionError = '';
    let saveChain = Promise.resolve();
    let processingTail = Promise.resolve();
    let finalHistory = null;

    function elapsed() {
      return Date.now() - startTs - pausedMs - (paused_ ? Date.now() - pauseTs : 0);
    }

    function segmentElapsed(seg) {
      return Date.now() - seg.startedAt - seg.pausedMs - (paused_ ? Date.now() - pauseTs : 0);
    }

    function clearSegmentTimer(seg) {
      if (seg && seg.timer) { clearTimeout(seg.timer); seg.timer = null; }
    }

    function armSegment(seg) {
      clearSegmentTimer(seg);
      if (!seg || stopRequested || paused_) return;
      const remaining = segmentMs - segmentElapsed(seg);
      seg.timer = setTimeout(rotate, Math.max(0, remaining));
    }

    function startTick() {
      if (tickTimer) clearInterval(tickTimer);
      tickTimer = setInterval(() => emit('tick', { elapsedMs: elapsed(), limitMs }), 250);
    }

    function stopTick() {
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    }

    function armLimit() {
      if (limitTimer) { clearTimeout(limitTimer); limitTimer = null; }
      if (!limitMs || stopRequested || paused_) return;
      const remaining = limitMs - elapsed();
      if (remaining <= 0) { stopSession(); return; }
      limitTimer = setTimeout(() => stopSession(), remaining);
    }

    function clearTimers() {
      stopTick();
      if (limitTimer) { clearTimeout(limitTimer); limitTimer = null; }
      if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
      for (const seg of segments) clearSegmentTimer(seg);
    }

    function partFilename(filename, index) {
      const suffix = `_part${String(index).padStart(3, '0')}`;
      const dot = filename.lastIndexOf('.');
      return dot < 0 ? `${filename}${suffix}` : `${filename.slice(0, dot)}${suffix}${filename.slice(dot)}`;
    }

    function enqueueSave(seg, blob, filename) {
      const task = saveChain.then(() => saveFile(blob, partFilename(filename, seg.index), {
        recordingId: seg.recordingId, segmentIndex: seg.index, sessionId,
      }));
      saveChain = task.catch(() => {});
      return task;
    }

    function releaseProcessing(seg) {
      if (seg.processingReleased) return;
      seg.processingReleased = true;
      seg.processingDone();
    }

    function hasUnresolvedFailure() {
      return segments.some(seg => seg.failure && !seg.saved);
    }

    function handleSegmentEvent(seg, name, data) {
      if (name === 'durable') {
        seg.recordingId = data.id;
        return emit('durable', { ...data, sessionId, segmentIndex: seg.index });
      }
      if (name === 'durablecleanup') {
        return emit('durablecleanup', { ...data, sessionId, segmentIndex: seg.index });
      }
      if (name === 'size') {
        if (active === seg) emit('size', { ...data, segmentIndex: seg.index });
        return;
      }
      if (name === 'processing') {
        emit('processing', {
          ...data, scope: 'segment', segmentIndex: seg.index,
          recordingId: seg.recordingId, sessionId,
        });
        if (active === seg && data && data.active && !stopRequested && !seg.expectedStop) {
          stopSession();
        }
        return;
      }
      if (name === 'saveerror') {
        const message = data && data.message || '分段保存失败';
        seg.failure = message;
        emit('saveerror', {
          ...data, message, canRetry: true, segmentIndex: seg.index,
          recordingId: seg.recordingId, sessionId,
        });
        releaseProcessing(seg);
        stopSession(message);
        return;
      }
      if (name === 'stopped') {
        seg.stopped = true;
        if (data && data.historyEntry) seg.historyEntry = data.historyEntry;
        else releaseProcessing(seg);
        return;
      }
      if (name === 'saved') {
        seg.saved = true;
        seg.failure = '';
        finalHistory = seg.historyEntry || null;
        releaseProcessing(seg);
        emit('segment', {
          phase: 'saved', recordingId: seg.recordingId,
          segmentIndex: seg.index, sessionId, historyEntry: seg.historyEntry,
        });
        if (stopRequested && !hasUnresolvedFailure()) stopSession();
      }
    }

    async function trackRotation(promise) {
      rotation = promise;
      try { return await promise; }
      finally { if (rotation === promise) rotation = null; }
    }

    async function startNextSegment() {
      if (stopRequested || !sessionActive) return null;
      const generation = startGeneration;
      const seg = {
        index: nextIndex + 1, engine: null, recordingId: '',
        startedAt: 0, pausedMs: 0, timer: null,
        stopped: false, saved: false, historyEntry: null,
        expectedStop: false, failure: '', processingReleased: false,
      };
      nextIndex = seg.index;
      segments.push(seg);
      seg.processingTurn = processingTail;
      processingTail = new Promise(resolve => { seg.processingDone = resolve; });
      seg.engine = createRecorderEngine({
        getStream: async () => stream,
        manageResources: false,
        beforeSaveProcessing: () => seg.processingTurn,
        onEvent: (name, data) => handleSegmentEvent(seg, name, data),
        releaseExtra: () => {},
        saveFile: (blob, filename) => enqueueSave(seg, blob, filename),
      });
      let started = false;
      try {
        started = await seg.engine.start({ ...options, timeLimit: 0 });
      } catch (_) { started = false; }
      if (!started) {
        releaseProcessing(seg);
        try { await seg.engine.discard(); } catch (_) {}
        return null;
      }
      if (generation !== startGeneration || stopRequested) {
        seg.expectedStop = true;
        seg.engine.stop();
        return null;
      }
      active = seg;
      seg.startedAt = Date.now();
      if (!startTs) {
        startTs = seg.startedAt;
        emit('started', { timeLimit: options.timeLimit || 0, segmented: true, segmentIndex: seg.index });
      }
      if (paused_) seg.engine.pause();
      emit('segment', { phase: 'started', recordingId: seg.recordingId, segmentIndex: seg.index, sessionId });
      armSegment(seg);
      return seg;
    }

    function hasBacklog() {
      return segments.some(seg => seg !== active && seg.engine && !seg.saved && seg.engine.isBusy() && !seg.engine.isRecording());
    }

    function rotate() {
      if (rotation) return rotation;
      return trackRotation((async () => {
        const previous = active;
        if (!previous || stopRequested || paused_ || !sessionActive) return;
        if (hasBacklog()) {
          stopSession('处理速度跟不上分段录制');
          return;
        }
        const next = await startNextSegment();
        if (!next) {
          if (!stopRequested) stopSession('下一段启动失败');
          return;
        }
        clearSegmentTimer(previous);
        previous.expectedStop = true;
        previous.engine.stop();
      })());
    }

    function releaseSharedResources() {
      if (stream) {
        try { stream.getTracks().forEach(track => track.stop()); } catch (_) {}
        stream = null;
      }
      try { releaseExtra && releaseExtra(); } catch (_) {}
    }

    function finalizeSession() {
      if (finalized) return;
      finalized = true;
      releaseSharedResources();
      emit('stopped', { historyEntry: discarded ? null : finalHistory, discarded });
      if (!discarded && finalHistory) emit('saved', { filename: finalHistory.filename });
      emit('processing', { active: false });
      sessionActive = false;
    }

    function stopSession(message) {
      if (message && sessionError !== message) {
        sessionError = message;
        emit('saveerror', { message, canRetry: true });
      }
      if (stoppingPromise) return stoppingPromise;
      stopRequested = true;
      startGeneration++;
      clearTimers();
      if (!sessionError) emit('processing', { active: true, stage: 'finalizing' });
      const pendingRotation = rotation;
      stoppingPromise = (async () => {
        if (pendingRotation) await pendingRotation;
        for (const seg of segments) {
          seg.expectedStop = true;
          if (seg.engine && seg.engine.isRecording()) seg.engine.stop();
        }
        while (segments.some(seg => seg.engine && seg.engine.isBusy())) await delay(5);
        if (hasUnresolvedFailure()) {
          releaseSharedResources();
          sessionActive = true;
          stoppingPromise = null;
          if (sessionError) emit('saveerror', { message: sessionError, canRetry: true });
          return;
        }
        finalizeSession();
      })();
      return stoppingPromise;
    }

    async function start(opts) {
      if (sessionActive || segments.some(seg => seg.engine && seg.engine.isBusy())) return false;
      options = opts || {};
      const minutes = Number(options.segmentMinutes);
      segmentMs = (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60000;
      limitMs = (options.timeLimit || 0) * 1000;
      sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      startGeneration++;
      nextIndex = 0;
      active = null;
      rotation = null;
      segments = [];
      startTs = 0;
      pausedMs = 0;
      pauseTs = 0;
      paused_ = false;
      stopRequested = false;
      stoppingPromise = null;
      discarded = false;
      finalized = false;
      sessionActive = true;
      sessionError = '';
      saveChain = Promise.resolve();
      processingTail = Promise.resolve();
      finalHistory = null;
      try {
        stream = await getStream(options);
        if (!stream || stopRequested) {
          releaseSharedResources();
          sessionActive = false;
          return false;
        }
        const first = await trackRotation(startNextSegment());
        if (!first || stopRequested) {
          releaseSharedResources();
          sessionActive = false;
          return false;
        }
        startTick();
        armLimit();
        return true;
      } catch (_) {
        releaseSharedResources();
        sessionActive = false;
        return false;
      }
    }

    function stop() { stopSession(); }

    function pause() {
      if (paused_ || !sessionActive || stopRequested) return;
      pauseTs = Date.now();
      paused_ = true;
      clearSegmentTimer(active);
      if (limitTimer) { clearTimeout(limitTimer); limitTimer = null; }
      if (active && active.engine && active.engine.isRecording()) active.engine.pause();
      stopTick();
      emit('paused');
    }

    function resume() {
      if (!paused_ || !active || !active.engine) return;
      const pausedDuration = Date.now() - pauseTs;
      pausedMs += pausedDuration;
      active.pausedMs = (active.pausedMs || 0) + pausedDuration;
      paused_ = false;
      active.engine.resume();
      armSegment(active);
      armLimit();
      startTick();
      emit('resumed');
    }

    async function discard() {
      if (discarded) return;
      discarded = true;
      stopRequested = true;
      startGeneration++;
      clearTimers();
      if (rotation) await rotation;
      await Promise.allSettled(segments.map(seg => seg.engine ? seg.engine.discard() : Promise.resolve()));
      for (const seg of segments) releaseProcessing(seg);
      finalizeSession();
    }

    async function retrySave() {
      let retried = false;
      for (const seg of segments) {
        if (seg.engine && !seg.saved) {
          const ok = await seg.engine.retrySave();
          retried = retried || ok;
        }
      }
      if (!retried && hasUnresolvedFailure() && sessionError) {
        emit('saveerror', { message: sessionError, canRetry: true });
      }
      return retried;
    }

    return {
      start, stop, pause, resume, discard, retrySave,
      isRecording: () => !!(active && active.engine && active.engine.isRecording()),
      isBusy: () => !finalized && (sessionActive || segments.some(seg => seg.engine && seg.engine.isBusy())),
      isPaused: () => paused_,
    };
  }

  G.createSegmentedRecorderEngine = createSegmentedRecorderEngine;
})(self);
