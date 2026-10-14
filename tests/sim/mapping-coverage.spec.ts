/**
 * ★★ **适配层变异覆盖门禁**（主策划裁决 6，欠了三轮的那条）
 *
 * ## 为什么是"变异覆盖"而不是"检查字段被读过"
 *
 * `data-adapter.ts` 已经**三次成为瓶颈**（漏整张 `tech` 表 → 漏 `target` → `map.json` 未迁），
 * 每一次都是「字段存在、但没人读、且没有任何检查发现」，而它的消费方是**全部**平衡结论。
 * 本文件就是防第四次的手段：**把每个必填字段变异成哨兵值，断言 `SimContent` 因此发生变化**。
 * 若某字段变异后什么都没变 → **它没被消费** → 报红。
 *
 * ## ★ 负对照（这条才是让门禁可信的东西）
 *
 * 变异一个**明确不该进入 `SimContent`** 的字段（`description` / `sprite` / `icon` / `roleTag`），
 * 断言 `SimContent` **不变**。没有它，一个"变异什么都变了"的探针会**全绿而毫无意义**。
 *
 * ## 覆盖范围（主策划确认）
 *
 * 七张被 `sim` 消费的表：`units` / `enemies` / `waves` / `tech` / `difficulty` / `constants` / `map`。
 * **排除并注明**：`audio`（给渲染层，本期不接模拟层）、`relics` / `equipment`
 * （局外成长与 M6 装备，`RunConfig` 里传空表，适配层不映射它们的数值）。
 */
import { describe, expect, it } from 'vitest';
import {
  loadRealContent,
  toConstants,
  toEnemy,
  toGridAndPaths,
  toTechTable,
  toUnit,
  toWave,
  type AdapterWarning,
} from '../../src/balance/data-adapter';
import constantsJson from '../../src/data/constants.json';
import difficultyJson from '../../src/data/difficulty.json';
import enemiesJson from '../../src/data/enemies.json';
import mapJson from '../../src/data/map.json';
import techJson from '../../src/data/tech.json';
import unitsJson from '../../src/data/units.json';
import wavesJson from '../../src/data/waves.json';
import type {
  BalanceConstants,
  DifficultyDef,
  EnemyDef,
  MapDef,
  TechDef,
  UnitDef,
  WaveDef,
} from '../../src/data/types.generated';

const RAW_UNITS = unitsJson as unknown as UnitDef[];
const RAW_ENEMIES = enemiesJson as unknown as EnemyDef[];
const RAW_WAVES = wavesJson as unknown as WaveDef[];
const RAW_TECH = techJson as unknown as TechDef[];
const RAW_DIFF = difficultyJson as unknown as DifficultyDef[];
const RAW_CONSTANTS = constantsJson as unknown as BalanceConstants;
const RAW_MAP = mapJson as unknown as MapDef;
const content = loadRealContent();

/** 哨兵值：保证与任何真实数据都不同（不参与模拟层的定点计算，只用于对比映射输出）。 */
const SENTINEL = 987654321;
const SENTINEL_STR = '__SENTINEL__';

const noopWarn = (_w: AdapterWarning): void => undefined;
const unitById = (id: string): UnitDef => {
  const u = RAW_UNITS.find((x) => x.id === id);
  if (!u) throw new Error(`夹具缺单位 ${id}`);
  return u;
};
const enemyById = (id: string): EnemyDef => {
  const e = RAW_ENEMIES.find((x) => x.id === id);
  if (!e) throw new Error(`夹具缺敌人 ${id}`);
  return e;
};

/** 夹具：三个有代表性的单位（普通塔 / 带光环 / 带多种 abilities）。 */
const UNIT_FIXTURES = ['pickpocket', 'shaman', 'discipline_dean', 'master_thief', 'multi_archer', 'cannon_tower'] as const;
const ENEMY_FIXTURES = ['thug', 'boss_inner_demon', 'ascendant'] as const;

