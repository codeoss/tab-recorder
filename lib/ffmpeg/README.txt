lib/ffmpeg/
===========

本目录用于存放 ffmpeg.wasm 内核文件（WebM → MP4 转码所需）。
默认未提供，因此「输出格式 = MP4」需要按下方步骤手动放入文件后才能生效。
即使不放，WebM 输出与所有录制功能照常工作；转码失败时会自动回退为 WebM。

启用 MP4 转码：
  1. 安装内核：
       npm i @ffmpeg/core@0.12.10        # 或 @ffmpeg/core@0.12.6
  2. 从 node_modules/@ffmpeg/core/dist/ 复制以下两个文件到本目录：
       - ffmpeg-core.js
       - ffmpeg-core.wasm
     （ffmpeg-core.worker.js 不再需要——ffmpeg 现在跑在扩展自带的
      transcoder-worker.js 这个 Web Worker 里，转码期间 UI 不卡。）
  3. 在扩展弹窗中「输出格式」选择 MP4，重新加载扩展。

manifest.json 已配好 wasm-unsafe-eval CSP 和 web_accessible_resources，
无需手动调整。

来源：
  https://github.com/ffmpegwasm/ffmpeg.wasm （@ffmpeg/core 是 wasm 编译产物）
