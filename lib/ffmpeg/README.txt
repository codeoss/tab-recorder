lib/ffmpeg/
===========

本目录用于存放 ffmpeg.wasm 内核文件（WebM → MP4 转码所需）。
默认未提供，因此「输出格式 = MP4」需要按下方步骤手动放入文件后才能生效。
即使不放，WebM 输出与所有录制功能照常工作；转码失败时会自动回退为 WebM。

启用 MP4 转码（两种方式任选其一，产物完全相同）：

  方式 A：npm 下载
    1. npm i @ffmpeg/core@0.12.10        # 或 @ffmpeg/core@0.12.6
    2. 从 node_modules/@ffmpeg/core/dist/umd/ 复制以下两个文件到本目录
       （注意是 dist/umd/ 子目录——扩展 worker 用 importScripts 加载，
        需要 UMD 构建，不是 dist/esm/）：
         - ffmpeg-core.js    （约 100KB）
         - ffmpeg-core.wasm  （约 30MB）
    3. 在扩展弹窗中「输出格式」选择 MP4，重新加载扩展。

  方式 B：不装 npm，直接从 CDN 下载这两个文件放入本目录（文件名不要改）：
    - https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js
    - https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm
    unpkg 访问慢时可用 jsdelivr 镜像：
    - https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js
    - https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm

    命令行一条龙（在本目录执行）：
      cd lib/ffmpeg
      curl -LO https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js
      curl -LO https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm

注意事项：
  - ffmpeg-core.worker.js 不需要——那是 @ffmpeg/core-mt（多线程版）的文件，
    0.12 单线程版里没有；ffmpeg 跑在扩展自带的 transcoder-worker.js 这个
    Web Worker 里，转码期间 UI 不卡。
  - 两个文件必须保持原文件名且放在同一目录（ffmpeg-core.js 按自身路径
    查找同目录的 .wasm）。
  - 内核许可证为 GPL-2.0-or-later（内含 libx264），加上体积约 30MB，
    故不进 git 仓库（.gitignore 已忽略本目录下的内核文件，避免误提交）。

manifest.json 已配好 MV3 跑 wasm 必需的 wasm-unsafe-eval CSP，无需手动调整。
不要加 web_accessible_resources：worker 和本目录的内核都是扩展页面同源加载，
用不上 WAR；加了反而会把这些资源暴露给任意网页，让扩展可被指纹识别。

补充：新版 Chrome 可原生录 MP4，本目录内核用于结束后 faststart
（搬 moov 让进度条可拖）；老版本 Chrome 则用于整段转码。
两条路径都需要内核才能得到「可用的 MP4」。

来源：
  https://github.com/ffmpegwasm/ffmpeg.wasm （@ffmpeg/core 是 wasm 编译产物）