/**
 * 单位字段变异表：`[字段名, 变异函数, 适用性谓词]`。
 *
 * ⚠️ 适用性谓词是**必需的**：对"本来就没有 abilities 的单位"变异 `abilities[multishot]`
 * 是一次**空操作**，报红只能说明夹具选错了，不能说明字段没被消费。
 * `it()` 在生成阶段就被过滤掉，并在文件末尾断言"每条变异至少在一个夹具上被覆盖" ——
 * 否则会出现"0 条用例被生成、门禁全绿"的更隐蔽的空测量。
 */
const UNIT_MUTATIONS: readonly [string, (u: UnitDef) => UnitDef, (u: UnitDef) => boolean][] = [
  ['id', (u) => ({ ...u, id: SENTINEL_STR }), () => true],
  ['name', (u) => ({ ...u, name: SENTINEL_STR }), () => true],
  ['tier', (u) => ({ ...u, tier: 5 }), (u) => u.tier !== 5],
  ['cost.gold', (u) => ({ ...u, cost: { ...u.cost, gold: SENTINEL } }), () => true],
  ['cost.wood', (u) => ({ ...u, cost: { ...u.cost, wood: SENTINEL } }), () => true],
  ['attack', (u) => ({ ...u, attack: SENTINEL }), () => true],
  ['attackInterval', (u) => ({ ...u, attackInterval: SENTINEL }), () => true],
  ['range', (u) => ({ ...u, range: SENTINEL }), () => true],
  ['attackType', (u) => ({ ...u, attackType: 'chaos' }), (u) => u.attackType !== 'chaos'],
  ['stealBase', (u) => ({ ...u, stealBase: SENTINEL }), () => true],
  ['critRate', (u) => ({ ...u, critRate: SENTINEL }), () => true],
  ['critMul', (u) => ({ ...u, critMul: SENTINEL }), () => true],
  ['block', (u) => ({ ...u, block: SENTINEL }), () => true],
  ['slowWhileBlocked', (u) => ({ ...u, slowWhileBlocked: SENTINEL }), () => true],
  ['sellsFor', (u) => ({ ...u, sellsFor: SENTINEL }), () => true],
  ['line', (u) => ({ ...u, line: 'cannon' as UnitDef['line'] }), (u) => u.line !== 'cannon'],
  ['upgradesTo[0]', (u) => ({ ...u, upgradesTo: u.upgradesTo ? [SENTINEL_STR, ...u.upgradesTo.slice(1)] : [SENTINEL_STR] }), () => true],
  ['auras[0].value', (u) => ({ ...u, auras: u.auras ? u.auras.map((a, i) => (i === 0 ? { ...a, value: SENTINEL } : a)) : u.auras }), (u) => (u.auras?.length ?? 0) > 0],
  ['auras[0].radius', (u) => ({ ...u, auras: u.auras ? u.auras.map((a, i) => (i === 0 ? { ...a, radius: SENTINEL } : a)) : u.auras }), (u) => (u.auras?.length ?? 0) > 0],
  ['auras[0].kind', (u) => ({ ...u, auras: u.auras ? u.auras.map((a, i) => (i === 0 ? { ...a, kind: 'slowPct' as never } : a)) : u.auras }), (u) => (u.auras?.length ?? 0) > 0 && u.auras?.[0]?.kind !== 'slowPct'],
  [
    'abilities[multishot].targets',
    (u) => ({ ...u, abilities: u.abilities?.map((a) => (a.id === 'multishot' ? { ...a, params: { ...a.params, targets: 3 } } : a)) }),
    (u) => (u.abilities ?? []).some((a) => a.id === 'multishot'),
  ],
  [
    'abilities[splash].splashRadiusCells',
    (u) => ({ ...u, abilities: u.abilities?.map((a) => (a.id === 'splash' ? { ...a, params: { ...a.params, splashRadiusCells: SENTINEL } } : a)) }),
    (u) => (u.abilities ?? []).some((a) => a.id === 'splash' || a.id === 'splash_burn' || a.id === 'group_slow' || a.id === 'group_slow_freeze'),
  ],
  [
    'abilities[stealth].stealPct',
    (u) => ({ ...u, abilities: u.abilities?.map((a) => (a.id === 'stealth' ? { ...a, params: { ...a.params, stealPct: SENTINEL } } : a)) }),
    (u) => (u.abilities ?? []).some((a) => a.id === 'stealth'),
  ],
  [
    'abilities[detention].stealResistDebuffPct',
    (u) => ({ ...u, abilities: u.abilities?.map((a) => (a.id === 'detention' ? { ...a, params: { ...a.params, stealResistDebuffPct: SENTINEL } } : a)) }),
    (u) => (u.abilities ?? []).some((a) => a.id === 'detention'),
  ],
  [
    'abilities[relocate_free]',
    (u) => ({ ...u, abilities: [...(u.abilities ?? []), { id: 'relocate_free' as never, cooldown: 0, params: {} }] }),
    (u) => !(u.abilities ?? []).some((a) => a.id === 'relocate_free'),
  ],
  [
    'abilities[wood_gather]',
    (u) => ({ ...u, abilities: [{ id: 'wood_gather' as never, cooldown: 5000, params: { woodPerCycle: SENTINEL } }] }),
    () => true,
  ],
  [
    'abilities[frost_hit]',
    (u) => ({ ...u, abilities: [{ id: 'frost_hit' as never, cooldown: 0, params: { slowPct: SENTINEL, durationSec: SENTINEL } }] }),
    () => true,
  ],
];

