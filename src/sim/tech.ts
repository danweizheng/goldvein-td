/**
 * 科技系统 —— 策划案 §4.4；契约 §14.2 裁决（**线性 → 乘法**）
 *
 * ## 为什么这一条决定游戏能不能通关
 *
 * `balance-eng` 实测：无限金钱 + 40 座满级飞贼仍死在第 22 波。根因是
 * **缺少「金币 → DPS」的指数通道**：血量涨 1.283^29 = 1373×，收入涨 1.20^29 = 198×，
 * 而塔的强度只有离散的 tier（~52×）+ 线性科技（+50%）。超出塔位容量的收入
 * 转换不成 DPS。科技改成乘法后：`tier 52.5× × 攻击 7.59× × 攻速 5.38× = 2144×`。
 *
 * ## 定点与溢出（汇报要求说明的点）
 *
 * 科技乘数用 `fpow(effectPerLevel, level)` 算，等级 ≤ 5、effectPerLevel ≤ 1500：
 *   - `fpow` 内部在 ×1000 精度域累乘，中间值最大 `1e6 × 1.5^5 = 7.6e6`，远小于 2^53；
 *   - 乘数本身最大 7593（7.59×）；
 *   - 多线相乘时**逐次 `fmul`**（每次 ÷1000），中间值始终保持「定点量级」，
 *     不会出现 `a×b×c` 一次性相乘导致的膨胀；
 *   - 应用到大数（如 `attack = 3e4 × 7593 / 1000 = 2.28e5`）也远未接近 2^53。
 * 详见 `src/sim/__tests__/tech.spec.ts` 的溢出断言（含"满级全开"极端值）。
 */
import { FIXED_SCALE, fmul, fpow, mulDiv, truncDiv, type Fixed } from './fixed';
import {
  TECH_ARCHIVE_COST_REDUCTION_PCT_DEFAULT,
  type SimConstants,
  type TechDef,
  type TechTable,
  type TechTarget,
} from './content';

/**
 * 科技作用槽位（引擎内部的乘区/加项）。
 *
 * ## 契约 §14.20：这个映射现在**由数据驱动**，不再看 `id`
 *
 * 之前这里是一张硬编码的 id→槽位表 —— 违反铁律 5（加一条科技线就要改引擎代码）。
 * §14.20 裁决 `TechDef` 新增 `target` 枚举，引擎读它。
 * 现在数据写 `target: 'range'` 就一定作用到射程，**哪怕它的 `id` 叫 `attack`**。
 */
export type TechTargetSlot =
  | 'attackMul'
  | 'attackSpeedMul'
  | 'rangeMul'
  | 'stealMul'
  | 'critRateAdd'
  | 'critMulAdd'
  | 'populationAdd'
  | 'woodMul';

/** 契约 §14.20 的 `TechTarget` → 引擎槽位（唯一映射；与 id 无关）。 */
export const SLOT_BY_TARGET: Readonly<Record<TechTarget, TechTargetSlot>> = {
  attack: 'attackMul',
  speed: 'attackSpeedMul',
  range: 'rangeMul',
  steal: 'stealMul',
  critRate: 'critRateAdd',
  critMul: 'critMulAdd',
  population: 'populationAdd',
  baseLevel: 'woodMul',
};

/**
 * @deprecated 旧 id→槽位硬编码表，**仅为兼容 `target` 尚未落盘的数据**保留。
 * 一旦数据补齐（`legacyTargetIds` 为空）即可删除。
 */
const LEGACY_SLOT_BY_ID: Readonly<Record<string, TechTargetSlot>> = {
  attack: 'attackMul',
  attack_speed: 'attackSpeedMul',
  range: 'rangeMul',
  steal_efficiency: 'stealMul',
  steal_crit_rate: 'critRateAdd',
  steal_crit_mul: 'critMulAdd',
  population: 'populationAdd',
  base_level: 'woodMul',
};

/** 各槽位的作用方向，供报告/UI 显示（`mul` 累乘、`add` 累加）。 */
export const SLOT_MODE: Readonly<Record<TechTargetSlot, 'mul' | 'add'>> = {
  attackMul: 'mul',
  attackSpeedMul: 'mul',
  rangeMul: 'mul',
  stealMul: 'mul',
  woodMul: 'mul',
  critRateAdd: 'add',
  critMulAdd: 'add',
  populationAdd: 'add',
};

/** 解析作用槽位：**优先数据的 `target`**，缺失才退回旧 id 表（并标记为 legacy）。 */
export function resolveSlot(def: TechDef): { slot: TechTargetSlot | null; via: 'target' | 'legacy' | 'none' } {
  if (def.target !== undefined) {
    const slot = SLOT_BY_TARGET[def.target];
    return slot === undefined ? { slot: null, via: 'none' } : { slot, via: 'target' };
  }
  const legacy = LEGACY_SLOT_BY_ID[def.id];
  return legacy === undefined ? { slot: null, via: 'none' } : { slot: legacy, via: 'legacy' };
}

