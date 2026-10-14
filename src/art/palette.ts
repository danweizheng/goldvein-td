/**
 * 色板与颜色工具（方案 §2 的编码表 + §2.5 无障碍要求）。
 *
 * 三件事：
 * 1. **冻结的塔系色板 / 护甲色板**（方案 §2.1 / §2.2 的十六进制值，逐字照抄）。
 * 2. 颜色工具（整数运算，无浮点抖动）：`shade` / `mix` / `grayOf` / `luma`。
 * 3. **灰度**与**红绿色盲模拟**变换 —— 接触表要输出这两种版本，
 *    用来证明"关键信息不是只靠色相编码"。
 *
 * ⚠️ 本模块**零 Phaser 依赖**，可在 Node 里裸跑。
 */
import type { Rgba } from './types';

export type { Rgba };

/** 9 大塔系（`src/data/units.json` 的 `line` 取值）。 */
export type TowerLine =
  | 'thief'
  | 'archer'
  | 'mage'
  | 'drill'
  | 'beauty'
  | 'cannon'
  | 'worker'
  | 'sprite'
  | 'tech';

/** 5 类护甲（`src/data/enemies.json` 的 `armorType` 取值）。 */
export type ArmorType = 'light' | 'medium' | 'heavy' | 'fortified' | 'divine';

// ---------------------------------------------------------------------------
// 基础构造
// ---------------------------------------------------------------------------

/** 由 `#rrggbb` 构造不透明 RGBA。 */
export function rgb(hex: string, alpha = 255): Rgba {
  const v = hex.startsWith('#') ? hex.slice(1) : hex;
  if (v.length !== 6) throw new Error(`非法颜色字面量：${hex}`);
  return [
    Number.parseInt(v.slice(0, 2), 16),
    Number.parseInt(v.slice(2, 4), 16),
    Number.parseInt(v.slice(4, 6), 16),
    alpha,
  ];
}

/** 显式分量构造（全部 0–255 整数）。 */
export function rgba(r: number, g: number, b: number, a = 255): Rgba {
  return [clamp255(r), clamp255(g), clamp255(b), clamp255(a)];
}

function clamp255(v: number): number {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return Math.round(v);
}

/** 按千分比混色：`t = 0` 取 `a`，`t = 1000` 取 `b`。整数路径。 */
export function mix(a: Rgba, b: Rgba, t: number): Rgba {
  const k = Math.max(0, Math.min(1000, Math.round(t)));
  const inv = 1000 - k;
  return [
    Math.round((a[0] * inv + b[0] * k) / 1000),
    Math.round((a[1] * inv + b[1] * k) / 1000),
    Math.round((a[2] * inv + b[2] * k) / 1000),
    Math.round((a[3] * inv + b[3] * k) / 1000),
  ];
}

/** 提亮（`pct > 0`）或压暗（`pct < 0`），按千分比朝白/黑插值。 */
export function shade(c: Rgba, pct: number): Rgba {
  const target: Rgba = pct >= 0 ? [255, 255, 255, c[3]] : [0, 0, 0, c[3]];
  return mix(c, target, Math.abs(pct));
}