/** ★ 负对照：这些字段**明确不该**进入 `SimContent`（纯展示/资源引用）。 */
const UNIT_UNMAPPED: readonly [string, (u: UnitDef) => UnitDef][] = [
  ['description', (u) => ({ ...u, description: SENTINEL_STR })],
  ['sprite', (u) => ({ ...u, sprite: SENTINEL_STR })],
  ['icon', (u) => ({ ...u, icon: SENTINEL_STR })],
  ['roleTag', (u) => ({ ...u, roleTag: 'endgame' })],
];

/** 敌人字段变异表。 */
const ENEMY_MUTATIONS: readonly [string, (e: EnemyDef) => EnemyDef][] = [
  ['id', (e) => ({ ...e, id: SENTINEL_STR })],
  ['name', (e) => ({ ...e, name: SENTINEL_STR })],
  ['armorType', (e) => ({ ...e, armorType: e.armorType === 'divine' ? 'light' : 'divine' })],
  ['baseHp', (e) => ({ ...e, baseHp: SENTINEL })],
  ['baseWallet', (e) => ({ ...e, baseWallet: SENTINEL })],
  ['speed', (e) => ({ ...e, speed: SENTINEL })],
  ['flying', (e) => ({ ...e, flying: !e.flying })],
  ['stealResist', (e) => ({ ...e, stealResist: SENTINEL })],
  ['dodge', (e) => ({ ...e, dodge: SENTINEL })],
  ['bountyRatio.gold', (e) => ({ ...e, bountyRatio: { ...e.bountyRatio, gold: SENTINEL } })],
  ['bountyRatio.wood', (e) => ({ ...e, bountyRatio: { ...e.bountyRatio, wood: SENTINEL } })],
  ['isBoss', (e) => ({ ...e, isBoss: !e.isBoss })],
  ['hooks', (e) => ({ ...e, hooks: ['split', 'revive'] as EnemyDef['hooks'] })],
];

const ENEMY_UNMAPPED: readonly [string, (e: EnemyDef) => EnemyDef][] = [
  ['description', (e) => ({ ...e, description: SENTINEL_STR })],
  ['sprite', (e) => ({ ...e, sprite: SENTINEL_STR })],
];

