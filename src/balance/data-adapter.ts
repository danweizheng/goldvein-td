/**
 * 真实配置表 → `SimContent` 适配层
 *
 * ⚠️ **临时位置（所有权）**：本文件按批次 2 任务书暂放在 `src/balance/`，
 * 因为 `src/data/**`（`data-arch`）与 `src/sim/**`（`engine-dev`）都不是本 agent
 * 的独占路径。**M1 应迁移到 `src/data/` 或 `src/sim/adapters/`**，届时由主策划
 * 重新分配所有权。迁移时请连同 `tests/sim/data-adapter.spec.ts` 一起搬。
 *
 * ## 它做什么
 *
 * `src/sim/**` 的 M0 实现跑在内联合成夹具上（契约 §4.2 要求 M0 解耦）。
 * `createWorldWithContent(cfg, content)` 是注入口。本文件把 `src/data/*.json`
 * 转成 `SimContent`：units / enemies / waves / difficulty / constants /
 * **map（契约 §14.11 新增第 10 张表）** / **tech（契约 §14.2 科技改乘法）**。
 *
 * ## 读数注意（契约 §3.2 + §14.10，全是踩过的坑）
 *
 * 1. `attackInterval` 是**间隔秒（定点）**，不是频率。units.json 里 833 = 1/1.2s。
 *    本文件**不做任何倒数换算**。
 * 2. 所有数值是定点整数（×1000），金币/木材也是。本文件只做整数运算。
 * 3. `abilities[].params` 的键名带单位后缀（`…Pct` 千分比 / `…Sec` 秒定点 /
 *    `…Cells` 格定点 / `…PerCycle` 每次产出）。见 `src/data/schema/README.md` §3。
 * 4. ★ **`auras[].value` 是「增量千分比」（250 = +25%），而 `SimContent.AuraDef.value`
 *    对 attack/attackSpeed/range/all/steal 是「乘区」（1250 = ×1.25）**；`slow` 是
 *    「目标移速乘区」（600 = −40%）；`stealResistDebuff` 是「抗性削减量」（250 = −25%）。
 *    漏掉换算的后果是法师光环把攻击变成 ×0.25 **且不报任何错**（契约 §14.10）。
 * 5. `effectMode`：`mul` = 每级乘 `effectPerLevel`（1500 → ×1.50/级），
 *    `add` = 每级加（50 → +5%/级，有 cap）。
 *
 * ## 数据缺失处（本文件做了推断，全部记入 `AdapterReport.warnings`）
 *
 * | 缺失项 | 本文件的处理 | 依据 |
 * |---|---|---|
 * | `projectileSpeed` | 按 line 取 18/22/14 格/秒 | M0 夹具同值，数据表无此字段 |
 * | `blockRange` | = `range`（仅 block>0 的单位） | 阻挡范围即塔射程，数据表无此字段 |
 * | `slowDuration`（美人鱼系） | 默认 2000（2s） | 仅 frost_hit 明写 durationSec |
 * | `stealWoodRatio` | 取 `constants.stealWoodRatio`（裁决 §14.5 → 3） | units.json 无此字段 |
 * | `midasCooldown` / `midasThreshold` | 取神偷 T4 `midas_touch` 的参数 | constants.json 无这两个键 |
 * | `baseIncomePerSec`（领工资基数） | 2000（2 金/秒） | constants.json 无此键，M0 夹具同值 |
 * | `populationCap` | 40 | constants.json 与策划案均未定义塔位上限 |
 * | `unlockWave` | 全 0（不设门禁） | 真实门禁是圣物解锁 + 基地等级，sim 未实现 |
 */
import { FIXED_SCALE, mulDiv, truncDiv, type Fixed } from '../sim/fixed';
import type {
  ArmorType,
  AttackType,
  AuraDef as SimAuraDef,
  AuraKind as SimAuraKind,
  DifficultyId,
  DifficultyRow,
  EnemyDef as SimEnemyDef,
  PathDef,
  SimConstants,
  SimContent,
  TechDef as SimTechDef,
  TechEffectMode,
  TechEffectUnit,
  TechTable,
  TechTarget,
  UnitDef as SimUnitDef,
  WaveDef as SimWaveDef,
} from '../sim/content';
import type {
  Ability,
  Aura,
  BalanceConstants as DataConstants,
  DifficultyDef as DataDifficultyDef,
  EnemyDef as DataEnemyDef,
  MapDef as DataMapDef,
  TechDef as DataTechDef,
  UnitDef as DataUnitDef,
  WaveDef as DataWaveDef,
} from '../data/types.generated';

