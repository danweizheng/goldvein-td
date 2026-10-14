/**
 * 程序生成的像素位图字体（BitmapText 用）
 *
 * 为什么不用 `Phaser.Text`：`Text` 每帧重绘 canvas，是策划案 §8.5 点名的
 * **最大性能杀手**。飘字（伤害/金币）是每帧数量最多的文本，必须走 BitmapText。
 *
 * 这里不是加载外部字体资源，而是**在运行时画一张 5×7 像素字形的图集**，
 * 再手工拼出 AngelCode XML 交给 Phaser 解析（`ParseXMLBitmapFont`）。
 * 这样 M0 不依赖任何美术资源，同时验证了 BitmapText 通路。
 *
 * 字形集合刻意只覆盖本项目需要的字符：数字 + 大写字母 + `+-%/:.,()`
 * （所有文本在显示前会 `toUpperCase()`）。
 */
import Phaser from 'phaser';

/** 字体图集纹理 key。 */
export const FONT_TEXTURE_KEY = 'pixel-font';
/** BitmapText 用的字体 key。 */
export const FONT_KEY = 'pixel-font-5x7';

/** 字形尺寸（像素）。 */
const GLYPH_W = 5;
const GLYPH_H = 7;
/** 单元格（含 1px 内边距，避免 NEAREST 采样时的边缘串色）。 */
const CELL_W = 6;
const CELL_H = 8;
const CHARS_PER_ROW = 16;

/** 支持的字符顺序（不可改：XML 里的 id 由它与索引共同决定）。 */
export const FONT_CHARS = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-%/:.,()';

/**
 * 5×7 字形点阵：每个字形 7 行 × 5 列，`1` = 实心。
 * 顺序必须与 `FONT_CHARS` 一一对应。
 */
const GLYPHS: Record<string, string> = {
  ' ': '00000' + '00000' + '00000' + '00000' + '00000' + '00000' + '00000',
  '0': '01110' + '10001' + '10011' + '10101' + '11001' + '10001' + '01110',
  '1': '00100' + '01100' + '00100' + '00100' + '00100' + '00100' + '01110',
  '2': '01110' + '10001' + '00001' + '00010' + '00100' + '01000' + '11111',
  '3': '11111' + '00010' + '00100' + '00010' + '00001' + '10001' + '01110',
  '4': '00010' + '00110' + '01010' + '10010' + '11111' + '00010' + '00010',
  '5': '11111' + '10000' + '11110' + '00001' + '00001' + '10001' + '01110',
  '6': '00110' + '01000' + '10000' + '11110' + '10001' + '10001' + '01110',
  '7': '11111' + '00001' + '00010' + '00100' + '01000' + '01000' + '01000',
  '8': '01110' + '10001' + '10001' + '01110' + '10001' + '10001' + '01110',
  '9': '01110' + '10001' + '10001' + '01111' + '00001' + '00010' + '01100',
  A: '01110' + '10001' + '10001' + '11111' + '10001' + '10001' + '10001',
  B: '11110' + '10001' + '10001' + '11110' + '10001' + '10001' + '11110',
  C: '01110' + '10001' + '10000' + '10000' + '10000' + '10001' + '01110',
  D: '11100' + '10010' + '10001' + '10001' + '10001' + '10010' + '11100',
  E: '11111' + '10000' + '10000' + '11110' + '10000' + '10000' + '11111',
  F: '11111' + '10000' + '10000' + '11110' + '10000' + '10000' + '10000',
  G: '01110' + '10001' + '10000' + '10111' + '10001' + '10001' + '01111',
  H: '10001' + '10001' + '10001' + '11111' + '10001' + '10001' + '10001',
  I: '01110' + '00100' + '00100' + '00100' + '00100' + '00100' + '01110',
  J: '00111' + '00010' + '00010' + '00010' + '00010' + '10010' + '01100',
  K: '10001' + '10010' + '10100' + '11000' + '10100' + '10010' + '10001',
  L: '10000' + '10000' + '10000' + '10000' + '10000' + '10000' + '11111',
  M: '10001' + '11011' + '10101' + '10101' + '10001' + '10001' + '10001',
  N: '10001' + '11001' + '10101' + '10011' + '10001' + '10001' + '10001',
  O: '01110' + '10001' + '10001' + '10001' + '10001' + '10001' + '01110',
  P: '11110' + '10001' + '10001' + '11110' + '10000' + '10000' + '10000',
  Q: '01110' + '10001' + '10001' + '10001' + '10101' + '10010' + '01101',
  R: '11110' + '10001' + '10001' + '11110' + '10100' + '10010' + '10001',
  S: '01111' + '10000' + '10000' + '01110' + '00001' + '00001' + '11110',
  T: '11111' + '00100' + '00100' + '00100' + '00100' + '00100' + '00100',
  U: '10001' + '10001' + '10001' + '10001' + '10001' + '10001' + '01110',
  V: '10001' + '10001' + '10001' + '10001' + '10001' + '01010' + '00100',
  W: '10001' + '10001' + '10001' + '10101' + '10101' + '11011' + '10001',
  X: '10001' + '10001' + '01010' + '00100' + '01010' + '10001' + '10001',
  Y: '10001' + '10001' + '01010' + '00100' + '00100' + '00100' + '00100',
  Z: '11111' + '00001' + '00010' + '00100' + '01000' + '10000' + '11111',
  '+': '00000' + '00100' + '00100' + '11111' + '00100' + '00100' + '00000',
  '-': '00000' + '00000' + '00000' + '11111' + '00000' + '00000' + '00000',
  '%': '11001' + '11010' + '00010' + '00100' + '01000' + '01011' + '10011',
  '/': '00001' + '00010' + '00010' + '00100' + '01000' + '01000' + '10000',
  ':': '00000' + '00100' + '00100' + '00000' + '00100' + '00100' + '00000',
  '.': '00000' + '00000' + '00000' + '00000' + '00000' + '01100' + '01100',
  ',': '00000' + '00000' + '00000' + '00000' + '00100' + '00100' + '01000',
  '(': '00010' + '00100' + '01000' + '01000' + '01000' + '00100' + '00010',
  ')': '01000' + '00100' + '00010' + '00010' + '00010' + '00100' + '01000',
};