/** 波次字段变异表。 */
const WAVE_MUTATIONS: readonly [string, (w: WaveDef) => WaveDef][] = [
  ['wave', (w) => ({ ...w, wave: SENTINEL })],
  ['prepTime', (w) => ({ ...w, prepTime: SENTINEL })],
  ['groups[0].enemy', (w) => ({ ...w, groups: w.groups.map((g, i) => (i === 0 ? { ...g, enemy: 'heavy_brute' } : g)) })],
  ['groups[0].count', (w) => ({ ...w, groups: w.groups.map((g, i) => (i === 0 ? { ...g, count: SENTINEL } : g)) })],
  ['groups[0].interval', (w) => ({ ...w, groups: w.groups.map((g, i) => (i === 0 ? { ...g, interval: SENTINEL } : g)) })],
  ['groups[0].delay', (w) => ({ ...w, groups: w.groups.map((g, i) => (i === 0 ? { ...g, delay: SENTINEL } : g)) })],
  ['reward.gold', (w) => ({ ...w, reward: { ...w.reward, gold: SENTINEL } })],
  ['reward.wood', (w) => ({ ...w, reward: { ...w.reward, wood: SENTINEL } })],
  ['hint.text', (w) => ({ ...w, hint: { ...w.hint, text: SENTINEL_STR } })],
];

const WAVE_UNMAPPED: readonly [string, (w: WaveDef) => WaveDef][] = [
  ['hint.recommendArmor', (w) => ({ ...w, hint: { ...w.hint, recommendArmor: 'divine' } })],
  ['hint.recommendAttack', (w) => ({ ...w, hint: { ...w.hint, recommendAttack: 'chaos' } })],
];

/** 科技字段变异表。 */
const TECH_MUTATIONS: readonly [string, (t: TechDef) => TechDef][] = [
  ['id', (t) => ({ ...t, id: SENTINEL_STR })],
  ['name', (t) => ({ ...t, name: SENTINEL_STR })],
  ['maxLevel', (t) => ({ ...t, maxLevel: 7 })],
  ['effectPerLevel', (t) => ({ ...t, effectPerLevel: SENTINEL })],
  ['effectUnit', (t) => ({ ...t, effectUnit: t.effectUnit === 'permille' ? 'count' : 'permille' })],
  ['effectMode', (t) => ({ ...t, effectMode: t.effectMode === 'mul' ? 'add' : 'mul' })],
  ['target', (t) => ({ ...t, target: t.target === 'attack' ? 'speed' : 'attack' })],
  ['costPerLevel[0].gold', (t) => ({ ...t, costPerLevel: t.costPerLevel.map((c, i) => (i === 0 ? { ...c, gold: SENTINEL } : c)) })],
  ['costPerLevel[0].wood', (t) => ({ ...t, costPerLevel: t.costPerLevel.map((c, i) => (i === 0 ? { ...c, wood: SENTINEL } : c)) })],
  ['archivable', (t) => ({ ...t, archivable: !t.archivable })],
];

/** 难度字段变异表。 */
const DIFF_MUTATIONS: readonly [string, (d: DifficultyDef) => DifficultyDef][] = [
  ['hpMul', (d) => ({ ...d, hpMul: SENTINEL })],
  ['walletMul', (d) => ({ ...d, walletMul: SENTINEL })],
  ['counterMode', (d) => ({ ...d, counterMode: d.counterMode === 'compressed' ? 'standard' : 'compressed' })],
  ['startGold', (d) => ({ ...d, startGold: SENTINEL })],
  ['startWood', (d) => ({ ...d, startWood: SENTINEL })],
  ['lives', (d) => ({ ...d, lives: SENTINEL })],
  ['openLanes', (d) => ({ ...d, openLanes: 3 })],
  ['crystalMul', (d) => ({ ...d, crystalMul: SENTINEL })],
];

const DIFF_UNMAPPED: readonly [string, (d: DifficultyDef) => DifficultyDef][] = [
  ['name', (d) => ({ ...d, name: SENTINEL_STR })],
  ['description', (d) => ({ ...d, description: SENTINEL_STR })],
  ['divineArmorAllWaves', (d) => ({ ...d, divineArmorAllWaves: !d.divineArmorAllWaves })],
];

