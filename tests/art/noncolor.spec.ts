/**
 * **非颜色通道有效性**（方案 §2.5 无障碍要求 + §5 的 M2 验收标准 ③）。
 *
 * 方案原文：**「任何关键信息不得只靠色相编码。」** 验收方式是接触表同时输出
 * 灰度版与红绿色盲模拟版，在两者下仍能区分全部属性。
 *
 * 这里把"能不能区分"变成**可断言的像素计数**，而不是肉眼看图：
 *
 * | 指标 | 含义 | 为什么需要它 |
 * |---|---|---|
 * | `structuralDiff` | 两个精灵"不透明/透明"状态不同的像素数 | 纯剪影差异，**与颜色完全无关** |
 * | `grayDiff` | 去色后亮度差 > 16 的像素数 | 灰度版里"看起来是否不同" |
 * | `cvdDiff` | 红绿色盲模拟后 RGB 距离 > 16 的像素数 | 色盲版里"看起来是否不同" |
 *
 * 只要 `structuralDiff > 0` 且达到可数阈值，就说明该属性的信息**存在形状通道**，
 * 不依赖色相。阈值取"4× 放大后肉眼可数"的量级，并在注释里注明实测值。
 */
import { describe, expect, it } from 'vitest';

import enemiesJson from '../../src/data/enemies.json';
import unitsJson from '../../src/data/units.json';
import {
  normalizeContent,
  type ArtContentInput,
  type EnemyArtInput,
  type UnitArtInput,
} from '../../src/art/content';
import { ARMOR_ORDER, LINE_ORDER, luma, resolveArmor, resolveLine, toCvd, toGrayscale } from '../../src/art/palette';
import {
  enemyGeometry,
  renderEnemyFrame,
  renderTowerFrame,
  type SpriteFrame,
} from '../../src/art/procedural';
import { bossRingMask, padlockMask, starMask } from '../../src/art/marks';
import { BORDER_REACH, borderMask, chebyshevDistance, cornerTicksMask, shapeMask } from '../../src/art/shapes';

const content: ArtContentInput = normalizeContent({
  units: unitsJson as unknown as UnitArtInput[],
  enemies: enemiesJson as unknown as EnemyArtInput[],
});

/** 亮度/通道差的可见阈值（0–255）。16 ≈ 6% 动态范围，明显可辨。 */
const VISIBLE = 16;

function sameSize(a: SpriteFrame, b: SpriteFrame): boolean {
  return a.width === b.width && a.height === b.height;
}

/** 纯剪影差异：一个不透明、另一个透明的像素数（与颜色、亮度完全无关）。 */
export function structuralDiff(a: SpriteFrame, b: SpriteFrame): number {
  if (!sameSize(a, b)) return Number.POSITIVE_INFINITY;
  let n = 0;
  for (let i = 3; i < a.pixels.length; i += 4) {
    const oa = a.pixels[i]! > 0;
    const ob = b.pixels[i]! > 0;
    if (oa !== ob) n++;
  }
  return n;
}

/** 去色后的亮度差异计数。 */
export function grayDiff(a: SpriteFrame, b: SpriteFrame, threshold = VISIBLE): number {
  if (!sameSize(a, b)) return Number.POSITIVE_INFINITY;
  const ga = toGrayscale(a.pixels);
  const gb = toGrayscale(b.pixels);
  return channelDiff(ga, gb, a.pixels, b.pixels, threshold, 1);
}

/** 红绿色盲（deuteranopia）模拟后的差异计数。 */
export function cvdDiff(a: SpriteFrame, b: SpriteFrame, threshold = VISIBLE): number {
  if (!sameSize(a, b)) return Number.POSITIVE_INFINITY;
  const ca = toCvd(a.pixels, 'deuteranopia');
  const cb = toCvd(b.pixels, 'deuteranopia');
  return channelDiff(ca, cb, a.pixels, b.pixels, threshold, 3);
}

function channelDiff(
  pa: Uint8ClampedArray,
  pb: Uint8ClampedArray,
  alphaA: Uint8ClampedArray,
  alphaB: Uint8ClampedArray,
  threshold: number,
  channels: number,
): number {
  let n = 0;
  for (let i = 0; i < pa.length; i += 4) {
    const oa = alphaA[i + 3]! > 0;
    const ob = alphaB[i + 3]! > 0;
    if (oa !== ob) {
      n++;
      continue;
    }
    if (!oa) continue;
    let maxDelta = 0;
    for (let c = 0; c < channels; c++) maxDelta = Math.max(maxDelta, Math.abs(pa[i + c]! - pb[i + c]!));
    if (maxDelta > threshold) n++;
  }
  return n;
}

