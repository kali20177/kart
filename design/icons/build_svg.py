#!/usr/bin/env python3
"""生成 KART 应用图标 SVG（kart-icon-a.svg / kart-icon-a-mac.svg）。

字形来自 JetBrains Mono TTF 的真实轮廓（fontTools 提取），与应用 UI 等宽字体同源。
用法: python3 build_svg.py [字体路径]
"""
import re
import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen

FONT = sys.argv[1] if len(sys.argv) > 1 else (
    str(Path.home() / "Downloads/JetBrainsMono/JetBrainsMonoNLNerdFont-ExtraBoldItalic.ttf")
)
OUT = Path(__file__).parent

# ---- 画布几何（viewBox 1024）----
TILE_RX = 228
BLUE = dict(x=124, y=330, w=620, h=470, rx=120)   # RX 蓝泡（承载 K）
GREEN = dict(x=470, y=96, w=420, h=280, rx=92)    # TX 绿泡（承载 4B）
K_CAP_H = 270        # K 字高（px），基线 y=700
HEX_CAP_H = 130      # 4B 字高（px），基线 y=301
K_CX, HEX_CX = BLUE["x"] + BLUE["w"] // 2, 680  # 墨心目标：蓝泡中心 / 绿泡中心

font = TTFont(FONT)
UPM = font["head"].unitsPerEm
CAP = font["OS/2"].sCapHeight
gs = font.getGlyphSet()
cmap = font.getBestCmap()


def glyph(ch):
    """返回 (SVG path d, 墨宽 xMin..xMax, 推进宽度)。"""
    gname = cmap[ord(ch)]
    pen = SVGPathPen(gs)
    gs[gname].draw(pen)
    d = pen.getCommands()
    assert d and re.search(r"[MLCQZ]", d), f"空字形: {ch}"
    bp = BoundsPen(gs)
    gs[gname].draw(bp)
    return d, bp.bounds[0], bp.bounds[2], font["hmtx"][gname][0]


def group(text, cap_px, baseline_y, center_x, tracking=0.0):
    """把一串字符按等宽推进排布并垂直对齐基线，返回 <g> 块。"""
    scale = cap_px / CAP
    glyphs = [glyph(c) for c in text]
    ink_w = (sum(g[2] - g[1] for g in glyphs)) * scale + tracking * (len(glyphs) - 1)
    # 首字符墨左缘对齐整体墨心左半，逐字符按推进宽度走笔
    pen_x = center_x - ink_w / 2 - glyphs[0][1] * scale
    parts = []
    for (d, xmin, _, adv) in glyphs:
        parts.append(
            f'    <path transform="translate({pen_x:.1f},{baseline_y}) '
            f'scale({scale:.5f},-{scale:.5f})" d="{d}"/>'
        )
        pen_x += adv * scale + tracking
    return "\n".join(parts)


def advance_group(text, cap_px, baseline_y, center_x):
    """整串字符按首末墨缘居中（等宽字体，逐字符按 hmtx 推进）。"""
    scale = cap_px / CAP
    glyphs = [glyph(c) for c in text]
    xs = []
    pen_u = 0.0
    for (d, xmin, xmax, adv) in glyphs:
        xs.append(((pen_u + xmin) * scale, (pen_u + xmax) * scale))
        pen_u += adv
    ink_l, ink_r = xs[0][0], xs[-1][1]
    tx = center_x - (ink_l + ink_r) / 2
    parts = []
    pen_u = 0.0
    for (d, _, _, adv) in glyphs:
        parts.append(
            f'    <path transform="translate({tx + pen_u * scale:.1f},{baseline_y}) '
            f'scale({scale:.5f},-{scale:.5f})" d="{d}"/>'
        )
        pen_u += adv
    return "\n".join(parts), ink_r - ink_l


k_g = group("K", K_CAP_H, 700, K_CX)
hex_g, hex_ink = advance_group("4B", HEX_CAP_H, 301, HEX_CX)

svg = f'''<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- 暗色底：贴近应用 dark 主题 bg(#0d1117)→panel(#161b22)，自上而下微微透光 -->
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1B2431"/>
      <stop offset="1" stop-color="#0C1118"/>
    </linearGradient>
    <!-- RX 蓝：应用 rx 气泡 #3B82F6 系 -->
    <linearGradient id="rx" x1="{BLUE['x']}" y1="{BLUE['y']}" x2="{BLUE['x'] + BLUE['w']}" y2="{BLUE['y'] + BLUE['h'] + 30}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#5CA9FF"/>
      <stop offset="1" stop-color="#2563EB"/>
    </linearGradient>
    <!-- TX 绿：应用 tx 气泡 #10B981 系 -->
    <linearGradient id="tx" x1="{GREEN['x']}" y1="{GREEN['y']}" x2="{GREEN['x'] + GREEN['w']}" y2="{GREEN['y'] + GREEN['h'] + 30}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#3DDC9E"/>
      <stop offset="1" stop-color="#0BA36B"/>
    </linearGradient>
  </defs>

  <!-- 底板 -->
  <rect x="0" y="0" width="1024" height="1024" rx="{TILE_RX}" fill="url(#tile)"/>
  <rect x="2.5" y="2.5" width="1019" height="1019" rx="{TILE_RX - 2}" fill="none" stroke="#FFFFFF" stroke-opacity="0.07" stroke-width="3"/>

  <!-- TX 绿气泡（右上层）：'K' 的 ASCII 十六进制 0x4B，呼应 ASCII/Hex 切换 -->
  <rect x="{GREEN['x']}" y="{GREEN['y']}" width="{GREEN['w']}" height="{GREEN['h']}" rx="{GREEN['rx']}" fill="url(#tx)"/>
  <path d="M 856 346 L 856 448 Q 856 468 840 454 L 738 370 Z" fill="url(#tx)"/>
  <g fill="#FFFFFF">
{hex_g}
  </g>

  <!-- RX 蓝气泡（左下层，主体） -->
  <rect x="{BLUE['x']}" y="{BLUE['y']}" width="{BLUE['w']}" height="{BLUE['h']}" rx="{BLUE['rx']}" fill="url(#rx)"/>
  <path d="M 176 770 L 176 884 Q 176 906 194 891 L 322 792 Z" fill="url(#rx)"/>

  <!-- K：与 4B 同为 JetBrains Mono 真实轮廓（字形源: {Path(FONT).name}） -->
  <g fill="#FFFFFF">
{k_g}
  </g>
</svg>
'''

(OUT / "kart-icon-a.svg").write_text(svg)
mac = f'''<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(100,100) scale(0.8046875)">
{svg.rstrip().removeprefix('<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">').removesuffix('</svg>').strip()}
  </g>
</svg>
'''
(OUT / "kart-icon-a-mac.svg").write_text(mac)
print(f"OK font={Path(FONT).name} cap={CAP}/{UPM} 4B ink_w={hex_ink:.1f}px")