/** 常量字段变异表（只测适配层真的映射进 `SimConstants` 的那些键）。 */
const CONST_MUTATIONS: readonly [string, (c: BalanceConstants) => BalanceConstants][] = [
  ['tickRate', (c) => ({ ...c, tickRate: 120 as BalanceConstants['tickRate'] })],
  ['waveTotal', (c) => ({ ...c, waveTotal: SENTINEL })],
  ['baseHp', (c) => ({ ...c, baseHp: SENTINEL })],
  ['hpIndex', (c) => ({ ...c, hpIndex: SENTINEL })],
  ['baseWallet', (c) => ({ ...c, baseWallet: SENTINEL })],
  ['walletIndex', (c) => ({ ...c, walletIndex: SENTINEL })],
  ['enemyCountBase', (c) => ({ ...c, enemyCountBase: SENTINEL })],
  ['enemyCountSlope', (c) => ({ ...c, enemyCountSlope: SENTINEL })],
  ['levelMul[0]', (c) => ({ ...c, levelMul: c.levelMul.map((v, i) => (i === 0 ? SENTINEL : v)) })],
  ['stealAtkCoef', (c) => ({ ...c, stealAtkCoef: SENTINEL })],
  ['critRateBase', (c) => ({ ...c, critRateBase: SENTINEL })],
  ['critRateCap', (c) => ({ ...c, critRateCap: SENTINEL })],
  ['critMulBase', (c) => ({ ...c, critMulBase: SENTINEL })],
  ['critMulPerLevel', (c) => ({ ...c, critMulPerLevel: SENTINEL })],
  ['critMulCap', (c) => ({ ...c, critMulCap: SENTINEL })],
  ['counterMatrixStandard[0][0]', (c) => ({
    ...c,
    counterMatrixStandard: c.counterMatrixStandard.map((row, i) => (i === 0 ? row.map((v, j) => (j === 0 ? SENTINEL : v)) : row)),
  })],
  ['compressedFactor', (c) => ({ ...c, compressedFactor: SENTINEL })],
  ['compressedFloor', (c) => ({ ...c, compressedFloor: SENTINEL })],
  ['haltPointStopDuration', (c) => ({ ...c, haltPointStopDuration: SENTINEL })],
  ['salaryCooldown', (c) => ({ ...c, salaryCooldown: SENTINEL })],
  ['salaryMultiplier', (c) => ({ ...c, salaryMultiplier: SENTINEL })],
  ['brambleCooldown', (c) => ({ ...c, brambleCooldown: SENTINEL })],
  ['brambleDuration', (c) => ({ ...c, brambleDuration: SENTINEL })],
  ['techArchiveFreeLevelDivisor', (c) => ({ ...c, techArchiveFreeLevelDivisor: SENTINEL })],
  ['techArchiveCostReductionPct', (c) => ({ ...c, techArchiveCostReductionPct: SENTINEL })],
];

/** 地图字段变异表。 */
const MAP_MUTATIONS: readonly [string, (m: MapDef) => MapDef][] = [
  ['grid.width', (m) => ({ ...m, grid: { ...m.grid, width: m.grid.width + 1 } })],
  ['grid.height', (m) => ({ ...m, grid: { ...m.grid, height: m.grid.height + 1 } })],
  ['vault.x', (m) => ({ ...m, vault: { ...m.vault, x: m.vault.x + 1 } })],
  ['vault.y', (m) => ({ ...m, vault: { ...m.vault, y: m.vault.y + 1 } })],
  ['vault.w', (m) => ({ ...m, vault: { ...m.vault, w: m.vault.w + 1 } })],
  ['vault.h', (m) => ({ ...m, vault: { ...m.vault, h: m.vault.h + 1 } })],
  ['paths[0].id', (m) => ({ ...m, paths: m.paths.map((p, i) => (i === 0 ? { ...p, id: p.id + 10 } : p)) })],
  ['paths[0].waypoints[0].x', (m) => ({
    ...m,
    paths: m.paths.map((p, i) =>
      i === 0 ? { ...p, waypoints: p.waypoints.map((w, j) => (j === 0 ? { ...w, x: w.x + 1000 } : w)) } : p,
    ),
  })],
  ['paths[0].haltIndex', (m) => ({ ...m, paths: m.paths.map((p, i) => (i === 0 ? { ...p, haltIndex: 1 } : p)) })],
];

