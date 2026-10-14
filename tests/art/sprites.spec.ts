/**
 * 精灵生成的门禁（方案 §5 的 M2 验收标准 ①）：
 * **占位美术覆盖全部 29 塔 + 11 敌人（无缺失、无共用）** + 确定性 + 尺寸规格。
 */
import { describe, expect, it } from 'vitest';

import enemiesJson from '../../src/data/enemies.json';
import unitsJson from '../../src/data/units.json';
import {
  enemyRank,
  inferElite,
  normalizeContent,
  type ArtContentInput,
  type EnemyArtInput,
  type UnitArtInput,
} from '../../src/art/content';
import {
  enemyGeometry,
  ProceduralSpriteSource,
  renderEnemyFrame,
  renderTowerFrame,
  spriteSizeOf,
  TOWER_ANCHOR_Y,
  TOWER_SIZE,
  type SpriteFrame,
} from '../../src/art/procedural';
import { assertValidSource, frameKey, parseFrameKey, SPRITE_SIZE, STATES_FOR, type SpriteState } from '../../src/art/source';
import { resolveArmor } from '../../src/art/palette';
import { BORDER_REACH } from '../../src/art/shapes';

const content: ArtContentInput = normalizeContent({
  units: unitsJson as unknown as UnitArtInput[],
  enemies: enemiesJson as unknown as EnemyArtInput[],
});

function hashPixels(pixels: ArrayLike<number>): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < pixels.length; i++) {
    h ^= pixels[i]! & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function framesDiffer(a: SpriteFrame, b: SpriteFrame): boolean {
  if (a.width !== b.width || a.height !== b.height) return true;
  return hashPixels(a.pixels) !== hashPixels(b.pixels);
}

/** 逐像素差异计数（用于"无共用"的强断言，不依赖哈希）。 */
function pixelDiffCount(a: SpriteFrame, b: SpriteFrame): number {
  if (a.width !== b.width || a.height !== b.height) return Number.POSITIVE_INFINITY;
  let n = 0;
  for (let i = 0; i < a.pixels.length; i += 4) {
    if (
      a.pixels[i] !== b.pixels[i] ||
      a.pixels[i + 1] !== b.pixels[i + 1] ||
      a.pixels[i + 2] !== b.pixels[i + 2] ||
      a.pixels[i + 3] !== b.pixels[i + 3]
    ) {
      n++;
    }
  }
  return n;
}

describe('数据规模（与任务书对表）', () => {
  it('29 塔 + 11 敌', () => {
    // 若 data-arch 有意增删条目，改这两行即可 —— 真正的门禁是下面的"逐 id 覆盖"断言。
    expect(content.units.length).toBe(29);
    expect(content.enemies.length).toBe(11);
  });
});

describe('帧覆盖：无缺失', () => {
  it('每个塔都有 idle / attack / upgrade 三帧，且尺寸为 48', () => {
    for (const unit of content.units) {
      for (const state of STATES_FOR.tower) {
        const frame = renderTowerFrame(unit, state);
        expect(frame.width, `${unit.id}:${state} 宽`).toBe(SPRITE_SIZE.tower);
        expect(frame.height, `${unit.id}:${state} 高`).toBe(SPRITE_SIZE.tower);
        expect(frame.pixels.length).toBe(TOWER_SIZE * TOWER_SIZE * 4);
        expect(frame.pixels.some((v, i) => i % 4 === 3 && v > 0), `${unit.id}:${state} 必须是空图`).toBe(true);
      }
    }
  });

  it('每个敌人都有 idle / walk 两帧，尺寸按档位（32 / 48 / 96）', () => {
    const sizeCount = { enemy: 0, elite: 0, boss: 0 };
    for (const enemy of content.enemies) {
      const rank = enemyRank(enemy);
      sizeCount[rank]++;
      const expected = spriteSizeOf(rank);
      for (const state of STATES_FOR.enemy) {
        const frame = renderEnemyFrame(enemy, state);
        expect(frame.width, `${enemy.id}:${state}`).toBe(expected);
        expect(frame.height, `${enemy.id}:${state}`).toBe(expected);
      }
    }
    // 当前数据：6 普通 + 1 精英 + 4 BOSS
    expect(sizeCount).toEqual({ enemy: 6, elite: 1, boss: 4 });
  });

  it('精英推断命中 elite_assassin，且 BOSS 不被判成精英', () => {
    const elite = content.enemies.filter((e) => inferElite(e)).map((e) => e.id);
    expect(elite).toEqual(['elite_assassin']);
    for (const e of content.enemies) {
      if (e.isBoss) expect(inferElite(e), `${e.id} 不应同时是精英`).toBe(false);
    }
  });

  it('图集的 frame key 集合 == 两个数据表的 id 集合（不多不少）', () => {
    const source = new ProceduralSpriteSource(content);
    const keys = new Set(source.keys());
    for (const unit of content.units) {
      for (const state of STATES_FOR.tower) expect(keys.has(frameKey(unit.id, state))).toBe(true);
    }
    for (const enemy of content.enemies) {
      for (const state of STATES_FOR.enemy) expect(keys.has(frameKey(enemy.id, state))).toBe(true);
    }
    expect(keys.size).toBe(
      content.units.length * STATES_FOR.tower.length + content.enemies.length * STATES_FOR.enemy.length,
    );
  });
});

describe('确定性（同 id 永远同一张图）', () => {
  it('两个独立实例的图集渲染逐字节相同', () => {
    const a = new ProceduralSpriteSource(content).render();
    const b = new ProceduralSpriteSource(content).render();
    expect(a.length).toBe(b.length);
    expect(hashPixels(a)).toBe(hashPixels(b));
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) throw new Error(`第 ${i} 字节不同`);
    }
  });

  it('单帧重复渲染逐字节相同', () => {
    const unit = content.units[0]!;
    expect(pixelDiffCount(renderTowerFrame(unit, 'idle'), renderTowerFrame(unit, 'idle'))).toBe(0);
    const enemy = content.enemies[0]!;
    expect(pixelDiffCount(renderEnemyFrame(enemy, 'idle'), renderEnemyFrame(enemy, 'idle'))).toBe(0);
  });

  it('id 的哈希只影响"抖动"，换一个 id 必然换一张图', () => {
    const a = renderEnemyFrame({ id: 'probe_a', armorType: 'light', flying: false, isBoss: false, stealResist: 0 }, 'idle');
    const b = renderEnemyFrame({ id: 'probe_b', armorType: 'light', flying: false, isBoss: false, stealResist: 0 }, 'idle');
    expect(pixelDiffCount(a, b)).toBeGreaterThan(0);
  });
});

