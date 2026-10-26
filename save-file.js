/**
 * save-file.js — 通过 background 下载最终 Blob 并等待真实落盘结果。
 *
 * offscreen 只能使用 runtime 扩展 API，不能直接调用 chrome.downloads；
 * 因此这里只创建 Blob URL 并收发消息，由 background 执行下载和对账。
 * URL 必须存活到 complete/interrupted，提前 revoke 会让大文件下载中断。
 */
(function (G) {
  'use strict';

  async function saveFileViaBackground(blob, filename) {
    const url = URL.createObjectURL(blob);
    try {
      const started = await chrome.runtime.sendMessage({ type: 'SAVE_FILE', url, filename });
      if (!started || started.error || !started.downloadId) {
        throw new Error((started && started.error) || '无法启动下载');
      }
      const downloadId = started.downloadId;
      for (;;) {
        const status = await chrome.runtime.sendMessage({ type: 'GET_DOWNLOAD_STATUS', downloadId });
        if (!status) throw new Error('未返回下载状态');
        if (status.state === 'complete') {
          return { filename: status.filename, path: status.path };
        }
        if (status.state === 'interrupted' || status.error) {
          throw new Error(status.error || '下载已中断');
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  G.saveFileViaBackground = saveFileViaBackground;
})(self);
