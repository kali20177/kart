# KART 应用图标

主图标为方案 A「对话 K」：暗色底板上，RX 蓝大气泡承载白色 K，TX 绿小气泡（位置偏上）内是白色 **"4B"**——
即 'K' 的 ASCII 十六进制 0x4B，蓝绿两泡构成"字符 ↔ 线上字节"的闭环，同时点出 KART 的 ASCII/Hex 显示切换能力。
两个字形均为 **JetBrains Mono ExtraBold Italic 的真实轮廓**，由 `build_svg.py` 从 TTF 提取（fontTools SVGPathPen，
非 `<text>`、非手绘摹写），与应用 UI 等宽字体同源；斜体右倾的动势顺着蓝绿气泡对角线构图。
独立于系统字体，任何机器构建结果一致。

**重新生成图标 SVG**（改布局/字形/字重都改这个脚本，不要手改 SVG）：

```bash
pip install fonttools   # 任意 venv
python3 design/icons/build_svg.py [JetBrainsMono-ExtraBoldItalic.ttf 路径]
```

脚本内置断言（字形非空、坐标边界），输出现写入 kart-icon-a.svg 与 kart-icon-a-mac.svg。
字形来源：`~/Downloads/JetBrainsMono/JetBrainsMonoNLNerdFont-ExtraBoldItalic.ttf`（Nerd Fonts 发行版，
基础字母与官方一致）。历史教训：曾用正则补丁方式替换字形块，因 SVG 路径含 `/` 导致正则静默
不匹配、连续三轮"假替换"（用户对照字体样张发现 K 形不对才暴露）——现改为整文件确定性生成。

定位参数（脚本内常量）：K 字高 270（基线 y=700）、墨心对齐蓝泡中心；4B 字高 130（基线 y=301）、
墨心对齐 x=680，B 按等宽字宽 600 推进。改字重只需给脚本传不同 TTF。

## 文件

| 文件 | 说明 |
|------|------|
| `kart-icon-a.svg` | **主图标**（满幅，Linux PNG / Windows ICO 的源） |
| `kart-icon-a-mac.svg` | macOS 变体（824 艺术尺寸居中留边，icns 源） |
| `build_svg.py` | SVG 确定性生成脚本（字形提取 + 布局组装） |

未入库：备选方案（单气泡方波尾 / 分屏 K）与各轮对比图在 `~/Documents/kart-icon-drafts/`。

## 重新生成 build 资产

依赖：`rsvg-convert`、`magick`（ImageMagick）、`iconutil`（macOS 自带）。

```bash
# Linux PNG（满幅主图 1024）
rsvg-convert -w 1024 -h 1024 kart-icon-a.svg -o ../../build/icon.png

# macOS icns（留边版）
rm -rf /tmp/kart.iconset && mkdir -p /tmp/kart.iconset
for s in 16 32 128 256 512; do
  rsvg-convert -w $s -h $s kart-icon-a-mac.svg -o /tmp/kart.iconset/icon_${s}x${s}.png
  rsvg-convert -w $((s*2)) -h $((s*2)) kart-icon-a-mac.svg -o /tmp/kart.iconset/icon_${s}x${s}@2x.png
done
iconutil -c icns /tmp/kart.iconset -o ../../build/icon.icns

# Windows ico（16-256 多尺寸）
for s in 16 24 32 48 64 128 256; do rsvg-convert -w $s -h $s kart-icon-a.svg -o /tmp/ico_$s.png; done
magick /tmp/ico_{16,24,32,48,64,128,256}.png ../../build/icon.ico
```

`electron-builder.json` 三平台分别引用 `build/icon.icns` / `icon.ico` / `icon.png`，改设计后重跑上述命令即可。
