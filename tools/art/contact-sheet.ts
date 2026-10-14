/**
 * 接触表 CLI —— **本方案的主要验收物**（方案 §4）。
 *
 * 输出（`tools/art/out/`）：
 * - `contact-sheet.png`        彩色版
 * - `contact-sheet-gray.png`   灰度版
 * - `contact-sheet-cvd.png`    红绿色盲模拟版（deuteranopia，最常见）
 * - `contact-sheet-protan.png` （补充）红盲版 —— 红绿色盲的另一个极端
 *
 * 内容：
 * 1. 全部 29 个塔，按 9 系排列、每系按品阶排，48×48，**4× 放大**
 * 2. 全部 11 类敌人，32×32（精英 48、BOSS 96），**4× 放大**
 * 3. 每个精灵下方标注 `id` 与关键属性（护甲 / 飞行 / BOSS / 窃金抗性）
 * 4. 血条与钱包条示意
 * 5. 图例：护甲边框 / 塔系轮廓 / 品阶齿数 / 属性标记（把"编码规则"本身画出来）
 *
 * 运行：`& $node $pnpm exec tsx tools/art/contact-sheet.ts`
 *
 * ⚠️ 标签文字只能用本模块 5×7 字体覆盖的字符（ASCII 大写 + 数字 + `_ - : . / % ( ) +`）。
 *    中文与 Unicode 记号（◆▲⬢…）**不能**进标签，否则会渲染成"缺字方框"。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BAR_SPECS } from '../../src/art/bars';
import {
  enemyRank,
  inferElite,
  unitsByLine,
  type ArtContentInput,
  type EnemyArtInput,
  type UnitArtInput,
} from '../../src/art/content';
import {
  ARMOR_ORDER,
  CELL_BG,
  FRAME_TICK,
  LINE_ORDER,
  luma,
  resolveArmor,
  resolveLine,
  SHEET_BG,
  TEXT,
  TEXT_DIM,
  TEXT_TITLE,
  toCvd,
  toGrayscale,
  type CvdKind,
  type Rgba,
} from '../../src/art/palette';
import { renderBarsDemo, renderEnemyFrame, renderTowerFrame, spriteSizeOf, type SpriteFrame } from '../../src/art/procedural';
import { PixelCanvas, shapeForLine, type ShapeId } from '../../src/art/shapes';
import { drawText, drawTextCentered, textHeight } from '../../src/art/text';
import type { SpriteState } from '../../src/art/source';
import { loadContent, OUT_DIR } from './load-content';
import { encodePng } from './png';

// ---------------------------------------------------------------------------
// 版式常量
// ---------------------------------------------------------------------------

/** 画布宽度。所有单元格宽度都按它整除，保证每行填满、不出现参差。 */
const SHEET_W = 1800;
/** 精灵放大倍数（方案 §4 冻结：4×）。 */
export const DEFAULT_SCALE = 4;
const LABEL_SCALE = 2;
const LINE_H = textHeight(LABEL_SCALE) + 4; // 7*2+4 = 18
const GROUND_TICK: Rgba = FRAME_TICK;

/** 形状的 ASCII 名（标签用；Unicode 记号不在 5×7 字体里）。 */
const SHAPE_NAME: Record<ShapeId, string> = {
  diamond: 'DIAMOND',
  triangle: 'TRIANGLE',
  hexagon: 'HEXAGON',
  square: 'SQUARE',
  circle: 'CIRCLE',
  octagon: 'OCTAGON',
  notchedSquare: 'NOTCHED_SQ',
  dotCluster: 'DOT_CLUSTER',
  cross: 'CROSS',
};

/** 护甲边框画法的 ASCII 描述。 */
const BORDER_DESC: Record<string, string> = {
  dashed: 'DASHED_1PX_2-2',
  solid1: 'SOLID_1PX',
  solid2: 'SOLID_2PX',
  double: 'DOUBLE_SOLID',
  divine: 'SOLID_2PX+4_GOLD_CORNER',
};

/** 条规格的 ASCII 摘要（方案 §2.4 的中文原文在 `src/art/bars.ts`）。 */
const BAR_ASCII_NOTE: Record<string, string> = {
  hp: 'HP: 2PX ABOVE SPRITE, WIDTH=BODY, HEIGHT=1PX, COLOR RAMPS RED TO GREEN BY RATIO',
  wallet:
    'WALLET (SIGNATURE): 1PX BELOW HP, GOLD #FFC832, HEIGHT 1PX, DARK SLOT + 1PX DARK RING',
  block: 'BLOCK: 1X1 WHITE PIXEL AT THE FEET. CANNOT ENCODE A COUNT -- SEE REPORT',
};