export interface GlyphPlacement {
  char: string;
  x: number;
  y: number;
}

/** 计算字形在图集中的位置（纯函数，供测试直接断言）。 */
export function layoutGlyphs(chars: string): GlyphPlacement[] {
  const out: GlyphPlacement[] = [];
  for (let i = 0; i < chars.length; i++) {
    const col = i % CHARS_PER_ROW;
    const row = Math.floor(i / CHARS_PER_ROW);
    out.push({ char: chars[i] as string, x: col * CELL_W, y: row * CELL_H });
  }
  return out;
}

function buildFontXml(chars: string, texW: number, texH: number): string {
  const placements = layoutGlyphs(chars);
  const cells: string[] = [];
  for (const p of placements) {
    const id = p.char.charCodeAt(0);
    cells.push(
      `<char id="${id}" x="${p.x}" y="${p.y}" width="${GLYPH_W}" height="${GLYPH_H}" ` +
        `xoffset="0" yoffset="0" xadvance="${GLYPH_W + 1}" page="0" chnl="15"/>`,
    );
  }
  return (
    `<?xml version="1.0"?>\n<font>\n` +
    `<info face="pixel5x7" size="${GLYPH_H}" bold="0" italic="0" charset="" unicode="1" ` +
    `stretchH="100" smooth="0" aa="0" padding="0,0,0,0" spacing="0,0"/>\n` +
    `<common lineHeight="${CELL_H}" base="${GLYPH_H}" scaleW="${texW}" scaleH="${texH}" pages="1" packed="0"/>\n` +
    `<pages><page id="0" file="${FONT_TEXTURE_KEY}"/></pages>\n` +
    `<chars count="${placements.length}">\n${cells.join('\n')}\n</chars>\n</font>\n`
  );
}

/**
 * 生成位图字体并注册到 cache（幂等）。
 * 必须在任何 `scene.add.bitmapText(...)` 之前调用（BootScene 里做）。
 */
export function ensurePixelFont(scene: Phaser.Scene): { textureKey: string; fontKey: string } {
  if (scene.cache.bitmapFont.has(FONT_KEY)) return { textureKey: FONT_TEXTURE_KEY, fontKey: FONT_KEY };

  const rows = Math.ceil(FONT_CHARS.length / CHARS_PER_ROW);
  const texW = CHARS_PER_ROW * CELL_W;
  const texH = rows * CELL_H;

  const canvasTex = scene.textures.createCanvas(FONT_TEXTURE_KEY, texW, texH);
  if (!canvasTex) throw new Error('无法创建位图字体纹理');
  const ctx = canvasTex.context;

  ctx.clearRect(0, 0, texW, texH);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#ffffff';

  for (const p of layoutGlyphs(FONT_CHARS)) {
    const bits = GLYPHS[p.char];
    if (!bits) continue;
    for (let row = 0; row < GLYPH_H; row++) {
      for (let col = 0; col < GLYPH_W; col++) {
        if (bits[row * GLYPH_W + col] === '1') ctx.fillRect(p.x + col, p.y + row, 1, 1);
      }
    }
  }
  canvasTex.refresh();
  // 像素风必须 NEAREST，否则字形会糊（策划案 §8.5 第 5 条）
  canvasTex.setFilter(Phaser.Textures.FilterMode.NEAREST);

  const xml = buildFontXml(FONT_CHARS, texW, texH);
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const frame = scene.textures.get(FONT_TEXTURE_KEY).get();
  const data = Phaser.GameObjects.BitmapText.ParseXMLBitmapFont(doc, frame, 0, 0);

  // BitmapText 通过 cache 取 { data, texture, frame }
  (scene.cache.bitmapFont as unknown as { add(k: string, v: unknown): void }).add(FONT_KEY, {
    data,
    texture: FONT_TEXTURE_KEY,
    frame: null,
    fromAtlas: false,
  });

  return { textureKey: FONT_TEXTURE_KEY, fontKey: FONT_KEY };
}

/** 供测试/工具使用的字形数据只读视图。 */
export const FONT_LAYOUT = { glyphW: GLYPH_W, glyphH: GLYPH_H, cellW: CELL_W, cellH: CELL_H, perRow: CHARS_PER_ROW, chars: FONT_CHARS };