/** 与背景做 alpha 混合（源覆盖），用于半透明阴影之类的场合。 */
export function over(src: Rgba, dst: Rgba): Rgba {
  const sa = src[3] / 255;
  const da = dst[3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return [0, 0, 0, 0];
  return [
    Math.round((src[0] * sa + dst[0] * da * (1 - sa)) / oa),
    Math.round((src[1] * sa + dst[1] * da * (1 - sa)) / oa),
    Math.round((src[2] * sa + dst[2] * da * (1 - sa)) / oa),
    Math.round(oa * 255),
  ];
}

// ---------------------------------------------------------------------------
// 中性色（UI / 描边 / 底板）
// ---------------------------------------------------------------------------

/** 描边墨色：所有塔的轮廓线。深到足以在任何塔系底色上形成剪影。 */
export const INK: Rgba = rgb('#12151f');
/** 敌人本体填充色。刻意低饱和、低亮度 —— 把"色相"让给护甲边框与标记。 */
export const ENEMY_BODY: Rgba = rgb('#262b38');
/** 敌人本体高光（左上 1px）。 */
export const ENEMY_BODY_HI: Rgba = rgb('#3d4457');
/** 敌人"钱包核心"的暗色腹纹（只比本体暗一档：职责是唯一性，不抢语义通道）。 */
export const ENEMY_CORE_DARK: Rgba = rgb('#1b1f2a');
/** 眼白 / 亮部（非颜色通道的对比来源）。 */
export const HILIGHT: Rgba = rgb('#f2f4f8');
/**
 * 底座 / 基座。
 *
 * 刻意用**暖棕**而不是中性灰蓝：护甲色板里 `heavy`(#606878) 与 `fortified`(#4a8a9a)
 * 就是灰蓝/铁青，中性灰的底座会与它们撞色（ASCII 预览暴露过这个问题）。
 * 暖棕与 5 种护甲色、9 种塔系色的 L1 距离都足够远。
 */
export const PLINTH: Rgba = rgb('#4a3b2a');
/** 底座上沿的亮边（与底座同色系，避免与护甲色撞车）。 */
export const PLINTH_EDGE: Rgba = rgb('#6b573d');
/** 接触表背景。 */
export const SHEET_BG: Rgba = rgb('#101219');
/** 接触表单元格背景（比整页稍亮，便于看出精灵边界，但仍要压得住底座）。 */
export const CELL_BG: Rgba = rgb('#161a24');
/** 帧范围角标（说明 32/48/96 的实际画布）。 */
export const FRAME_TICK: Rgba = rgb('#2c3242');
/** 排版文字色。 */
export const TEXT: Rgba = rgb('#cfd6e6');
/** 排版次要文字色。 */
export const TEXT_DIM: Rgba = rgb('#7d879e');
/** 标题色。 */
export const TEXT_TITLE: Rgba = rgb('#ffd77a');

/** 金色 —— BOSS 环 / 精英星 / 钱包条统一用它（方案 §2.2 / §2.4）。 */
export const GOLD: Rgba = rgb('#ffc832');

/** HP 条低血色 / 高血色（§2.4「红→绿渐变」）。 */
export const HP_LOW: Rgba = rgb('#e04438');
export const HP_MID: Rgba = rgb('#e0c038');
export const HP_HIGH: Rgba = rgb('#48c85a');
/** 钱包条底槽（比金条暗，保证金条在暗背景上"最醒目"）。 */
export const WALLET_SLOT: Rgba = rgb('#241d0a');
/** 钱包条外圈（1px），让 1px 金条在杂乱背景上也能被定位。 */
export const WALLET_RING: Rgba = rgb('#0d0b04');

// ---------------------------------------------------------------------------
// 塔系色板（方案 §2.1，冻结）
// ---------------------------------------------------------------------------

export interface LineMeta {
  /** 是否在冻结色板里（false = 新塔系的兜底，见 `resolveLine`）。 */
  readonly known: boolean;
  /** 基础色。 */
  readonly color: Rgba;
  /** 轮廓形状 id（形状 = 系，§2.1）。 */
  readonly glyph: '◆' | '▲' | '⬢' | '■' | '●' | '⬣' | '▣' | '∴' | '✚';
  /** 接触表上的英文名。 */
  readonly label: string;
  /** 该系在方案表格里的顺序（接触表排序用）。 */
  readonly order: number;
}

/** 方案 §2.1 的 9 系色板。十六进制值与方案逐字一致。 */
export const LINE_META: Readonly<Record<TowerLine, LineMeta>> = {
  thief: { known: true, color: rgb('#ffc832'), glyph: '◆', label: 'THIEF', order: 0 },
  archer: { known: true, color: rgb('#7ec850'), glyph: '▲', label: 'ARCHER', order: 1 },
  mage: { known: true, color: rgb('#4aa8e0'), glyph: '⬢', label: 'MAGE', order: 2 },
  drill: { known: true, color: rgb('#c85a50'), glyph: '■', label: 'DRILL', order: 3 },
  beauty: { known: true, color: rgb('#b06ee0'), glyph: '●', label: 'BEAUTY', order: 4 },
  cannon: { known: true, color: rgb('#e08a30'), glyph: '⬣', label: 'CANNON', order: 5 },
  worker: { known: true, color: rgb('#9a9a9a'), glyph: '▣', label: 'WORKER', order: 6 },
  sprite: { known: true, color: rgb('#c8a050'), glyph: '∴', label: 'SPRITE', order: 7 },
  tech: { known: true, color: rgb('#e8e8e8'), glyph: '✚', label: 'TECH', order: 8 },
};

/** 未知塔系的兜底色（灰度约 55%，与 9 个已知系都不撞）。 */
const UNKNOWN_LINE_COLOR: Rgba = rgb('#7a8a6a');

const UNKNOWN_LINE_META: LineMeta = {
  known: false,
  color: UNKNOWN_LINE_COLOR,
  glyph: '⬢',
  label: 'UNKNOWN',
  order: 99,
};

/**
 * 取塔系元数据。**未知塔系不抛异常** —— 铁律 5「数据驱动」要求
 * `units.json` 里新增一行就能出图，不能因为加了新 `line` 就让整套生成崩掉。
 */
export function resolveLine(line: string): LineMeta {
  return (LINE_META as Record<string, LineMeta | undefined>)[line] ?? UNKNOWN_LINE_META;
}

/** 全部已知塔系，按方案表格顺序。 */
export const LINE_ORDER: readonly TowerLine[] = (
  Object.keys(LINE_META) as TowerLine[]
).sort((a, b) => LINE_META[a].order - LINE_META[b].order);

// ---------------------------------------------------------------------------
// 护甲色板（方案 §2.2，冻结）
// ---------------------------------------------------------------------------

/** 边框画法（**非颜色通道**：护甲的首要区分手段）。 */
export type BorderStyle = 'dashed' | 'solid1' | 'solid2' | 'double' | 'divine';

export interface ArmorMeta {
  readonly known: boolean;
  /** 边框色。 */
  readonly color: Rgba;
  /** 边框画法。 */
  readonly style: BorderStyle;
  readonly label: string;
  readonly order: number;
}

export const ARMOR_META: Readonly<Record<ArmorType, ArmorMeta>> = {
  light: { known: true, color: rgb('#8fa8c8'), style: 'dashed', label: 'LIGHT', order: 0 },
  medium: { known: true, color: rgb('#8fc8a0'), style: 'solid1', label: 'MEDIUM', order: 1 },
  heavy: { known: true, color: rgb('#606878'), style: 'solid2', label: 'HEAVY', order: 2 },
  fortified: { known: true, color: rgb('#4a8a9a'), style: 'double', label: 'FORTIFIED', order: 3 },
  divine: { known: true, color: rgb('#f0f0f0'), style: 'divine', label: 'DIVINE', order: 4 },
};

const UNKNOWN_ARMOR_COLOR: Rgba = rgb('#b07ac8');

const UNKNOWN_ARMOR_META: ArmorMeta = {
  known: false,
  color: UNKNOWN_ARMOR_COLOR,
  style: 'solid1',
  label: 'UNKNOWN',
  order: 99,
};

/** 取护甲元数据（未知护甲同样不抛异常）。 */
export function resolveArmor(armor: string): ArmorMeta {
  return (ARMOR_META as Record<string, ArmorMeta | undefined>)[armor] ?? UNKNOWN_ARMOR_META;
}

/** 全部已知护甲，按方案表格顺序。 */
export const ARMOR_ORDER: readonly ArmorType[] = (
  Object.keys(ARMOR_META) as ArmorType[]
).sort((a, b) => ARMOR_META[a].order - ARMOR_META[b].order);

// ---------------------------------------------------------------------------
// 明度 / 灰度
// ---------------------------------------------------------------------------

/** Rec.709 相对亮度 ×1000（整数，便于断言）。 */
export function luma(c: Rgba): number {
  return Math.round((2126 * c[0] + 7152 * c[1] + 722 * c[2]) / 10000);
}

/** 单色去色（等亮度灰）。 */
export function grayOf(c: Rgba): Rgba {
  const v = luma(c);
  return [v, v, v, c[3]];
}

/** 整张 RGBA 去色（保留 alpha）。 */
export function toGrayscale(pixels: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const v = Math.round((2126 * pixels[i] + 7152 * pixels[i + 1] + 722 * pixels[i + 2]) / 10000);
    out[i] = v;
    out[i + 1] = v;
    out[i + 2] = v;
    out[i + 3] = pixels[i + 3];
  }
  return out;
}