import constantsJson from '../data/constants.json';
import difficultyJson from '../data/difficulty.json';
import enemiesJson from '../data/enemies.json';
import mapJson from '../data/map.json';
import techJson from '../data/tech.json';
import unitsJson from '../data/units.json';
import wavesJson from '../data/waves.json';

// ─────────────────────────────────────────────────────────────────────────────
// 原始表（`as unknown as` 转成 data-arch 的生成类型；本文件不改任何 JSON）
// ─────────────────────────────────────────────────────────────────────────────

const RAW_CONSTANTS = constantsJson as unknown as DataConstants;
const RAW_UNITS = unitsJson as unknown as DataUnitDef[];
const RAW_ENEMIES = enemiesJson as unknown as DataEnemyDef[];
const RAW_WAVES = wavesJson as unknown as DataWaveDef[];
const RAW_DIFFICULTY = difficultyJson as unknown as DataDifficultyDef[];
const RAW_MAP = mapJson as unknown as DataMapDef;
const RAW_TECH = techJson as unknown as DataTechDef[];

/** 适配过程中的推断与缺口记录（写进报告，不静默）。 */
export interface AdapterWarning {
  code: string;
  detail: string;
}

export interface AdapterReport {
  label: string;
  unitCount: number;
  enemyCount: number;
  waveCount: number;
  techCount: number;
  warnings: AdapterWarning[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 单位
// ─────────────────────────────────────────────────────────────────────────────

/** 投射物初速（格/秒，定点）。数据表无此字段，按 M0 夹具同值推断。 */
const PROJECTILE_SPEED_BY_LINE: Readonly<Record<string, Fixed>> = {
  archer: 22000,
  cannon: 14000,
};
const PROJECTILE_SPEED_DEFAULT: Fixed = 18000;

/** 美人鱼系未写 `durationSec` 时的默认减速持续（秒，定点）。 */
const DEFAULT_SLOW_DURATION: Fixed = 2000;

function abilityOf(u: DataUnitDef, id: string): Ability | undefined {
  return u.abilities?.find((a) => a.id === id);
}

/** `params` 是 `Record<string, number>`：单位只在键名后缀里，取不到就是缺省。 */
function param(a: Ability | undefined, key: string): number {
  if (!a) return 0;
  const v = a.params[key];
  return typeof v === 'number' ? v : 0;
}

/** 溅射半径：4 个溅射技能共用同一个语义（`…Cells`，格定点）。 */
function splashOf(u: DataUnitDef): Fixed {
  for (const id of ['splash', 'splash_burn', 'group_slow', 'group_slow_freeze']) {
    const a = abilityOf(u, id);
    if (a) return param(a, 'splashRadiusCells');
  }
  return 0;
}

/**
 * 命中减速：`slowPct = 250`（−25%）→ `slowOnHit = 750`（移速乘区千分比 ×0.75）。
 * 两个语义方向相反，写在一起是为了让这处换算显眼。
 */
function slowOnHitOf(u: DataUnitDef): Fixed {
  for (const id of ['frost_hit', 'group_slow', 'group_slow_freeze']) {
    const a = abilityOf(u, id);
    if (!a) continue;
    const pct = param(a, 'slowPct');
    if (pct > 0) return FIXED_SCALE - pct;
  }
  return FIXED_SCALE;
}

function slowDurationOf(u: DataUnitDef): Fixed {
  for (const id of ['frost_hit', 'group_slow', 'group_slow_freeze']) {
    const a = abilityOf(u, id);
    if (!a) continue;
    const sec = param(a, 'durationSec');
    return sec > 0 ? sec : DEFAULT_SLOW_DURATION;
  }
  return 0;
}

/**
 * 周期产木（`wood_gather`）→ 每秒产木（定点）。
 * `woodPerCycle` 是**每次产出量（定点）**，`cooldown` 是**周期（毫秒定点）**。
 */
function woodPerSecondOf(u: DataUnitDef): Fixed {
  const a = abilityOf(u, 'wood_gather');
  if (!a || a.cooldown <= 0) return 0;
  const perCycle = param(a, 'woodPerCycle');
  if (perCycle <= 0) return 0;
  return mulDiv(perCycle, FIXED_SCALE, a.cooldown);
}

/** 多目标数（`multishot`）。 */
function multiShotOf(u: DataUnitDef): number {
  const a = abilityOf(u, 'multishot');
  const n = param(a, 'targets');
  return n >= 1 ? n : 1;
}

/**
 * `auras[]`（data 侧）→ `auras[]`（SimContent 侧）。
 *
 * ★ 唯一需要换算的地方是**语义**（契约 §14.10）：data 侧 `value` 一律是**增量**，
 *   SimContent 侧只有 `slow` / `stealResistDebuff` 是「量」，其余都要变成**乘区**。
 */
const AURA_KIND_MAP: Readonly<Record<string, SimAuraKind>> = {
  attackPct: 'attack',
  allPct: 'all',
  speedPct: 'attackSpeed',
  rangePct: 'range',
  slowPct: 'slow',
  stealPct: 'steal',
  stealResistDebuff: 'stealResistDebuff',
};

/** 每种 kind 的自然作用对象（SimContent.AuraDef 没有 `affects` 字段，靠 kind 区分）。 */
const AURA_TARGET: Readonly<Record<SimAuraKind, 'allyTower' | 'enemy'>> = {
  attack: 'allyTower',
  attackSpeed: 'allyTower',
  range: 'allyTower',
  all: 'allyTower',
  steal: 'allyTower',
  slow: 'enemy',
  stealResistDebuff: 'enemy',
};

function toAura(a: Aura, unitId: string, warn: (w: AdapterWarning) => void): SimAuraDef | null {
  const kind = AURA_KIND_MAP[a.kind];
  if (kind === undefined) {
    warn({ code: 'aura-unsupported', detail: `${unitId}: 光环 kind=${a.kind} 在 SimContent 里没有对应项 → 该效果不存在` });
    return null;
  }
  if (AURA_TARGET[kind] !== a.affects) {
    warn({
      code: 'aura-affects-mismatch',
      detail: `${unitId}: 光环 kind=${a.kind} 的自然作用是 ${AURA_TARGET[kind]}，但数据写的是 ${a.affects}（sim 按 kind 决定作用对象，忽略 affects）`,
    });
  }
  // ★ 语义换算：slow = 移速乘区（−40% → 600）；stealResistDebuff = 削减量（原样）；
  //   其余 = 增量 → 乘区（+25% → 1250）。
  const value =
    kind === 'slow' ? FIXED_SCALE - a.value : kind === 'stealResistDebuff' ? a.value : FIXED_SCALE + a.value;
  return { kind, value, radius: a.radius };
}

/** 引擎未实现的 abilities（写进 warning，不静默）。 */
const UNIMPLEMENTED_ABILITIES: readonly string[] = [
  'steal_ignore_counter', // 飞贼 T5「破袋」：窃金无视抗性
  'bounce', // 校长老妈弹射
  'chain_pull', // 铁闸守卫锁链拉回
  'build_boost', // 工人建造加速
  'tech_unlock', // 科技塔解锁研究面板（sim 的研究无门槛，见 warning 'tech-open-from-start'）
];

export function toUnit(u: DataUnitDef, c: DataConstants, warn: (w: AdapterWarning) => void): SimUnitDef {
  const isSteal = u.stealBase > 0;
  const auras: SimAuraDef[] = [];
  for (const a of u.auras ?? []) {
    const mapped = toAura(a, u.id, warn);
    if (mapped) auras.push(mapped);
  }
  for (const id of UNIMPLEMENTED_ABILITIES) {
    if (abilityOf(u, id)) {
      warn({
        code: 'ability-unimplemented',
        detail: `${u.id}: abilities 含 ${id} → sim 无对应实现，该技能在模拟中不存在`,
      });
    }
  }
  if (abilityOf(u, 'splash_burn')) {
    warn({ code: 'ability-partial', detail: `${u.id}: splash_burn 的灼烧（burnSec）sim 未实现，只实现了溅射半径` });
  }
  if (abilityOf(u, 'group_slow_freeze')) {
    warn({
      code: 'ability-partial',
      detail: `${u.id}: group_slow_freeze 的冰冻（freezeSec）sim 未实现，只实现了减速+溅射`,
    });
  }

  return {
    id: u.id,
    name: u.name,
    tier: u.tier,
    costGold: u.cost.gold,
    costWood: u.cost.wood,
    attack: u.attack,
    // ★ 不做倒数换算：units.json 里已经是「间隔秒（定点）」（契约 §3.2 易错项）
    attackInterval: u.attackInterval,
    range: u.range,
    attackType: u.attackType as AttackType,
    stealBase: u.stealBase,
    critRate: u.critRate,
    critMul: u.critMul,
    block: u.block,
    blockRange: u.block > 0 ? u.range : 0,
    sellsFor: u.sellsFor,
    slowWhileBlocked: u.slowWhileBlocked,
    projectileSpeed: PROJECTILE_SPEED_BY_LINE[u.line] ?? PROJECTILE_SPEED_DEFAULT,
    multiShot: multiShotOf(u),
    splash: splashOf(u),
    slowOnHit: slowOnHitOf(u),
    slowDuration: slowDurationOf(u),
    resistReduce: param(abilityOf(u, 'detention'), 'stealResistDebuffPct'),
    stealWoodRatio: isSteal ? c.stealWoodRatio : 0,
    woodPerSecond: woodPerSecondOf(u),
    auras,
    // 军训系 T1 有两条分支，SimContent 只能表达单链 → 取第一条（= iron_gate）
    upgradeTo: u.upgradesTo && u.upgradesTo.length > 0 ? (u.upgradesTo[0] as string) : null,
    isSteal,
    canRelocate: abilityOf(u, 'relocate_free') !== undefined,
    // 真实门禁是「圣物解锁 T5 / 基地等级解锁高阶塔」，sim 没有实现 → 全开
    unlockWave: 0,
    stealBonus: param(abilityOf(u, 'stealth'), 'stealPct'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 敌人
// ─────────────────────────────────────────────────────────────────────────────

export function toEnemy(e: DataEnemyDef, warn: (w: AdapterWarning) => void): SimEnemyDef {
  const hooks = e.hooks ?? [];
  const splitOnDeath = hooks.includes('split') ? 2 : 0;
  const reviveOnce = hooks.includes('revive');
  if (hooks.includes('aura_speed')) {
    warn({
      code: 'enemy-hook-unimplemented',
      detail: `${e.id}: hooks 含 aura_speed（荒兽周围敌人 +20% 移速）→ sim 无对应实现`,
    });
  }

  return {
    id: e.id,
    name: e.name,
    armorType: e.armorType as ArmorType,
    flying: e.flying,
    speed: e.speed,
    baseHp: e.baseHp,
    baseWallet: e.baseWallet,
    stealResist: e.stealResist,
    dodge: e.dodge,
    // 契约 §14.6：击杀奖励按**当波钱包**缩放（sim 优先用 killGoldRatio）。
    // 两个都填：killGold 保留第 1 波基准，便于对账与兼容旧消费者。
    killGold: mulDiv(e.baseWallet, e.bountyRatio.gold, FIXED_SCALE),
    killWood: mulDiv(e.baseWallet, e.bountyRatio.wood, FIXED_SCALE),
    killGoldRatio: e.bountyRatio.gold,
    killWoodRatio: e.bountyRatio.wood,
    splitOnDeath,
    reviveOnce,
    boss: e.isBoss,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 波次 / 常量 / 难度 / 地图 / 科技
// ─────────────────────────────────────────────────────────────────────────────

export function toWave(w: DataWaveDef, enemyIds: ReadonlySet<string>): SimWaveDef {
  return {
    wave: w.wave,
    prepTime: w.prepTime,
    groups: w.groups.map((g) => {
      if (!enemyIds.has(g.enemy)) {
        throw new Error(`waves.json 第 ${w.wave} 波引用了不存在的敌人 '${g.enemy}'（enemies.json 里没有）`);
      }
      return {
        enemy: g.enemy,
        count: g.count,
        interval: g.interval,
        delay: g.delay,
        ...(g.path ? { path: g.path } : {}),
      };
    }),
    rewardGold: w.reward.gold,
    rewardWood: w.reward.wood,
    hint: w.hint.text,
  };
}

function toDifficulty(d: DataDifficultyDef): DifficultyRow {
  return {
    hpMul: d.hpMul,
    walletMul: d.walletMul,
    crystalMul: d.crystalMul,
    startGold: d.startGold,
    startWood: d.startWood,
    lives: d.lives,
    paths: d.openLanes,
    compressed: d.counterMode === 'compressed',
  };
}

/** 契约 §14.11：第 10 张表 `map.json` —— 零换算（与 `GridDef`/`PathDef` 同单位）。 */
export function toGridAndPaths(map: DataMapDef): { grid: SimContent['grid']; paths: PathDef[] } {
  return {
    grid: {
      width: map.grid.width,
      height: map.grid.height,
      vault: { x: map.vault.x, y: map.vault.y, w: map.vault.w, h: map.vault.h },
    },
    paths: map.paths.map((p) => ({
      id: p.id,
      waypoints: p.waypoints.map((wp) => ({ x: wp.x, y: wp.y })),
      haltIndex: p.haltIndex,
    })),
  };
}

/** `tech.json` → `SimContent.tech`（契约 §14.2：`effectMode` 决定加法/乘法）。 */
export function toTechTable(techs: readonly DataTechDef[]): TechTable {
  const out: TechTable = {};
  for (const t of techs) {
    const def: SimTechDef = {
      id: t.id,
      name: t.name,
      maxLevel: t.maxLevel,
      effectPerLevel: t.effectPerLevel,
      effectUnit: t.effectUnit as TechEffectUnit,
      effectMode: t.effectMode as TechEffectMode,
      // ★ 契约 §16：`target` 是引擎唯一的「这条科技作用于谁」的真相。
      //   漏映射的后果是引擎读不到、回退到 id 硬映射表（并记入 `legacyTargetIds`）——
      //   属于静默失效类事故，也正是本适配层第三次成为瓶颈的那一次。
      ...(t.target ? { target: t.target as TechTarget } : {}),
      costPerLevel: t.costPerLevel.map((c) => ({ gold: c.gold, wood: c.wood })),
      archivable: t.archivable,
      ...(t.requires && t.requires.length > 0 ? { requires: [...t.requires] } : {}),
    };
    out[t.id] = def;
  }
  return out;
}

export function toConstants(
  c: DataConstants,
  diffs: DataDifficultyDef[],
  units: readonly DataUnitDef[],
  map: DataMapDef,
  warn: (w: AdapterWarning) => void,
): SimConstants {
  // ★ 按 **id** 查表，不按数组下标！
  //   变异覆盖门禁（tests/sim/mapping-coverage.spec.ts）抓到的第一个真问题：
  //   旧实现写的是 `N1: toDifficulty(diffs[0]) … N5: toDifficulty(diffs[4])` ——
  //   它**完全没有读 `DifficultyDef.id`**，所以 `difficulty.json` 一旦重排，
  //   五个难度的数值会**静默错位**（N1 拿到 N3 的血量系数，且不报任何错）。
  const byId = new Map(diffs.map((d) => [d.id as string, d]));
  const pick = (id: DifficultyId): DataDifficultyDef => {
    const d = byId.get(id);
    if (!d) throw new Error(`difficulty.json 缺少难度 '${id}'（适配层拒绝静默兜底）`);
    return d;
  };
  const difficulty: Record<DifficultyId, DifficultyRow> = {
    N1: toDifficulty(pick('N1')),
    N2: toDifficulty(pick('N2')),
    N3: toDifficulty(pick('N3')),
    N4: toDifficulty(pick('N4')),
    N5: toDifficulty(pick('N5')),
  };

  // 点金术：constants.json 没有这两个键 → 取神偷 T4 的 midas_touch 参数（宗师：<15% / 20s）
  const midasUnit = units.find((u) => (u.abilities ?? []).some((a) => a.id === 'midas_touch' && u.line === 'thief'));
  const midas = midasUnit ? (midasUnit.abilities ?? []).find((a) => a.id === 'midas_touch') : undefined;
  const midasCooldown = midas ? midas.cooldown : 20000;
  const midasThreshold = midas ? param(midas, 'hpThresholdPct') : 150;

  const mapDepth = truncDiv(c.map.buildableWidthCells, FIXED_SCALE);
  if (mapDepth !== map.buildDepth) {
    warn({
      code: 'map-depth-mismatch',
      detail: `constants.map.buildableWidthCells/1000 = ${mapDepth} 与 map.json buildDepth = ${map.buildDepth} 不一致；采用 map.json（sim 直接用它）`,
    });
  }

  return {
    tickRate: c.tickRate,
    baseHp: c.baseHp,
    hpIndex: c.hpIndex,
    baseWallet: c.baseWallet,
    walletIndex: c.walletIndex,
    enemyCountBase: c.enemyCountBase,
    enemyCountSlope: c.enemyCountSlope,
    levelMul: [...c.levelMul],
    stealAtkCoef: c.stealAtkCoef,
    critRateBase: c.critRateBase,
    critRateCap: c.critRateCap,
    critMulBase: c.critMulBase,
    critMulPerLevel: c.critMulPerLevel,
    critMulCap: c.critMulCap,
    counterMatrixStandard: c.counterMatrixStandard.map((row) => [...row]),
    compressedFactor: c.compressedFactor,
    compressedFloor: c.compressedFloor,
    // 契约 §3.3 的矩阵只有 5 列；本期 enemies.json 已无「英雄甲」（心魔被裁决为 medium）
    armorAlias: { hero: 'divine' },
    haltPointStopDuration: c.haltPointStopDuration,
    salaryCooldown: c.salaryCooldown,
    salaryMultiplier: c.salaryMultiplier,
    brambleCooldown: c.brambleCooldown,
    brambleDuration: c.brambleDuration,
    midasCooldown,
    midasThreshold,
    baseIncomePerSec: 2000, // 推断：constants.json 无「基地每秒产出」，M0 夹具同值
    populationCap: 40, // 推断：策划案/constants 未定义塔位上限，M0 夹具同值
    buildDepth: map.buildDepth,
    startWave: 1,
    totalWaves: c.waveTotal,
    killRewardWaveScale: FIXED_SCALE,
    techArchiveFreeLevelDivisor: c.techArchiveFreeLevelDivisor,
    techArchiveCostReductionPct: c.techArchiveCostReductionPct,
    difficulty,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────────────────────

/** 把 `src/data/*.json` 转成 `SimContent`，并返回推断/缺口清单。 */
export function loadRealContentWithReport(): { content: SimContent; report: AdapterReport } {
  const warnings: AdapterWarning[] = [];
  const warn = (w: AdapterWarning): void => {
    warnings.push(w);
  };

  const units: Record<string, SimUnitDef> = {};
  for (const u of RAW_UNITS) units[u.id] = toUnit(u, RAW_CONSTANTS, warn);

  const enemies: Record<string, SimEnemyDef> = {};
  for (const e of RAW_ENEMIES) enemies[e.id] = toEnemy(e, warn);

  const enemyIds = new Set(Object.keys(enemies));
  const waves = RAW_WAVES.map((w) => toWave(w, enemyIds));

  const { grid, paths } = toGridAndPaths(RAW_MAP);
  const tech = toTechTable(RAW_TECH);

  warn({
    code: 'attackInterval-no-reciprocal',
    detail: 'units.json 的 attackInterval 已是间隔秒（定点），适配层不做倒数换算（契约 §3.2 易错项）。',
  });
  warn({
    code: 'no-population-spec',
    detail: 'populationCap 推断为 40、baseIncomePerSec 推断为 2000：constants.json 与策划案均未定义这两个值。',
  });
  warn({
    code: 'unlockwave-disabled',
    detail:
      'unlockWave 全 0：真实游戏里神偷 T5 / 法师 T5 / 美女 T3 / 铁闸守卫需圣物解锁，高阶塔需基地等级解锁，' +
      'sim 两者都没有 → 本适配层让所有单位开局可建（对 AI 是**放宽**）。',
  });
  warn({
    code: 'tech-open-from-start',
    detail:
      '策划案 §4.4.1 要求「科技塔建造后解锁研究」，但 sim 的 researchTech 没有前置门禁 → 本轮科技从第 1 波即可研究（对 AI 是**放宽**）。',
  });
  warn({
    code: 'midas-global',
    detail: 'activateSkill("midas") 在 sim 里是**全局技能**，不校验是否拥有宗师/工人 → 适配层无法表达「建筑提供技能」。',
  });
  // 契约 §16 已补 `TechDef.target`，本适配层已映射 → 旧的 `tech-slot-by-id` 缺口**已关闭**，
  // 不再记录（保留这条注释是为了说明它为什么消失了，避免以后有人当成"漏了"又加回来）。

  const content: SimContent = {
    label: 'src/data/*.json (via src/balance/data-adapter.ts)',
    synthetic: false,
    units,
    enemies,
    waves,
    constants: toConstants(RAW_CONSTANTS, RAW_DIFFICULTY, RAW_UNITS, RAW_MAP, warn),
    paths,
    grid,
    tech,
  };

  return {
    content,
    report: {
      label: content.label,
      unitCount: Object.keys(units).length,
      enemyCount: Object.keys(enemies).length,
      waveCount: waves.length,
      techCount: Object.keys(tech).length,
      warnings,
    },
  };
}

/** 便捷入口（不需要 warnings 时用）。 */
export function loadRealContent(): SimContent {
  return loadRealContentWithReport().content;
}