/** 全表作用于塔/敌人的最终乘区与加项。 */
export interface TechEffects {
  /** 攻击乘区（千分比，1000 = 不变） */
  attackMul: Fixed;
  /** 攻速乘区（千分比，作用于**频率**：1400 = 快 40%） */
  attackSpeedMul: Fixed;
  /** 射程乘区 */
  rangeMul: Fixed;
  /** 窃金效率乘区 */
  stealMul: Fixed;
  /** 木材产出乘区 */
  woodMul: Fixed;
  /** 窃金暴击率加项（千分比，50 = +5%） */
  critRateAdd: Fixed;
  /** 窃金暴击倍率加项（千分比，250 = +25%） */
  critMulAdd: Fixed;
  /** 人口上限加项（普通整数） */
  populationAdd: number;
  /** 命中的科技等级（只读，用于 UI/报告） */
  levels: Record<string, number>;
  /** 表里存在但引擎不认识的科技 id（**必须暴露出来，不能静默忽略**） */
  unknownTechIds: string[];
  /**
   * 靠**旧 id 表**（而不是数据里的 `target`）解析出来的科技 id。
   * 契约 §14.20 生效后这里应当为空；非空即代表数据尚未迁移 —— **不静默**。
   */
  legacyTargetIds: string[];
}

/** 无科技时的中性效果（所有乘区 = 1000）。 */
export function neutralTechEffects(): TechEffects {
  return {
    attackMul: FIXED_SCALE,
    attackSpeedMul: FIXED_SCALE,
    rangeMul: FIXED_SCALE,
    stealMul: FIXED_SCALE,
    woodMul: FIXED_SCALE,
    critRateAdd: 0,
    critMulAdd: 0,
    populationAdd: 0,
    levels: {},
    unknownTechIds: [],
    legacyTargetIds: [],
  };
}

/**
 * 单条科技在指定等级下的效果值。
 *
 * - `mul` + permille：`effectPerLevel^level`（1500, level 5 → 7593 = ×7.59）
 * - `add` + permille：`FIXED_SCALE + effectPerLevel × level`（50, level 5 → 1250）
 * - `add` + count：`effectPerLevel × level`（2, level 5 → 10，纯计数）
 * - `mul` + count：无意义 → 退化为 add 并计入 `unknownTechIds` 之外（调用方决定）
 */
export function techValueAtLevel(def: TechDef, level: number): Fixed {
  if (level <= 0) return def.effectUnit === 'count' ? 0 : FIXED_SCALE;
  const mode = def.effectMode ?? 'add';
  if (def.effectUnit === 'count') {
    // 纯计数（人口）：乘法的语义不成立，按加法处理
    return def.effectPerLevel * level;
  }
  if (mode === 'mul') return fpow(def.effectPerLevel, level);
  return FIXED_SCALE + def.effectPerLevel * level;
}

/** 由「科技等级表」算出全部作用效果（纯函数，无浮点）。 */
export function computeTechEffects(
  tech: TechTable | undefined,
  levels: Readonly<Record<string, number>>,
): TechEffects {
  const out = neutralTechEffects();
  if (!tech) return out;

  // 固定顺序遍历 id，保证与插入顺序无关（确定性）
  const ids = Object.keys(tech).sort();

  // 第一遍：**与等级无关**地给整张表做体检。
  // ⚠️ 这一步必须独立于 `level > 0`：否则"数据缺 target"/"id 未实装"这两件事
  //    只在玩家研究过之后才暴露 —— 新局（全 0 级）时它们是**不可见**的，
  //    而那恰恰是最需要知道的时刻（这正是我第一版写成 level 门内、实测
  //    `legacyTargetIds` 为空却 `target === undefined` 的原因）。
  for (const id of ids) {
    const def = tech[id] as TechDef;
    const resolved = resolveSlot(def);
    if (resolved.via === 'legacy' && !out.legacyTargetIds.includes(id)) {
      out.legacyTargetIds.push(id);
    }
    if (resolved.slot === null && !out.unknownTechIds.includes(id)) {
      out.unknownTechIds.push(id);
    }
  }

  for (const id of ids) {
    const level = levels[id] ?? 0;
    if (level <= 0) {
      out.levels[id] = 0;
      continue;
    }
    const def = tech[id] as TechDef;
    // ★ 契约 §14.20：作用目标来自**数据**（`def.target`），不再由 id 推断
    const resolved = resolveSlot(def);
    if (resolved.slot === null) {
      out.levels[id] = level;
      continue;
    }
    const slot = resolved.slot;
    const value = techValueAtLevel(def, level);
    out.levels[id] = level;
    switch (slot) {
      case 'attackMul':
        out.attackMul = fmul(out.attackMul, value);
        break;
      case 'attackSpeedMul':
        out.attackSpeedMul = fmul(out.attackSpeedMul, value);
        break;
      case 'rangeMul':
        out.rangeMul = fmul(out.rangeMul, value);
        break;
      case 'stealMul':
        out.stealMul = fmul(out.stealMul, value);
        break;
      case 'woodMul':
        out.woodMul = fmul(out.woodMul, value);
        break;
      case 'critRateAdd':
        // 加法线：value 是「千分比总量」（1250 = +25%），加项取相对 1000 的增量
        out.critRateAdd += value - FIXED_SCALE;
        break;
      case 'critMulAdd':
        out.critMulAdd += value - FIXED_SCALE;
        break;
      case 'populationAdd':
        out.populationAdd += value;
        break;
    }
  }
  return out;
}

