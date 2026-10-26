#!/usr/bin/env bash
# tab-recorder E2E 入口。需要：X11 显示（DISPLAY）、系统 Chrome、Node ≥18。
# 首次先 cd e2e && npm i
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.local/node/bin:$PATH"
export DISPLAY="${DISPLAY:-:99}"

# 无声卡环境给 Chrome 一个空输出设备（音频回环需要 destination）
if command -v pactl >/dev/null; then
  pulseaudio --check 2>/dev/null || pulseaudio --start 2>/dev/null || true
  pactl list short sinks 2>/dev/null | grep -q . || \
    pactl load-module module-null-sink sink_name=dummy 2>/dev/null || true
fi

node unit-webmstream.mjs && node unit-mp4faststart.mjs && node unit-save-state.mjs && node unit-native-mp4.mjs && node run.mjs "$@"
