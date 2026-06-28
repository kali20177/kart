#!/usr/bin/env bash
#
# 从单张 PNG 源图生成三平台 Electron 应用图标
#   - 抠掉外侧深色背景 → 透明
#   - macOS: build/icon.icns  (1024×1024, 含 Apple HIG 推荐留白)
#   - Windows: build/icon.ico  (含 16/32/48/64/128/256 多尺寸)
#   - Linux: build/icon.png   (512×512, 透明背景)
#
# 用法:
#   scripts/build-icons.sh <源 PNG 路径> [fuzz 容差，默认 15%]
#
# 示例:
#   scripts/build-icons.sh "ChatGPT Image 2026年6月22日 00_03_10.png"
#   scripts/build-icons.sh ./icon-source.png 20%
#
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "用法: $0 <源 PNG 路径> [fuzz 容差，默认 15%]" >&2
  exit 1
fi

SRC="$1"
FUZZ="${2:-15%}"
BUILD_DIR="build"

if [[ ! -f "$SRC" ]]; then
  echo "❌ 源文件不存在: $SRC" >&2
  exit 1
fi

if ! command -v magick >/dev/null 2>&1; then
  echo "❌ 未找到 ImageMagick，请先 brew install imagemagick" >&2
  exit 1
fi

mkdir -p "$BUILD_DIR"

TMP_TRANSPARENT="$(mktemp -t icon-transparent).png"
TMP_MAC="$(mktemp -t icon-mac).png"
trap 'rm -f "$TMP_TRANSPARENT" "$TMP_MAC"' EXIT

echo "📐 源图: $SRC"
echo "🎯 fuzz 容差: $FUZZ"

# 1. 抠掉外侧深色背景（从 (0,0) 角落像素开始洪水填充为透明）
echo "🧼 抠掉外侧深色背景..."
magick "$SRC" \
  -alpha set \
  -fuzz "$FUZZ" -fill none -draw 'alpha 0,0 floodfill' \
  -trim +repage \
  "$TMP_TRANSPARENT"

# 2. macOS: 1024×1024 画布，图形占中心 824×824（Apple HIG 推荐留白）
#    用 iconutil 生成正规的 .icns 容器（含多分辨率），而非把 PNG 改名
echo "🍎 生成 macOS icon.icns..."
magick "$TMP_TRANSPARENT" \
  -resize 824x824 \
  -gravity center -background none -extent 1024x1024 \
  "$TMP_MAC"

# 构造 iconutil 需要的 iconset 目录
TMP_ICONSET="$(mktemp -d -t iconset)/icon.iconset"
mkdir -p "$TMP_ICONSET"
trap 'rm -rf "$TMP_TRANSPARENT" "$TMP_MAC" "$(dirname "$TMP_ICONSET")"' EXIT

for size_pair in "16:16x16" "32:16x16@2x" "32:32x32" "64:32x32@2x" \
                 "128:128x128" "256:128x128@2x" "256:256x256" \
                 "512:256x256@2x" "512:512x512" "1024:512x512@2x"; do
  size="${size_pair%%:*}"
  name="${size_pair##*:}"
  magick "$TMP_MAC" -resize "${size}x${size}" \
    -gravity center -background none -extent "${size}x${size}" \
    "$TMP_ICONSET/icon_${name}.png"
done

if command -v iconutil >/dev/null 2>&1; then
  iconutil -c icns "$TMP_ICONSET" -o "$BUILD_DIR/icon.icns"
else
  echo "⚠️ 未找到 iconutil（仅 macOS 自带），回退到 ImageMagick 直接生成"
  magick "$TMP_MAC" "$BUILD_DIR/icon.icns"
fi

# 3. Windows: 透明 PNG → ico (含多尺寸，必含 256×256)
echo "🪟 生成 Windows icon.ico..."
magick "$TMP_TRANSPARENT" \
  -background none \
  -define icon:auto-resize=16,32,48,64,128,256 \
  "$BUILD_DIR/icon.ico"

# 4. Linux: 512×512 透明 PNG
echo "🐧 生成 Linux icon.png..."
magick "$TMP_TRANSPARENT" \
  -resize 512x512 \
  -gravity center -background none -extent 512x512 \
  "$BUILD_DIR/icon.png"

echo ""
echo "✅ 图标已生成到 $BUILD_DIR/:"
ls -la "$BUILD_DIR/"