/** 序列化对比（只比较映射输出，不比较引用）。 */
function snap(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v === undefined ? null : v));
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试
// ─────────────────────────────────────────────────────────────────────────────

describe('★ 适配层变异覆盖门禁（units）', () => {
  const covered = new Set<string>();
  for (const uid of UNIT_FIXTURES) {
    for (const [field, mutate, applicable] of UNIT_MUTATIONS) {
      if (!applicable(unitById(uid))) continue; // 空操作的变异不算探针（见文件头说明）
      covered.add(field);
      it(`units[${uid}].${field} 被消费（变异后 SimContent 变化）`, () => {
        const base = toUnit(unitById(uid), RAW_CONSTANTS, noopWarn);
        const mutated = toUnit(mutate(unitById(uid)), RAW_CONSTANTS, noopWarn);
        expect(snap(mutated), `字段 ${field} 变异后 SimContent 没变 → 适配层没消费它`).not.toBe(snap(base));
      });
    }
  }
  it('★ 门禁自身的完备性：每条变异至少在一个夹具上被生成（防"0 条用例全绿"）', () => {
    const never = UNIT_MUTATIONS.filter(([f]) => !covered.has(f)).map(([f]) => f);
    expect(never, `这些变异在任何夹具上都没生成用例 → 它们没有被真正测过：${never.join(',')}`).toEqual([]);
  });
  for (const [field, mutate] of UNIT_UNMAPPED) {
    it(`★ 负对照：units[*].${field} 不应进入 SimContent（变异后必须不变）`, () => {
      for (const uid of UNIT_FIXTURES) {
        const base = toUnit(unitById(uid), RAW_CONSTANTS, noopWarn);
        const mutated = toUnit(mutate(unitById(uid)), RAW_CONSTANTS, noopWarn);
        expect(snap(mutated), `${field} 竟然影响了 SimContent → 变异探针无法区分"消费"与"未消费"`).toBe(snap(base));
      }
    });
  }
});

describe('★ 适配层变异覆盖门禁（enemies）', () => {
  for (const eid of ENEMY_FIXTURES) {
    for (const [field, mutate] of ENEMY_MUTATIONS) {
      it(`enemies[${eid}].${field} 被消费`, () => {
        const base = toEnemy(enemyById(eid), noopWarn);
        const mutated = toEnemy(mutate(enemyById(eid)), noopWarn);
        expect(snap(mutated), `字段 ${field} 未被消费`).not.toBe(snap(base));
      });
    }
  }
  for (const [field, mutate] of ENEMY_UNMAPPED) {
    it(`★ 负对照：enemies[*].${field} 不应进入 SimContent`, () => {
      for (const eid of ENEMY_FIXTURES) {
        const base = toEnemy(enemyById(eid), noopWarn);
        const mutated = toEnemy(mutate(enemyById(eid)), noopWarn);
        expect(snap(mutated), `${field} 竟然影响了 SimContent`).toBe(snap(base));
      }
    });
  }
});

describe('★ 适配层变异覆盖门禁（waves）', () => {
  const enemyIds = new Set(RAW_ENEMIES.map((e) => e.id));
  const wave = RAW_WAVES[0] as WaveDef;
  for (const [field, mutate] of WAVE_MUTATIONS) {
    it(`waves[1].${field} 被消费`, () => {
      // 第 5 波才有 path 字段；这里用第 1 波测通用字段
      const base = toWave(wave, enemyIds);
      const mutated = toWave(mutate(wave), enemyIds);
      expect(snap(mutated), `字段 ${field} 未被消费`).not.toBe(snap(base));
    });
  }
  for (const [field, mutate] of WAVE_UNMAPPED) {
    it(`★ 负对照：waves[*].${field} 不应进入 SimContent`, () => {
      const base = toWave(wave, enemyIds);
      const mutated = toWave(mutate(wave), enemyIds);
      expect(snap(mutated), `${field} 竟然影响了 SimContent`).toBe(snap(base));
    });
  }
  it('waves[5].groups[1].path 被消费（只走 0/1 路）', () => {
    const w = RAW_WAVES[4] as WaveDef;
    const base = toWave(w, enemyIds);
    expect(base.groups.map((g) => g.path)).toContainEqual([0, 1]);
    const mutated = toWave({ ...w, groups: w.groups.map((g, i) => (i === 1 ? { ...g, path: [1] } : g)) }, enemyIds);
    expect(snap(mutated)).not.toBe(snap(base));
  });
});