// ---------------------------------------------------------------------------
// 色觉缺陷（CVD）模拟
// ---------------------------------------------------------------------------

export type CvdKind = 'protanopia' | 'deuteranopia' | 'tritanopia';

/**
 * Machado et al. 2009 的 severity 1.0 矩阵，作用在**线性 RGB** 上。
 * 红绿色盲 = protanopia（红盲）与 deuteranopia（绿盲）；deuteranopia 最常见，
 * 因此接触表的 `contact-sheet-cvd.png` 默认用 deuteranopia。
 */
const CVD_MATRIX: Record<CvdKind, readonly number[]> = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};

/**
 * sRGB ↔ 线性光的查表（**性能关键**）。
 *
 * 接触表是 1800×6400 ≈ 1150 万像素，每像素还要跑 3 个通道的幂运算 ——
 * 直接算 `**2.4` 会让一次接触表生成多花好几秒（实测 CVD 变换占了总耗时一半以上）。
 * 这里把 256 个 sRGB 值与 1001 个线性值预先展开成表，
 * 变换退化成纯查表 + 乘加，数值结果与公式**逐位一致**。
 */
const SRGB_TO_LINEAR1000 = (() => {
  const table = new Int32Array(256);
  for (let v = 0; v < 256; v++) {
    const s = v / 255;
    const lin = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    table[v] = Math.round(lin * 1000);
  }
  return table;
})();