// ---------------------------------------------------------------------------
// 极简排版引擎（两趟：先量高度，再画）
// ---------------------------------------------------------------------------

interface Op {
  readonly h: number;
  draw(c: PixelCanvas, y: number): void;
  /** 该版面块画了哪些精灵标签（供单测断言"一个都没漏"）。 */
  readonly titles?: readonly string[];
}

/** 按顺序堆叠的版面。 */
export class SheetBuilder {
  readonly width: number;
  /** 版面上出现过的全部精灵标签（确定顺序）。 */
  readonly titles: string[] = [];
  private readonly ops: Op[] = [];

  constructor(width: number) {
    this.width = width;
  }

  add(op: Op): void {
    this.ops.push(op);
    if (op.titles) this.titles.push(...op.titles);
  }

  get height(): number {
    let total = 0;
    for (const op of this.ops) total += op.h;
    return total;
  }

  render(bg: Rgba = SHEET_BG): PixelCanvas {
    const canvas = new PixelCanvas(this.width, this.height);
    canvas.fillRect(0, 0, this.width, this.height, bg);
    let y = 0;
    for (const op of this.ops) {
      op.draw(canvas, y);
      y += op.h;
    }
    return canvas;
  }
}

function opGap(h: number): Op {
  return { h, draw: () => undefined };
}

function opDivider(color: Rgba = FRAME_TICK): Op {
  return {
    h: 10,
    draw: (c, y) => c.fillRect(0, y + 4, c.width, 1, color),
  };
}

function opText(
  lines: readonly { text: string; color: Rgba; scale: number; indent?: number }[],
  padding = 8,
): Op {
  let h = padding;
  for (const l of lines) h += textHeight(l.scale) + 4;
  return {
    h,
    draw: (c, y) => {
      let cur = y + Math.floor(padding / 2);
      for (const l of lines) {
        drawText(c, l.indent ?? 16, cur, l.text, l.color, l.scale);
        cur += textHeight(l.scale) + 4;
      }
    },
  };
}

function opSection(title: string, caption?: string): Op {
  const captionH = caption ? textHeight(1) + 4 : 0;
  const h = textHeight(2) + captionH + 16;
  return {
    h,
    draw: (c, y) => {
      let cur = y + 6;
      drawText(c, 16, cur, title, TEXT_TITLE, 2);
      cur += textHeight(2) + 4;
      if (caption) drawText(c, 16, cur, caption, TEXT_DIM, 1);
      c.fillRect(0, y + h - 5, c.width, 1, FRAME_TICK);
    },
  };
}

/** 一个精灵单元格。 */
export interface Cell {
  readonly title: string;
  readonly lines: readonly string[];
  readonly frame: SpriteFrame;
  readonly cellWidth: number;
}

function drawFrameTicks(c: PixelCanvas, x: number, y: number, w: number, h: number): void {
  const L = 6;
  c.fillRect(x, y, L, 1, FRAME_TICK);
  c.fillRect(x, y, 1, L, FRAME_TICK);
  c.fillRect(x + w - L, y, L, 1, FRAME_TICK);
  c.fillRect(x + w - 1, y, 1, L, FRAME_TICK);
  c.fillRect(x, y + h - 1, L, 1, FRAME_TICK);
  c.fillRect(x, y + h - L, 1, L, FRAME_TICK);
  c.fillRect(x + w - L, y + h - 1, L, 1, FRAME_TICK);
  c.fillRect(x + w - 1, y + h - L, 1, L, FRAME_TICK);
}

/** 整数倍最近邻放大（零插值）。 */
function blitScaled(dst: PixelCanvas, frame: SpriteFrame, x: number, y: number, scale: number): void {
  for (let sy = 0; sy < frame.height; sy++) {
    for (let sx = 0; sx < frame.width; sx++) {
      const i = (sy * frame.width + sx) * 4;
      if (frame.pixels[i + 3] === 0) continue;
      const color: Rgba = [frame.pixels[i]!, frame.pixels[i + 1]!, frame.pixels[i + 2]!, frame.pixels[i + 3]!];
      dst.fillRect(x + sx * scale, y + sy * scale, scale, scale, color);
    }
  }
}