describe('无共用（两个不同 id 不得产生完全相同的像素）', () => {
  it('全部 29 塔的 idle 帧两两不同', () => {
    const frames = content.units.map((u) => ({ id: u.id, frame: renderTowerFrame(u, 'idle') }));
    for (let i = 0; i < frames.length; i++) {
      for (let j = i + 1; j < frames.length; j++) {
        const diff = pixelDiffCount(frames[i]!.frame, frames[j]!.frame);
        expect(diff, `${frames[i]!.id} 与 ${frames[j]!.id} 像素完全一致`).toBeGreaterThan(0);
      }
    }
  });

  it('全部 11 敌的 idle 帧两两不同', () => {
    const frames = content.enemies.map((e) => ({ id: e.id, frame: renderEnemyFrame(e, 'idle') }));
    for (let i = 0; i < frames.length; i++) {
      for (let j = i + 1; j < frames.length; j++) {
        expect(
          pixelDiffCount(frames[i]!.frame, frames[j]!.frame),
          `${frames[i]!.id} 与 ${frames[j]!.id} 像素完全一致`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('塔与敌之间（同尺寸的 48）也不共用', () => {
    const towers = content.units.map((u) => renderTowerFrame(u, 'idle'));
    const elites = content.enemies.filter((e) => enemyRank(e) === 'elite').map((e) => renderEnemyFrame(e, 'idle'));
    for (const t of towers) {
      for (const e of elites) expect(pixelDiffCount(t, e)).toBeGreaterThan(0);
    }
  });

  it('同一 id 的不同状态帧互不相同（否则状态没有表现力）', () => {
    for (const unit of content.units) {
      const idle = renderTowerFrame(unit, 'idle');
      for (const state of ['attack', 'upgrade'] as const) {
        expect(pixelDiffCount(idle, renderTowerFrame(unit, state)), `${unit.id}:${state}`).toBeGreaterThan(0);
      }
    }
    for (const enemy of content.enemies) {
      expect(pixelDiffCount(renderEnemyFrame(enemy, 'idle'), renderEnemyFrame(enemy, 'walk')), enemy.id).toBeGreaterThan(0);
    }
  });
});

describe('图集完整性', () => {
  it('assertValidSource 通过（整数坐标 / 锚点在帧内 / 不越界 / 像素长度匹配）', () => {
    const source = new ProceduralSpriteSource(content);
    expect(() => assertValidSource(source, 'ProceduralSpriteSource')).not.toThrow();
  });

  it('图集是 2 的幂尺寸，且帧两两不重叠', () => {
    const source = new ProceduralSpriteSource(content);
    const { imageWidth, imageHeight, frames } = source.atlas;
    expect(Math.log2(imageWidth) % 1).toBe(0);
    expect(Math.log2(imageHeight) % 1).toBe(0);
    const list = Object.entries(frames);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]![1];
        const b = list[j]![1];
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${list[i]![0]} 与 ${list[j]![0]} 重叠`).toBe(false);
      }
    }
  });
});

describe('锚点（着地点）', () => {
  it('塔的锚点在底座下沿，且帧内所有像素都在锚点之上', () => {
    for (const unit of content.units) {
      const frame = renderTowerFrame(unit, 'idle');
      expect(frame.anchorY).toBe(TOWER_ANCHOR_Y);
      // 最低的非透明像素不得低于锚点
      let lowest = -1;
      for (let y = 0; y < frame.height; y++) {
        for (let x = 0; x < frame.width; x++) {
          if (frame.pixels[(y * frame.width + x) * 4 + 3]! > 0) {
            lowest = y;
            break;
          }
        }
      }
      expect(lowest).toBeLessThan(frame.anchorY);
    }
  });

  it('敌人的锚点 = 帧中心 + 标称半径 + 1（与 id 抖动无关，保证站位稳定）', () => {
    for (const enemy of content.enemies) {
      const size = spriteSizeOf(enemyRank(enemy));
      const geo = enemyGeometry(size);
      const frame = renderEnemyFrame(enemy, 'idle');
      expect(frame.anchorX).toBe(geo.anchorX);
      expect(frame.anchorY).toBe(geo.anchorY);
      // 护甲边框最大外扩 + 本体半径必须在帧内
      const reach = BORDER_REACH[resolveArmor(enemy.armorType).style];
      expect(geo.baseRadius + 1 + reach).toBeLessThanOrEqual(size / 2);
    }
  });
});

describe('数据驱动（铁律 5）', () => {
  it('新增一个单位（未改任何代码）就能得到精灵', () => {
    const synthetic: UnitArtInput = { id: 'unit_added_tomorrow', line: 'cannon', tier: 4 };
    const frame = renderTowerFrame(synthetic, 'idle');
    expect(frame.width).toBe(48);
    expect(frame.pixels.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
  });

  it('未知塔系 / 未知护甲都不抛异常（有兜底）', () => {
    expect(() => renderTowerFrame({ id: 'x', line: 'brand_new_line', tier: 2 }, 'idle')).not.toThrow();
    expect(() =>
      renderEnemyFrame({ id: 'y', armorType: 'brand_new_armor', flying: false, isBoss: false, stealResist: 0 }, 'idle'),
    ).not.toThrow();
  });

  it('normalizeContent 对重复 id 抛错（而不是静默覆盖）', () => {
    expect(() =>
      normalizeContent({
        units: [
          { id: 'dup', line: 'mage', tier: 1 },
          { id: 'dup', line: 'mage', tier: 2 },
        ],
        enemies: [],
      }),
    ).toThrow(/重复/);
  });
});

describe('编码通道的形状证据（不依赖颜色）', () => {
  const base = (patch: Partial<EnemyArtInput>): EnemyArtInput => ({
    id: 'channel_probe',
    armorType: 'medium',
    flying: false,
    isBoss: false,
    stealResist: 0,
    ...patch,
  });

  it('飞行：整体上移（质心更高）+ 两侧更宽（翼痕）', () => {
    const ground = renderEnemyFrame(base({ flying: false }), 'idle');
    const air = renderEnemyFrame(base({ flying: true }), 'idle');
    const centroidY = (f: SpriteFrame): number => {
      let sum = 0;
      let n = 0;
      for (let y = 0; y < f.height; y++) {
        for (let x = 0; x < f.width; x++) {
          if (f.pixels[(y * f.width + x) * 4 + 3]! > 0) {
            sum += y;
            n++;
          }
        }
      }
      return sum / n;
    };
    expect(centroidY(ground) - centroidY(air)).toBeGreaterThanOrEqual(1.5);

    const widthSpan = (f: SpriteFrame): number => {
      let min = f.width;
      let max = -1;
      for (let y = 0; y < f.height; y++) {
        for (let x = 0; x < f.width; x++) {
          if (f.pixels[(y * f.width + x) * 4 + 3]! > 0) {
            min = Math.min(min, x);
            max = Math.max(max, x);
          }
        }
      }
      return max - min;
    };
    expect(widthSpan(air)).toBeGreaterThan(widthSpan(ground) + 3);
  });

  it('BOSS 金环 / 精英星 / 挂锁 / 免疫斜杠都改变至少 N 个像素', () => {
    const plain = renderEnemyFrame(base({}), 'idle');
    const boss = renderEnemyFrame(base({ isBoss: true }), 'idle');
    const elite = renderEnemyFrame(base({ isElite: true }), 'idle');
    const resist = renderEnemyFrame(base({ stealResist: 700 }), 'idle');
    const immune = renderEnemyFrame(base({ stealResist: 1000 }), 'idle');
    expect(pixelDiffCount(plain, boss)).toBeGreaterThan(60);
    expect(pixelDiffCount(plain, elite)).toBeGreaterThan(20);
    expect(pixelDiffCount(plain, resist)).toBeGreaterThan(20);
    // 免疫 = 挂锁 + 斜杠。实测差异 18px（32×32 里约占 5% 的像素、4× 放大后 288px）。
    // 这是全部非颜色通道里**最弱**的一条，阈值取 14 留出余量；
    // 见交付汇报「未验证与已知缺口」里对这一项的取舍说明。
    expect(pixelDiffCount(resist, immune)).toBeGreaterThan(14);
  });
});

describe('SpriteState 覆盖', () => {
  it('STATES_FOR 覆盖四个状态且与生成器一致', () => {
    const all: SpriteState[] = [...STATES_FOR.tower, ...STATES_FOR.enemy];
    expect(new Set(all)).toEqual(new Set(['idle', 'attack', 'upgrade', 'walk']));
  });

  it('frameKey / parseFrameKey 互为逆运算（渲染层要靠它从图集 key 反查 id）', () => {
    for (const state of ['idle', 'attack', 'upgrade', 'walk'] as const) {
      expect(parseFrameKey(frameKey('master_thief', state))).toEqual({ id: 'master_thief', state });
    }
    // 非法 key 不抛异常，返回 null
    expect(parseFrameKey('nonsense')).toBeNull();
    expect(parseFrameKey('id:unknown_state')).toBeNull();
    expect(parseFrameKey(':idle')).toBeNull();
  });

  it('图集里的每个 key 都能被 parseFrameKey 解析回 id（含下划线的 id 不能解析错）', () => {
    const source = new ProceduralSpriteSource(content);
    for (const key of source.keys()) {
      const parsed = parseFrameKey(key);
      expect(parsed, `无法解析 ${key}`).not.toBeNull();
      expect(parsed!.id.length).toBeGreaterThan(0);
      expect(key).toBe(frameKey(parsed!.id, parsed!.state));
    }
  });
});