const LINEAR1000_TO_SRGB = (() => {
  const table = new Uint8Array(1001);
  for (let v = 0; v <= 1000; v++) {
    const lin = v / 1000;
    const s = lin <= 0.0031308 ? lin * 12.92 : 1.055 * lin ** (1 / 2.4) - 0.055;
    table[v] = Math.max(0, Math.min(255, Math.round(s * 255)));
  }
  return table;
})();

/** sRGB 分量（0–255）→ 线性光（0–1000 整数）。 */
function srgbToLinear1000(v: number): number {
  return SRGB_TO_LINEAR1000[Math.max(0, Math.min(255, v | 0))]!;
}

/** 线性光（0–1000）→ sRGB 分量（0–255）。 */
function linear1000ToSrgb(v: number): number {
  return LINEAR1000_TO_SRGB[Math.max(0, Math.min(1000, v | 0))]!;
}

/** 单色色觉缺陷模拟。 */
export function cvdOf(c: Rgba, kind: CvdKind): Rgba {
  const m = CVD_MATRIX[kind];
  const r = srgbToLinear1000(c[0]);
  const g = srgbToLinear1000(c[1]);
  const b = srgbToLinear1000(c[2]);
  return [
    linear1000ToSrgb(Math.round(m[0] * r + m[1] * g + m[2] * b)),
    linear1000ToSrgb(Math.round(m[3] * r + m[4] * g + m[5] * b)),
    linear1000ToSrgb(Math.round(m[6] * r + m[7] * g + m[8] * b)),
    c[3],
  ];
}

/** 整张 RGBA 做色觉缺陷模拟（保留 alpha）。 */
export function toCvd(pixels: Uint8ClampedArray, kind: CvdKind): Uint8ClampedArray {
  const m = CVD_MATRIX[kind];
  const out = new Uint8ClampedArray(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const r = srgbToLinear1000(pixels[i]!);
    const g = srgbToLinear1000(pixels[i + 1]!);
    const b = srgbToLinear1000(pixels[i + 2]!);
    out[i] = linear1000ToSrgb(Math.round(m[0]! * r + m[1]! * g + m[2]! * b));
    out[i + 1] = linear1000ToSrgb(Math.round(m[3]! * r + m[4]! * g + m[5]! * b));
    out[i + 2] = linear1000ToSrgb(Math.round(m[6]! * r + m[7]! * g + m[8]! * b));
    out[i + 3] = pixels[i + 3]!;
  }
  return out;
}