function opSpriteRow(cells: readonly Cell[], scale: number): Op {
  if (cells.length === 0) throw new Error('opSpriteRow 需要至少一个单元格');
  const band = Math.max(...cells.map((c) => c.frame.height)) * scale;
  const labelLines = 1 + Math.max(...cells.map((c) => c.lines.length));
  const h = band + labelLines * LINE_H + 26;
  const rowW = cells.reduce((a, c) => a + c.cellWidth, 0);
  if (rowW > SHEET_W) throw new Error(`一行放不下：${rowW} > ${SHEET_W}`);
  return {
    h,
    titles: cells.map((c) => c.title),
    draw: (c, y) => {
      let x = Math.floor((c.width - rowW) / 2);
      for (const cell of cells) {
        const cx = x + Math.floor(cell.cellWidth / 2);
        const sw = cell.frame.width * scale;
        const sh = cell.frame.height * scale;
        c.fillRect(x + 2, y + 6, cell.cellWidth - 4, h - 14, CELL_BG);
        const sy = y + 6 + Math.floor((band - sh) / 2);
        const sx = cx - Math.floor(sw / 2);
        drawFrameTicks(c, sx, sy, sw, sh);
        // 着地点（锚点）提示线：渲染层就是把这条线对齐到格子的
        const gy = sy + cell.frame.anchorY * scale;
        c.fillRect(sx, gy, sw, 1, GROUND_TICK);
        blitScaled(c, cell.frame, sx, sy, scale);
        let ly = y + 6 + band + 6;
        drawTextCentered(c, cx, ly, cell.title, TEXT, LABEL_SCALE);
        ly += LINE_H;
        for (const line of cell.lines) {
          drawTextCentered(c, cx, ly, line, TEXT_DIM, LABEL_SCALE);
          ly += LINE_H;
        }
        x += cell.cellWidth;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 单元格构造
// ---------------------------------------------------------------------------

function towerFrame(u: UnitArtInput, state: SpriteState = 'idle'): SpriteFrame {
  return renderTowerFrame(u, state);
}

function enemyFrame(e: EnemyArtInput, state: SpriteState = 'idle'): SpriteFrame {
  return renderEnemyFrame(e, state);
}

function towerCell(u: UnitArtInput, cellWidth: number, state: SpriteState = 'idle'): Cell {
  const meta = resolveLine(u.line);
  const extra: string[] = [];
  if ((u.block ?? 0) > 0) extra.push(`BLOCK:${u.block}`);
  extra.push((u.stealBase ?? 0) > 0 ? 'STEALS' : 'NO_STEAL');
  return {
    // ★ 必须 toUpperCase：5×7 位图字体只有大写字形 + 数字 + 少量标点。
    //   `units.json` 里的 id 全是小写，不转大写会整片渲染成"缺字方框"
    //   （这是 contact-sheet 单测抓出来的真实缺陷）。
    title: u.id.toUpperCase(),
    lines: [`LINE:${meta.label} T${u.tier}`, extra.join(' ')],
    frame: towerFrame(u, state),
    cellWidth,
  };
}

function enemyCell(e: EnemyArtInput, cellWidth: number, state: SpriteState = 'idle'): Cell {
  const armor = resolveArmor(e.armorType);
  const size = spriteSizeOf(enemyRank(e));
  const flags: string[] = [];
  if (e.flying) flags.push('FLYING');
  if (e.isBoss) flags.push('BOSS');
  if (inferElite(e)) flags.push('ELITE');
  if (e.stealResist > 0) {
    flags.push(e.stealResist >= 1000 ? 'STEAL_IMMUNE' : `STEAL_RESIST:${e.stealResist}`);
  }
  if (flags.length === 0) flags.push('NO_MARK');
  return {
    title: e.id.toUpperCase(),
    lines: [`ARMOR:${armor.label} ${size}X${size}`, flags.join(' ')],
    frame: enemyFrame(e, state),
    cellWidth,
  };
}

// ---------------------------------------------------------------------------
// 接触表本体
// ---------------------------------------------------------------------------

/** 接触表结果（像素缓冲，便于灰度/色盲变换与 PNG 编码）。 */
export interface ContactSheetResult {
  readonly width: number;
  readonly height: number;
  readonly color: Uint8ClampedArray;
  readonly gray: Uint8ClampedArray;
  readonly cvd: Uint8ClampedArray;
  readonly protan: Uint8ClampedArray;
  readonly cvdKind: CvdKind;
  /** 版面上出现过的全部精灵标签（用于断言覆盖面）。 */
  readonly titles: readonly string[];
}

/** CLI 会写出的文件（单测用它核对路径与数量）。 */
export const CONTACT_SHEET_FILES = [
  { name: 'contact-sheet.png', variant: 'color' },
  { name: 'contact-sheet-gray.png', variant: 'gray' },
  { name: 'contact-sheet-cvd.png', variant: 'cvd' },
  { name: 'contact-sheet-protan.png', variant: 'protan' },
] as const satisfies readonly { name: string; variant: 'color' | 'gray' | 'cvd' | 'protan' }[];

export interface ContactSheetOptions {
  readonly scale?: number;
}

/** 纯函数：给定内容生成接触表（CLI 与单测共用）。 */
export function buildContactSheet(content: ArtContentInput, options: ContactSheetOptions = {}): ContactSheetResult {
  const scale = options.scale ?? DEFAULT_SCALE;
  const b = new SheetBuilder(SHEET_W);

  // ---- 抬头 ----
  b.add(
    opText(
      [
        { text: 'GOLDVEIN TD - PLACEHOLDER ART CONTACT SHEET', color: TEXT_TITLE, scale: 2 },
        {
          text: `GENERATOR: src/art/procedural.ts v1  |  SPRITES: ${content.units.length} TOWERS + ${content.enemies.length} ENEMIES  |  SCALE: ${scale}X NEAREST  |  PIXELS: INTEGER COORDS, NO ANTIALIASING`,
          color: TEXT_DIM,
          scale: 1,
        },
        {
          text: 'NON-COLOR CHANNELS -- TOWER: SHAPE=LINE, TEETH=TIER | ENEMY: BORDER=ARMOR, WING+GAP=FLYING, RING=BOSS, STAR=ELITE, PADLOCK=STEAL_RESIST, PADLOCK+SLASH=IMMUNE',
          color: TEXT_DIM,
          scale: 1,
        },
      ],
      16,
    ),
  );
  b.add(opDivider());

  // ---- 图例 1：护甲边框（同一个本体，只换边框） ----
  b.add(opSection('LEGEND 1/4 -- ARMOR = BORDER STYLE', 'SAME BODY, ONLY THE BORDER CHANGES. LOOK AT THE GRAY SHEET.'));
  b.add(
    opSpriteRow(
      ARMOR_ORDER.map((armor) => {
        const meta = resolveArmor(armor);
        const sample: EnemyArtInput = {
          id: 'legend_armor',
          armorType: armor,
          flying: false,
          isBoss: false,
          stealResist: 0,
        };
        return {
          title: meta.label,
          lines: [BORDER_DESC[meta.style] ?? meta.style, `GRAY_LUMA:${luma(meta.color)}`],
          frame: enemyFrame(sample),
          cellWidth: 360,
        } satisfies Cell;
      }),
      scale,
    ),
  );

  // ---- 图例 2：塔系轮廓 ----
  b.add(opSection('LEGEND 2/4 -- TOWER LINE = SILHOUETTE', 'ALL SAMPLES ARE TIER 3, SO THE OUTLINE IS THE 2PX VARIANT.'));
  {
    const samples: Cell[] = LINE_ORDER.map((line) => {
      const meta = resolveLine(line);
      const unit: UnitArtInput = { id: `legend_line_${line}`, line, tier: 3 };
      return {
        title: meta.label,
        lines: [`SHAPE:${SHAPE_NAME[shapeForLine(line)]}`, `LUMA:${luma(meta.color)}`],
        frame: towerFrame(unit),
        cellWidth: 360,
      } satisfies Cell;
    });
    b.add(opSpriteRow(samples.slice(0, 5), scale));
    b.add(opGap(6));
    b.add(opSpriteRow(samples.slice(5), scale));
  }

  // ---- 图例 3：品阶齿数 ----
  b.add(opSection('LEGEND 3/4 -- TIER = TEETH COUNT (1-5) ON THE BASE', 'TIER >= 3 ALSO GETS A 2PX OUTLINE INSTEAD OF 1PX.'));
  b.add(
    opSpriteRow(
      [1, 2, 3, 4, 5].map((tier) => {
        const unit: UnitArtInput = { id: `legend_tier_${tier}`, line: 'mage', tier };
        return {
          title: `T${tier}`,
          lines: [`TEETH:${tier}`, `OUTLINE:${tier >= 3 ? '2PX' : '1PX'}`],
          frame: towerFrame(unit),
          cellWidth: 360,
        } satisfies Cell;
      }),
      scale,
    ),
  );

  // ---- 图例 4：属性标记 ----
  b.add(
    opSection(
      'LEGEND 4/4 -- ATTRIBUTE MARKS',
      'SAME BODY / SAME ARMOR. ONLY ONE FLAG DIFFERS PER CELL.',
    ),
  );
  b.add(
    opSpriteRow(
      (
        [
          { title: 'NO_MARK', e: { id: 'legend_mark', armorType: 'medium', flying: false, isBoss: false, stealResist: 0 } },
          { title: 'FLYING', e: { id: 'legend_mark', armorType: 'medium', flying: true, isBoss: false, stealResist: 0 } },
          { title: 'BOSS', e: { id: 'legend_mark', armorType: 'medium', flying: false, isBoss: true, stealResist: 0 } },
          { title: 'ELITE', e: { id: 'legend_mark', armorType: 'medium', flying: false, isBoss: false, stealResist: 0, dodge: 150 } },
          { title: 'RESIST:700', e: { id: 'legend_mark', armorType: 'medium', flying: false, isBoss: false, stealResist: 700 } },
          { title: 'IMMUNE:1000', e: { id: 'legend_mark', armorType: 'medium', flying: false, isBoss: false, stealResist: 1000 } },
        ] as const
      ).map((entry) => ({
        title: entry.title,
        lines: ['SIDE_EFFECT:NONE'],
        frame: enemyFrame(entry.e),
        cellWidth: 300,
      })),
      scale,
    ),
  );

  // ---- 血条 / 钱包条 ----
  b.add(
    opSection(
      'BARS -- HP / WALLET / BLOCK',
      'WALLET BAR IS THE SIGNATURE MECHANIC: GOLD ON A DARK SLOT WITH A 1PX RING. IT MUST STAY THE MOST VISIBLE STRIP.',
    ),
  );
  b.add(
    opSpriteRow(
      [
        { title: 'FULL', hp: 1000, wallet: 1000, blocked: false },
        { title: 'HALF_STOLEN', hp: 1000, wallet: 500, blocked: false },
        { title: 'ALMOST_EMPTY', hp: 400, wallet: 60, blocked: true },
        { title: 'BOSS_LAYOUT', hp: 800, wallet: 300, blocked: false, size: 96 },
      ].map((d) => {
        const size = d.size ?? 32;
        const demo = renderBarsDemo(size, d.hp, d.wallet, d.blocked);
        return {
          title: d.title,
          lines: [`HP:${d.hp}/1000 WALLET:${d.wallet}/1000`, d.blocked ? 'BLOCKED:MARKED' : 'BLOCKED:NO'],
          frame: demo,
          cellWidth: 450,
        } satisfies Cell;
      }),
      scale,
    ),
  );
  b.add(
    opText(
      BAR_SPECS.map((spec) => ({
        text: BAR_ASCII_NOTE[spec.id] ?? spec.id.toUpperCase(),
        color: TEXT_DIM,
        scale: 1,
        indent: 24,
      })),
      8,
    ),
  );

  // ---- 塔 ----
  const byLine = unitsByLine(content);
  b.add(
    opSection(
      `TOWERS -- ${content.units.length} TOTAL, GROUPED BY LINE, ORDERED BY TIER`,
      'SIZE 48X48 AT 4X. TEETH UNDER THE BODY = TIER.',
    ),
  );
  for (const line of LINE_ORDER) {
    const units = byLine.get(line);
    if (!units || units.length === 0) continue;
    const meta = resolveLine(line);
    b.add(
      opText(
        [
          {
            text: `${meta.label}  (${units.length})`,
            color: meta.color,
            scale: 2,
            indent: 16,
          },
        ],
        6,
      ),
    );
    b.add(opSpriteRow(units.map((u) => towerCell(u, 360)), scale));
  }
  // 未知塔系（防御性：数据里新增 line 时也要出图，不能静默漏掉）
  for (const [line, units] of byLine) {
    if ((LINE_ORDER as readonly string[]).includes(line)) continue;
    b.add(opText([{ text: `UNKNOWN_LINE:${line.toUpperCase()}  (${units.length})`, color: TEXT, scale: 2, indent: 16 }], 6));
    b.add(opSpriteRow(units.map((u) => towerCell(u, 360)), scale));
  }

  // ---- 敌人 ----
  b.add(
    opSection(
      `ENEMIES -- ${content.enemies.length} TOTAL`,
      'BORDER=ARMOR | WING+2PX GAP=FLYING | GOLD RING=BOSS | GOLD STAR=ELITE | PADLOCK=STEAL_RESIST',
    ),
  );
  {
    const normals = content.enemies.filter((e) => enemyRank(e) !== 'boss');
    const bosses = content.enemies.filter((e) => enemyRank(e) === 'boss');
    for (let i = 0; i < normals.length; i += 4) {
      b.add(opSpriteRow(normals.slice(i, i + 4).map((e) => enemyCell(e, 450)), scale));
      if (i + 4 < normals.length) b.add(opGap(6));
    }
    if (bosses.length > 0) {
      b.add(opText([{ text: `BOSS (${bosses.length})`, color: TEXT, scale: 2, indent: 16 }], 10));
      b.add(opSpriteRow(bosses.map((e) => enemyCell(e, 450)), scale));
    }
  }

  // ---- 状态帧 ----
  b.add(
    opSection('STATE FRAMES -- PROCEDURAL DEFORMATION (SCHEME 2.3)', 'NOT HAND-DRAWN: EACH STATE IS A TRANSFORM OF THE BASE POSE.'),
  );
  {
    const towerIdle: UnitArtInput = { id: 'master_thief', line: 'thief', tier: 3 };
    const enemyIdle: EnemyArtInput = {
      id: 'heavy_brute',
      armorType: 'heavy',
      flying: false,
      isBoss: false,
      stealResist: 0,
    };
    b.add(
      opSpriteRow(
        [
          towerCell(towerIdle, 360, 'idle'),
          towerCell(towerIdle, 360, 'attack'),
          towerCell(towerIdle, 360, 'upgrade'),
          enemyCell(enemyIdle, 360, 'idle'),
          enemyCell(enemyIdle, 360, 'walk'),
        ],
        scale,
      ),
    );
  }

  // ---- 页脚 ----
  b.add(opDivider());
  b.add(
    opText(
      [
        {
          text: 'ACCEPTANCE: ALL ATTRIBUTES MUST REMAIN DISTINGUISHABLE IN THE GRAY AND CVD SHEETS.',
          color: TEXT_DIM,
          scale: 1,
        },
        {
          text: 'SIZES: TOWER 48 | ENEMY 32 | ELITE 48 | BOSS 96 | BAR HEIGHT 1PX',
          color: TEXT_DIM,
          scale: 1,
        },
      ],
      12,
    ),
  );

  const canvas = b.render();
  const color = canvas.data.slice();
  return {
    width: canvas.width,
    height: canvas.height,
    color,
    gray: toGrayscale(color),
    cvd: toCvd(color, 'deuteranopia'),
    protan: toCvd(color, 'protanopia'),
    cvdKind: 'deuteranopia',
    titles: b.titles,
  };}

/** 把接触表结果编码成 PNG 字节。 */
export function pngOf(result: ContactSheetResult, variant: 'color' | 'gray' | 'cvd' | 'protan'): Uint8Array {
  return encodePng(result[variant], result.width, result.height);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const content = loadContent();
  const result = buildContactSheet(content);
  mkdirSync(OUT_DIR, { recursive: true });

  const files = CONTACT_SHEET_FILES;

  console.log(`contact sheet: ${result.width}x${result.height}, scale ${DEFAULT_SCALE}x`);
  for (const f of files) {
    const bytes = pngOf(result, f.variant);
    const path = resolve(OUT_DIR, f.name);
    writeFileSync(path, bytes);
    console.log(`  ${path}  ${bytes.length} bytes`);
  }

  console.log('\npalette luma (Rec.709, 0-255) -- gray-sheet separation:');
  for (const line of LINE_ORDER) {
    const meta = resolveLine(line);
    console.log(`  line ${meta.label.padEnd(8)} ${String(luma(meta.color)).padStart(3)}`);
  }
  for (const armor of ARMOR_ORDER) {
    const meta = resolveArmor(armor);
    console.log(`  armor ${meta.label.padEnd(10)} ${String(luma(meta.color)).padStart(3)}  (${meta.style})`);
  }
  console.log(`\nsprites: ${content.units.length} towers + ${content.enemies.length} enemies`);
}

const entry = process.argv[1];
const thisFile = fileURLToPath(import.meta.url);
if (entry !== undefined && resolve(entry).toLowerCase() === resolve(thisFile).toLowerCase()) {
  main();
}