const towerOf = (line: string, tier: number, id = `probe_${line}`): SpriteFrame =>
  renderTowerFrame({ id, line, tier }, 'idle');

const enemyOf = (patch: Partial<EnemyArtInput>): SpriteFrame =>
  renderEnemyFrame(
    { id: 'channel_probe', armorType: 'medium', flying: false, isBoss: false, stealResist: 0, ...patch },
    'idle',
  );

function minPairwise(
  items: readonly { label: string; frame: SpriteFrame }[],
  metric: (a: SpriteFrame, b: SpriteFrame) => number,
): { min: number; pair: string } {
  let min = Number.POSITIVE_INFINITY;
  let pair = '';
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const d = metric(items[i]!.frame, items[j]!.frame);
      if (d < min) {
        min = d;
        pair = `${items[i]!.label} vs ${items[j]!.label}`;
      }
    }
  }
  return { min, pair };
}

describe('色板自检：说明"哪些属性在灰度下本来就分不开"', () => {
  it('塔系颜色的灰度亮度高度重叠 —— 因此形状必须是主通道', () => {
    const table = LINE_ORDER.map((line) => ({ line, luma: luma(resolveLine(line).color) }));
    // 打印出来作为交付证据（汇报里会引用这张表）
    console.log('[gray luma] tower lines:', table.map((t) => `${t.line}=${t.luma}`).join(' '));
    const closePairs: string[] = [];
    for (let i = 0; i < table.length; i++) {
      for (let j = i + 1; j < table.length; j++) {
        if (Math.abs(table[i]!.luma - table[j]!.luma) < VISIBLE) {
          closePairs.push(`${table[i]!.line}/${table[j]!.line}(${Math.abs(table[i]!.luma - table[j]!.luma)})`);
        }
      }
    }
    console.log('[gray luma] tower line pairs closer than', VISIBLE, ':', closePairs.join(' ') || '(none)');
    // 事实：塔系色板在灰度下**不足以**区分全部 9 系（这是方案要求形状通道的原因）。
    expect(closePairs.length).toBeGreaterThan(0);
  });

  it('护甲边框色的灰度亮度彼此分开（最小间隔 ≥ 16）', () => {
    const table = ARMOR_ORDER.map((armor) => ({ armor, luma: luma(resolveArmor(armor).color) }));
    console.log('[gray luma] armor:', table.map((t) => `${t.armor}=${t.luma}`).join(' '));
    for (let i = 0; i < table.length; i++) {
      for (let j = i + 1; j < table.length; j++) {
        expect(
          Math.abs(table[i]!.luma - table[j]!.luma),
          `${table[i]!.armor} vs ${table[j]!.armor} 灰度亮度太接近`,
        ).toBeGreaterThanOrEqual(VISIBLE);
      }
    }
  });
});

describe('塔系（形状通道）：去色 + 色盲下仍可区分 9 系', () => {
  const items = LINE_ORDER.map((line) => ({ label: line, frame: towerOf(line, 3) }));

  it('任意两系的剪影差异 ≥ 40px（纯形状，与颜色无关）', () => {
    const { min, pair } = minPairwise(items, structuralDiff);
    console.log('[tower lines] min structuralDiff =', min, 'at', pair);
    expect(min, `最接近的一对：${pair}`).toBeGreaterThanOrEqual(40);
  });

  it('灰度版任意两系的可见差异 ≥ 40px', () => {
    const { min, pair } = minPairwise(items, grayDiff);
    console.log('[tower lines] min grayDiff =', min, 'at', pair);
    expect(min, `最接近的一对：${pair}`).toBeGreaterThanOrEqual(40);
  });

  it('红绿色盲版任意两系的可见差异 ≥ 40px', () => {
    const { min, pair } = minPairwise(items, cvdDiff);
    console.log('[tower lines] min cvdDiff =', min, 'at', pair);
    expect(min, `最接近的一对：${pair}`).toBeGreaterThanOrEqual(40);
  });
});

