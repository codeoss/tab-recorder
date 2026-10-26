/**
 * save-status.js — 标签页录制的可见保存状态页。
 *
 * offscreen 没有 UI，因此停止后由 background 打开此页面，防止用户只看
 * 主弹窗已关闭就误以为保存结束。完成前同步维护 beforeunload 关窗保护。
 */
(function () {
  'use strict';

  const el = {};
  for (const id of ['title', 'detail', 'progressText', 'progress', 'retryBtn', 'discardBtn', 'closeBtn']) {
    el[id] = document.getElementById(id);
  }
  let unsaved = false;
  let completeTimer = null;

  function mb(bytes) { return ((bytes || 0) / 1048576).toFixed(1); }
  function send(type, extra) { return chrome.runtime.sendMessage({ type, ...extra }); }

  function render(state) {
    const phase = state.savePhase || (state.processing ? 'processing' : '');
    unsaved = !!state.processing || (phase === 'error' && !!state.saveCanRetry);
    el.retryBtn.hidden = !(phase === 'error' && state.saveCanRetry);
    el.discardBtn.hidden = el.retryBtn.hidden;

    if (phase === 'complete') {
      el.title.textContent = '保存完成';
      el.detail.textContent = state.saveFilename || '文件已保存到下载目录';
      el.progress.value = 100;
      el.progressText.textContent = '现在可以安全关闭浏览器';
      if (!completeTimer) completeTimer = setTimeout(() => window.close(), 2000);
      return;
    }
    if (completeTimer) { clearTimeout(completeTimer); completeTimer = null; }

    if (phase === 'error') {
      el.title.textContent = '保存失败';
      el.detail.textContent = (state.saveError || '未知错误') + (state.saveCanRetry
        ? '。文件仍在内存，可重试保存，或明确选择丢弃。'
        : '。保存上下文已关闭，无法重试；可以开始新录制。');
      el.progressText.textContent = state.saveCanRetry ? '请勿直接关闭浏览器' : '本次文件无法恢复';
      el.progress.value = 0;
      return;
    }

    if (phase === 'downloading') {
      el.title.textContent = '正在保存到下载目录';
      el.detail.textContent = '请勿关闭浏览器，文件尚未保存完成。';
      if (state.saveTotal > 0) {
        const percent = Math.min(100, Math.floor(state.saveReceived / state.saveTotal * 100));
        el.progress.value = percent;
        el.progressText.textContent = `${percent}% · ${mb(state.saveReceived)} / ${mb(state.saveTotal)} MB`;
      } else {
        el.progress.value = 0;
        el.progressText.textContent = `已接收 ${mb(state.saveReceived)} MB（总大小未知）`;
      }
      return;
    }

    if (phase === 'processing') {
      const stages = {
        'webm-fix': '正在整理 WebM 索引',
        'mp4-fix': '正在修复 MP4 时长与索引',
        transcode: '正在转码',
        download: '正在准备下载',
      };
      el.title.textContent = '正在保存：' + (stages[state.processingStage] || '正在整理视频');
      el.detail.textContent = '请勿关闭浏览器，文件尚未保存完成。';
      el.progressText.textContent = '处理完成后还要等待下载落盘';
      el.progress.value = 0;
      return;
    }

    el.title.textContent = '没有正在保存的录制';
    el.detail.textContent = '可以关闭此窗口';
    el.progressText.textContent = '';
    el.progress.value = 0;
  }

  async function refresh() {
    try {
      render(await send('GET_STATE'));
    } catch (error) {
      unsaved = true;
      el.title.textContent = '无法读取保存状态';
      el.detail.textContent = '为避免丢失录制，请先不要关闭浏览器：' + error.message;
    }
  }

  el.retryBtn.addEventListener('click', async () => {
    el.retryBtn.disabled = true;
    const result = await send('RETRY_SAVE');
    if (result && result.error) {
      el.detail.textContent = result.error;
      el.retryBtn.disabled = false;
    }
    await refresh();
  });
  el.discardBtn.addEventListener('click', async () => {
    if (!confirm('确定丢弃此次录制？此操作不可恢复。')) return;
    const result = await send('DISCARD_RECORDING');
    if (result && result.error) el.detail.textContent = result.error;
    await refresh();
  });
  el.closeBtn.addEventListener('click', () => window.close());
  window.addEventListener('beforeunload', event => {
    if (!unsaved) return;
    event.preventDefault();
    event.returnValue = '视频尚未保存完成，关闭浏览器可能丢失录制。';
    return event.returnValue;
  });

  refresh();
  setInterval(refresh, 1000);
})();