describe('★ 适配层变异覆盖门禁（tech）', () => {
  for (const [field, mutate] of TECH_MUTATIONS) {
    it(`tech[*].${field} 被消费`, () => {
      const base = toTechTable(RAW_TECH);
      const mutated = toTechTable(RAW_TECH.map((t, i) => (i === 0 ? mutate(t) : t)));
      expect(snap(mutated), `字段 ${field} 未被消费`).not.toBe(snap(base));
    });
  }
  it('★ 负对照：tech[*].description 不应进入 SimContent', () => {
    const base = toTechTable(RAW_TECH);
    const mutated = toTechTable(
      RAW_TECH.map((t, i) => (i === 0 ? ({ ...t, description: SENTINEL_STR } as unknown as TechDef) : t)),
    );
    expect(snap(mutated)).toBe(snap(base));
  });
  it('★ 关键回归：8 条线的 target 全部被映射（漏一条就会回退到 legacy 硬映射）', () => {
    const table = toTechTable(RAW_TECH);
    for (const t of RAW_TECH) {
      expect(table[t.id]?.target, `${t.id} 的 target 丢了`).toBe(t.target);
    }
  });
});

describe('★ 适配层变异覆盖门禁（difficulty / constants / map）', () => {
  for (const [field, mutate] of DIFF_MUTATIONS) {
    it(`difficulty.N2.${field} 被消费`, () => {
      const base = toConstants(RAW_CONSTANTS, RAW_DIFF, RAW_UNITS, RAW_MAP, noopWarn).difficulty;
      const mutated = toConstants(
        RAW_CONSTANTS,
        RAW_DIFF.map((d, i) => (i === 1 ? mutate(d) : d)),
        RAW_UNITS,
        RAW_MAP,
        noopWarn,
      ).difficulty;
      expect(snap(mutated), `字段 ${field} 未被消费`).not.toBe(snap(base));
    });
  }
  for (const [field, mutate] of DIFF_UNMAPPED) {
    it(`★ 负对照：difficulty[*].${field} 不应进入 SimConstants`, () => {
      const base = toConstants(RAW_CONSTANTS, RAW_DIFF, RAW_UNITS, RAW_MAP, noopWarn).difficulty;
      const mutated = toConstants(
        RAW_CONSTANTS,
        RAW_DIFF.map((d, i) => (i === 1 ? mutate(d) : d)),
        RAW_UNITS,
        RAW_MAP,
        noopWarn,
      ).difficulty;
      expect(snap(mutated), `${field} 竟然影响了 SimConstants`).toBe(snap(base));
    });
  }
  for (const [field, mutate] of CONST_MUTATIONS) {
    it(`constants.${field} 被消费`, () => {
      const base = toConstants(RAW_CONSTANTS, RAW_DIFF, RAW_UNITS, RAW_MAP, noopWarn);
      const mutated = toConstants(mutate(RAW_CONSTANTS), RAW_DIFF, RAW_UNITS, RAW_MAP, noopWarn);
      expect(snap(mutated), `常量 ${field} 未被消费`).not.toBe(snap(base));
    });
  }
  for (const [field, mutate] of MAP_MUTATIONS) {
    it(`map.${field} 被消费`, () => {
      const base = toGridAndPaths(RAW_MAP);
      const mutated = toGridAndPaths(mutate(RAW_MAP));
      expect(snap(mutated), `地图字段 ${field} 未被消费`).not.toBe(snap(base));
    });
  }
  it('★ 回归（变异门禁抓到的第一个真问题）：难度按 id 查表，不按数组下标', () => {
    // 旧实现写的是 `N1: toDifficulty(diffs[0]) … N5: toDifficulty(diffs[4])` —— 完全不读 id，
    // 一旦 difficulty.json 重排，五个难度会**静默错位**。这里用**打乱顺序**的输入断言结果不变。
    const shuffled = [RAW_DIFF[3], RAW_DIFF[0], RAW_DIFF[4], RAW_DIFF[1], RAW_DIFF[2]] as typeof RAW_DIFF;
    const a = toConstants(RAW_CONSTANTS, RAW_DIFF, RAW_UNITS, RAW_MAP, noopWarn).difficulty;
    const b = toConstants(RAW_CONSTANTS, shuffled, RAW_UNITS, RAW_MAP, noopWarn).difficulty;
    expect(snap(b), '难度表顺序变了就错位 → 适配层还在按下标取').toBe(snap(a));
    // 且逐条与源数据一致
    for (const d of RAW_DIFF) {
      expect(a[d.id].hpMul).toBe(d.hpMul);
      expect(a[d.id].walletMul).toBe(d.walletMul);
      expect(a[d.id].lives).toBe(d.lives);
      expect(a[d.id].startGold).toBe(d.startGold);
    }
  });

  it('★ constants.stealWoodRatio 的消费方是 toUnit（不是 SimConstants）', () => {
    const base = toUnit(unitById('pickpocket'), RAW_CONSTANTS, noopWarn);
    const mutated = toUnit(unitById('pickpocket'), { ...RAW_CONSTANTS, stealWoodRatio: SENTINEL }, noopWarn);
    expect(mutated.stealWoodRatio).toBe(SENTINEL);
    expect(snap(mutated)).not.toBe(snap(base));
  });

  it('★ constants.map.buildableWidthCells 有意不消费（只在 map.json 与它不一致时告警）', () => {
    // 这是**有意的例外**：可建造区深度以 `map.json` 的 `buildDepth` 为准（sim 直接用它），
    // `constants.map.buildableWidthCells` 仅用于**一致性告警**。所以变异它不该改变 SimConstants 的 buildDepth。
    const base = toConstants(RAW_CONSTANTS, RAW_DIFF, RAW_UNITS, RAW_MAP, noopWarn);
    const mutated = toConstants(
      { ...RAW_CONSTANTS, map: { ...RAW_CONSTANTS.map, buildableWidthCells: SENTINEL } },
      RAW_DIFF,
      RAW_UNITS,
      RAW_MAP,
      noopWarn,
    );
    expect(mutated.buildDepth).toBe(base.buildDepth);
    expect(mutated.buildDepth).toBe(RAW_MAP.buildDepth);
  });

  it('★ map.buildDepth 的消费方是 toConstants', () => {
    const base = toConstants(RAW_CONSTANTS, RAW_DIFF, RAW_UNITS, RAW_MAP, noopWarn);
    const mutated = toConstants(RAW_CONSTANTS, RAW_DIFF, RAW_UNITS, { ...RAW_MAP, buildDepth: RAW_MAP.buildDepth + 1 }, noopWarn);
    expect(snap(mutated)).not.toBe(snap(base));
  });

  it('map.openLanes 不直接消费（但必须与 difficulty.openLanes 一致）', () => {
    // 这是一条**有意的例外**：`map.openLanes` 与 `difficulty.json` 的 `openLanes` 是重复信息，
    // 适配层只读后者。所以这里不测"变异 map.openLanes → SimContent 变化"，
    // 而是测**跨表一致性**（否则两表漂移时没有任何检查会发现）。
    for (const d of RAW_DIFF) {
      expect(RAW_MAP.openLanes[d.id].length, `${d.id} 的路数在两表间不一致`).toBe(d.openLanes);
    }
  });
});