describe('品阶（齿数通道）：去色 + 色盲下仍可数出 1–5', () => {
  const items = [1, 2, 3, 4, 5].map((tier) => ({ label: `T${tier}`, frame: towerOf('mage', tier, 'probe_mage') }));

  it('齿数差异是**图案/亮度**通道（不是剪影通道）—— 先把这个事实钉住', () => {
    // 齿画在**已经不透明的底座内部**，所以两个品阶的不透明像素集合几乎一致；
    // 品阶靠的是"底座上有几个亮块"这一亮度图案。这正是它能在灰度下存活的原因，
    // 但也意味着：它不能像"轮廓"那样靠 alpha 通道判定。
    const a = structuralDiff(items[0]!.frame, items[1]!.frame);
    console.log('[tiers] T1 vs T2 structuralDiff (应为 0：齿在底座内部) =', a);
    expect(a).toBe(0);
  });

  it('相邻品阶的灰度可见差异 ≥ 9px（齿宽 4 + 齿距 2 的实测下限）', () => {
    let min = Number.POSITIVE_INFINITY;
    let pair = '';
    for (let i = 0; i + 1 < items.length; i++) {
      const d = grayDiff(items[i]!.frame, items[i + 1]!.frame);
      if (d < min) {
        min = d;
        pair = `${items[i]!.label} vs ${items[i + 1]!.label}`;
      }
    }
    console.log('[tiers] min grayDiff =', min, 'at', pair);
    expect(min, `最接近的一对：${pair}`).toBeGreaterThanOrEqual(9);
  });

  it('红绿色盲版相邻品阶可见差异 ≥ 9px', () => {
    let min = Number.POSITIVE_INFINITY;
    let pair = '';
    for (let i = 0; i + 1 < items.length; i++) {
      const d = cvdDiff(items[i]!.frame, items[i + 1]!.frame);
      if (d < min) {
        min = d;
        pair = `${items[i]!.label} vs ${items[i + 1]!.label}`;
      }
    }
    console.log('[tiers] min cvdDiff =', min, 'at', pair);
    expect(min, `最接近的一对：${pair}`).toBeGreaterThanOrEqual(9);
  });

  it('全部 5 个品阶两两都有可见差异', () => {
    const { min, pair } = minPairwise(items, grayDiff);
    expect(min, `最接近的一对：${pair}`).toBeGreaterThanOrEqual(9);
  });
});

// ⚠️ 这里原先有一组「护甲：任意两种护甲整帧差异 ≥ 25px」的断言。
// 它**全绿但什么都没证明**：整帧差异（219–375px）全部来自本体形状（id 哈希抖动、
// 眼、腹纹），护甲边框在其中的贡献被淹没 —— 逐像素复核时甚至能构造出
// "边框完全不同、整帧差异却很大"的情形。
// 护甲通道的断言已按「只取外圈环带 ∪ 四角刻痕区」重写到
// `tests/art/channels.spec.ts`，并配了负对照 / 正对照 / 区域敏感对照。
// 保留在此的只有**掩码级**证据（下面的 describe 块），它天然是区域隔离的。

describe('属性标记：每个标记在灰度/色盲下都是形状差异', () => {
  const baseline = enemyOf({});
  // 同尺寸（32×32）的标记：可以直接逐像素比。
  // BOSS / 精英**同时改变帧尺寸**（32→96 / 32→48），尺寸本身就是第一通道，
  // 因此它们的环比/星点单独在下面的"标记字形"里做掩码级断言。
  const marks: { label: string; frame: SpriteFrame; minStructural: number }[] = [
    { label: 'flying', frame: enemyOf({ flying: true }), minStructural: 40 },
    { label: 'stealResist700', frame: enemyOf({ stealResist: 700 }), minStructural: 20 },
    { label: 'stealImmune1000', frame: enemyOf({ stealResist: 1000 }), minStructural: 20 },
  ];

  it('BOSS / 精英的第一通道是帧尺寸（32→96 / 32→48）', () => {
    expect(enemyOf({}).width).toBe(32);
    expect(enemyOf({ isElite: true }).width).toBe(48);
    expect(enemyOf({ isBoss: true }).width).toBe(96);
  });

  for (const mark of marks) {
    it(`${mark.label} 与基准的剪影差异 ≥ ${mark.minStructural}px`, () => {
      const s = structuralDiff(baseline, mark.frame);
      console.log(`[mark ${mark.label}] structuralDiff =`, s);
      expect(s).toBeGreaterThanOrEqual(mark.minStructural);
    });

    it(`${mark.label} 在灰度版可见（≥ ${Math.round(mark.minStructural / 2)}px）`, () => {
      const g = grayDiff(baseline, mark.frame);
      console.log(`[mark ${mark.label}] grayDiff =`, g);
      expect(g).toBeGreaterThanOrEqual(Math.round(mark.minStructural / 2));
    });

    it(`${mark.label} 在红绿色盲版可见（≥ ${Math.round(mark.minStructural / 2)}px）`, () => {
      const c = cvdDiff(baseline, mark.frame);
      console.log(`[mark ${mark.label}] cvdDiff =`, c);
      expect(c).toBeGreaterThanOrEqual(Math.round(mark.minStructural / 2));
    });
  }

  it('窃金抗性 700 与免疫 1000 必须能分开（最弱的一条通道）', () => {
    const resist = enemyOf({ stealResist: 700 });
    const immune = enemyOf({ stealResist: 1000 });
    const s = structuralDiff(resist, immune);
    const g = grayDiff(resist, immune);
    const c = cvdDiff(resist, immune);
    console.log('[mark resist-vs-immune] structuralDiff =', s, 'grayDiff =', g, 'cvdDiff =', c);
    // 斜杠切的是**锁身内部的亮度图案**（刀口），不改锁的剪影，
    // 所以 structuralDiff 很小是设计使然 —— 真正的可辨性由灰度/色盲差异承担。
    expect(g).toBeGreaterThanOrEqual(12);
    expect(c).toBeGreaterThanOrEqual(12);
  });
});