/** 新局开始时的免费等级（§4.4.2：`floor(存档等级 / 除数)`，除数默认 2 → 最高白送 2 级）。 */
export function freeLevelFromArchive(archiveLevel: number, divisor: number, maxLevel: number): number {
  if (divisor <= 0) return 0;
  const free = truncDiv(Math.max(0, archiveLevel), divisor);
  return Math.min(maxLevel, Math.max(0, free));
}

/**
 * 研究到 `targetLevel`（1-indexed）的实际造价（§4.4.2）：
 * `实际造价 = 基础造价 × (1 − 0.08 × 存档等级)`
 *
 * `costReductionPct` 是**每级存档等级的折扣**（千分比/级，constants = 80）。
 */
export function researchCost(
  def: TechDef,
  targetLevel: number,
  archiveLevel: number,
  costReductionPct: Fixed,
): { gold: Fixed; wood: Fixed } {
  const base = def.costPerLevel[targetLevel - 1];
  if (!base) return { gold: 0, wood: 0 };
  const reduce = Math.max(0, Math.min(FIXED_SCALE, costReductionPct * Math.max(0, archiveLevel)));
  const keep = FIXED_SCALE - reduce;
  return { gold: fmul(base.gold, keep), wood: fmul(base.wood, keep) };
}

/** 前置科技是否满足（每条至少 1 级）。 */
export function requiresSatisfied(def: TechDef, levels: Readonly<Record<string, number>>): boolean {
  for (const req of def.requires ?? []) {
    if ((levels[req] ?? 0) < 1) return false;
  }
  return true;
}

/** 效果的可读描述（报告/UI 用，纯整数运算）。 */
export function describeTechEffects(e: TechEffects): string {
  const pct = (v: Fixed): string => (v / 1000).toFixed(2) + 'x';
  const add = (v: Fixed): string => '+' + (v / 10).toFixed(1) + '%';
  return (
    `attack ${pct(e.attackMul)} / atkSpeed ${pct(e.attackSpeedMul)} / range ${pct(e.rangeMul)} / ` +
    `steal ${pct(e.stealMul)} / wood ${pct(e.woodMul)} / critRate ${add(e.critRateAdd)} / ` +
    `critMul ${add(e.critMulAdd)} / pop +${e.populationAdd}` +
    (e.unknownTechIds.length > 0 ? ` / 未知科技 id: ${e.unknownTechIds.join(',')}` : '')
  );
}

/** 供渲染/UI 的科技视图（快照用）。 */
export interface TechView {
  id: string;
  name: string;
  level: number;
  maxLevel: number;
  /** 下一级造价（已含存档折扣）；已满级为 0 */
  nextGold: Fixed;
  nextWood: Fixed;
  /** 是否可研究（钱够 + 未满级 + 前置满足）；真正扣钱在 step 里做 */
  affordable: boolean;
  requires: string[];
  /** 引擎不认识的科技线（效果未生效）—— UI 应当显示为"未实装" */
  unimplemented: boolean;
}

/** 构造一条科技的视图。`tech` 表里不存在该 id 时返回 null。 */
export function techView(
  def: TechDef,
  level: number,
  archiveLevel: number,
  gold: Fixed,
  wood: Fixed,
  c: SimConstants,
  levels: Readonly<Record<string, number>>,
): TechView {
  const maxed = level >= def.maxLevel;
  const cost = maxed
    ? { gold: 0, wood: 0 }
    : researchCost(
        def,
        level + 1,
        archiveLevel,
        c.techArchiveCostReductionPct ?? TECH_ARCHIVE_COST_REDUCTION_PCT_DEFAULT,
      );
  return {
    id: def.id,
    name: def.name,
    level,
    maxLevel: def.maxLevel,
    nextGold: cost.gold,
    nextWood: cost.wood,
    affordable: !maxed && gold >= cost.gold && wood >= cost.wood && requiresSatisfied(def, levels),
    requires: [...(def.requires ?? [])],
    unimplemented: resolveSlot(def).slot === null,
  };
}

/**
 * @deprecated 兼容别名（`balance-eng` 的 `strategies/value.ts` 仍在 import）。
 * 新代码请用 `TechTargetSlot` / `resolveSlot` / `SLOT_BY_TARGET`。
 * 契约 §14.20 落地后（数据补齐 `target`）这两个别名会被删除。
 */
export type TechSlot = TechTargetSlot;
export const TECH_SLOT_BY_ID: Readonly<Record<string, TechTargetSlot>> = LEGACY_SLOT_BY_ID;

/** 便捷：`mulDiv` 包装，供外部一致地做「比率 × 量」的换算。 */
export function scaleByRatio(value: Fixed, ratio: Fixed): Fixed {
  return mulDiv(value, ratio, FIXED_SCALE);
}
