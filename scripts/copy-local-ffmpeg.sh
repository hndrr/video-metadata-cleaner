#!/usr/bin/env bash
set -euo pipefail

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg が見つかりません。先に brew install ffmpeg を実行してください。" >&2
  exit 1
fi

if ! command -v rustc >/dev/null 2>&1; then
  echo "rustc が見つかりません。Rust をインストールしてください。" >&2
  exit 1
fi

TARGET_TRIPLE="$(rustc --print host-tuple 2>/dev/null || rustc -Vv | awk '/host:/ { print $2 }')"
DEST="src-tauri/binaries/ffmpeg-${TARGET_TRIPLE}"

mkdir -p src-tauri/binaries
cp "$(command -v ffmpeg)" "$DEST"
chmod +x "$DEST"

echo "Copied: $DEST"
echo "注意: Homebrew版FFmpegは外部dylibへ依存するため、このコピーはローカル開発用です。配布用には自己完結したビルドを用意してください。"