describe('标记字形的掩码级证据（不经过颜色）', () => {
  it('BOSS 金环：96 帧里是一圈实环，且落在护甲边框之外', () => {
    const size = 96;
    const geo = enemyGeometry(size);
    const body = shapeMask('circle', size, size, 48, 46, geo.baseRadius);
    const dist = chebyshevDistance(body);
    const ring = bossRingMask(dist, size, size, 7, 8);
    let count = 0;
    let minDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < dist.length; i++) {
      if (ring.bits[i]) {
        count++;
        minDistance = Math.min(minDistance, dist[i]!);
      }
    }
    console.log('[boss ring] px =', count, 'minDistance =', minDistance);
    expect(count).toBeGreaterThan(150);
    // 必须避开最宽的护甲边框（double 最大外扩 5px）
    expect(minDistance).toBeGreaterThan(BORDER_REACH.double);
  });

  it('精英星点：7×7 菱形星，25 个实心像素（可数，不依赖颜色）', () => {
    expect(starMask(7).count()).toBe(25);
    expect(starMask(9).count()).toBe(41);
  });

  it('挂锁字形与斜杠：斜杠确实切在锁身上', () => {
    const { lock, slash } = padlockMask(true);
    const plain = padlockMask(false);
    expect(plain.slash.count()).toBe(0);
    let cut = 0;
    for (let i = 0; i < lock.bits.length; i++) if (lock.bits[i] && slash.bits[i]) cut++;
    console.log('[padlock] lock px =', lock.count(), 'slash px =', slash.count(), 'cut px =', cut);
    expect(lock.count()).toBeGreaterThanOrEqual(25);
    expect(cut).toBeGreaterThanOrEqual(6);
  });

  it('神圣甲四角刻痕：4 个角各有一段 L 形金痕', () => {
    const ticks = cornerTicksMask(32, 32, 4, 2);
    console.log('[divine corners] px =', ticks.count());
    expect(ticks.count()).toBeGreaterThanOrEqual(40);
  });

  it('护甲边框的占用距离带彼此不同（虚线/实线/双层/刻痕）', () => {
    const body = shapeMask('circle', 32, 32, 16, 16, 8);
    const reach: Record<string, number> = {};
    for (const armor of ARMOR_ORDER) {
      const style = resolveArmor(armor).style;
      const mask = borderMask(body, style);
      const dist = chebyshevDistance(body);
      let maxD = 0;
      let minD = Number.POSITIVE_INFINITY;
      for (let i = 0; i < mask.bits.length; i++) {
        if (mask.bits[i]) {
          maxD = Math.max(maxD, dist[i]!);
          minD = Math.min(minD, dist[i]!);
        }
      }
      reach[armor] = maxD;
      console.log(`[border ${armor}] px = ${mask.count()} distance band = ${minD}..${maxD}`);
      // 所有边框都从距离 2 起（距离 1 是空隙），因此不会贴在本体上
      expect(minD).toBe(2);
      expect(maxD).toBeLessThanOrEqual(BORDER_REACH[style]);
    }
    // 双层甲必须比单层甲伸得更远
    expect(reach.fortified!).toBeGreaterThan(reach.heavy!);
  });
});

describe('真实数据的整体冒烟：去色后没有两张图完全相同', () => {
  it('29 塔 + 11 敌在灰度下两两可区分', () => {
    const all: { label: string; frame: SpriteFrame }[] = [
      ...content.units.map((u) => ({ label: u.id, frame: renderTowerFrame(u, 'idle') })),
      ...content.enemies.map((e) => ({ label: e.id, frame: renderEnemyFrame(e, 'idle') })),
    ];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        if (all[i]!.frame.width !== all[j]!.frame.width) continue;
        const g = grayDiff(all[i]!.frame, all[j]!.frame);
        // 只要求"看得见差别"，不设高阈值：不同档位尺寸不同本来就一眼能分
        expect(g, `${all[i]!.label} 与 ${all[j]!.label} 去色后几乎一样`).toBeGreaterThan(0);
      }
    }
  });
});
