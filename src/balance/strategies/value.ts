/**
 * 行动价值函数 —— `heuristic` 的贪心内核，也是 `balanced` 清单饱和后的兜底
 *
 * ## 这是什么、不是什么
 *
 * 契约 §14.9 已把本策略**更名为 `heuristic`**：它不是策划案 §10.2 说的
 * 「贪心搜索最佳建造序列」，而是「价值/金币贪心 + 波次预告」。`src/sim/clone.ts`
 * 现在提供了 `cloneWorld(w)`，但真前向搜索的成本（每决策点 × 候选数 × 地平线）
 * 在 headless 跑批里仍然过高，本轮**未实现**（见汇报的「未验证」）。
 *
 * ## 价值函数（全整数）
 *
 * ```
 * stealPerSec = stealBase × levelMul[tier-1] × (1 + 0.02×attack) / intervalSec × 科技窃金乘区
 * dpsEff      = attack / intervalSec × 克制矩阵(下一波护甲构成) × 科技攻击乘区 × 科技攻速乘区
 * score       = stealPerSec × stealW + dpsEff × DPS_GOLD_EQ × dpsW + 木材价值
 * 密度        = score × 1000 / costGold
 * ```
 *
 * `dpsW` 会在「上一波漏怪 / 生命告急 / 输出塔不足」时被放大。
 *
 * ## 科技（契约 §14.2）
 *
 * 科技是**指数通道**（攻击 ×1.50/级、攻速 ×1.40/级），是后期唯一的强度来源，
 * 所以 `techOptions()` 给每条科技线的下一级算**边际价值**：
 * `边际价值 = 军队总价值 × (新乘区 / 旧乘区 − 1)`（对 `mul` 模式精确）。
 */
import { FIXED_SCALE, fmul, mulDiv, truncDiv, type Fixed } from '../../sim/fixed';
import { COVERAGE_TARGET_PERMILLE } from '../acceptance';
import {
  armorIndex,
  attackIndex,
  type AttackType,
  type ArmorType,
  type DifficultyId,
  type SimContent,
  type TechDef,
  type UnitDef,
} from '../../sim/content';
import { resolveSlot, techValueAtLevel, type TechTargetSlot } from '../../sim/tech';
import type { WorldSnapshot } from '../../sim/types';

/** 窃金价值权重。 */
export const STEAL_WEIGHT = 1;
/**
 * ★ **覆盖率低于目标时的窃金权重**（主策划裁决 3 的修复）
 *
 * ## 为什么需要它（根因，实测）
 *
 * `heuristic` 一座窃金塔都不建（`thiefCount = 0.0`、覆盖率 **0.0%**）——**那个 0% 是假数字**：
 * 不是"偷得少"，是"没有偷的塔"。
 *
 * 根因是**两个叠加的效应**：
 * ① 经济与输出在价值密度上**近乎平手**：T1 小偷 7 金/秒 × `STEAL_WEIGHT`(1) = 7，
 *    弓箭手 14 dps × `DPS_GOLD_EQ`(0.4) = 5.6；而密度还要除以造价（小偷 250 / 弓箭手 200）
 *    → 两者几乎相等 ⇒ **"建哪个"实际由 `rootSet` 的遍历顺序决定**（脆弱的平手）。
 * ② `weightsFor` 在 `mix.output < 路数×2` 时把 `dpsW` 钉到 `SAFETY_WEIGHT`(6)，
 *    该条件前期长期成立 ⇒ 输出被永久放大 ⇒ **平手一旦倒向输出就再也不会回头**（双稳态 + 迟滞）。
 *    这也解释了 `DPS_GOLD_EQ` 扫描为什么只有 2 种结果（那个比较只会翻一次，翻完被 ② 锁住）。
 *
 * ## 这个常数的角色（不是"设定分配"，而是"按需打破平手"）
 *
 * 覆盖率**低于数据目标**（`acceptance.ts` 的 `stealCoverageMin/Max` 中值）时把窃金权重 ×3，
 * 高于目标时回到 1 ⇒ "建经济还是建输出"由**实测覆盖率**决定，而不是由遍历顺序决定。
 *
 * ⚠️ 诚实说明：`3` 本身仍是启发式（和 `DPS_GOLD_EQ` 一样没有文档来源）。区别在于它的**角色**
 * 从"设定分配比例"降级为"在一个近乎平手的比较里按需推一把"。
 */
export const BELOW_TARGET_STEAL_WEIGHT = 3;
/** 安全权重（漏怪 / 生命告急 / 输出不足时放大 DPS 价值）。 */
export const DEFAULT_SAFETY_WEIGHT = 6;

let safetyWeight = DEFAULT_SAFETY_WEIGHT;

/** ★ 仅供实验扫描：覆盖 SAFETY_WEIGHT（闩锁强度的那个常数）。生产路径永远用默认值。 */
export function setSafetyWeightForExperiment(v: number): void {
  safetyWeight = v;
}

/** 当前生效的安全权重（实验可能覆盖过）。 */
export function currentSafetyWeight(): number {
  return safetyWeight;
}

/** 兼容旧引用（只读快照）。 */
export const SAFETY_WEIGHT = DEFAULT_SAFETY_WEIGHT;
/** 生命低于该千分比视为告急。 */
export const LOW_LIVES_PCT = 600;

/**
 * 「1 点伤害/秒」折算成「多少金币/秒」的等价权重（千分比定点：400 = 0.4 金/秒）。
 * ⚠️ 启发式标定值（策划案没给「伤害 → 价值」的换算）。
 *
 * ## ★ 这是**从未标定过的自由参数**（主策划裁决 2 点名的那个）
 *
 * 它决定"1 点 DPS 值多少金币"，也就决定了 AI 在「买输出塔」与「买窃金塔」之间怎么选 ——
 * **整个经济/存活分配都挂在它身上**。而它一直是一个手写的 400。
 *
 * 本项目已经三次栽在"便宜的、看起来有用的、回不了本的东西"上：
 * ① `balanced` 从不研究科技（250 金的扩建行被"买得起就买"吃掉）
 * ② 漏怪时买 `worker`（`attack = 0`，花光现金换零 DPS）
 * ③ 不留限制时**优先买 200 金的弓箭手**（把本该变成窃金塔的钱吃掉）
 * 三次都是"局部贪心把预算喂给最便宜的东西"，而这个换算率正控制着那个贪心。
 *
 * 扫描见 `src/balance/dps-eq-scan.ts`。默认值保持 400 **不变**（扫描只在实验进程里覆盖）。
 */
export const DEFAULT_DPS_GOLD_EQ = 400;

let dpsGoldEq = DEFAULT_DPS_GOLD_EQ;

/**
 * ★ **仅供实验扫描**：覆盖 `DPS_GOLD_EQ`。
 *
 * 这是一个模块级可变状态（正常情况下应当避免）—— 这里接受它，是因为
 * ① 扫描脚本是**独立进程**，② 它让"扫一个从未标定的参数"不必把参数穿透 20 个调用点，
 * ③ 每次设置都有显式日志。**生产路径永远用 `DEFAULT_DPS_GOLD_EQ`**。
 */
export function setDpsGoldEqForExperiment(v: number): void {
  dpsGoldEq = v;
}

/** 当前生效的换算率（实验可能覆盖过）。 */
export function currentDpsGoldEq(): number {
  return dpsGoldEq;
}

/** 兼容旧引用：**只读快照**（值可能被实验覆盖，别当常量用）。 */
export const DPS_GOLD_EQ = DEFAULT_DPS_GOLD_EQ;

/**
 * 「1 木/秒」折算成「多少金币/秒」的等价权重（千分比定点：5000 = 5 金/秒）。
 * ⚠️ 启发式标定值：科技树全解锁需要 26,670 木，而木材只能靠小精灵与窃金附带；
 * 从 `sprite_advanced`（9,000 金 → 2 木/秒）反推 ≈ 4.5 金/木，取整为 5。
 */
export const WOOD_GOLD_EQ = 5000;

/**
 * 克制倍率 —— 与 `src/sim/world.ts` 的 `counterMul()` **同公式**。
 * 那边签名要求 `WorldState`，AI 只有快照，所以这里复刻；
 * `tests/sim/solvability.spec.ts` 会用真实世界逐格比对两者，防止语义漂移。
 */
export function counterMulOf(content: SimContent, diff: DifficultyId, atk: AttackType, armor: ArmorType): Fixed {
  const c = content.constants;
  const row = c.counterMatrixStandard[attackIndex(atk)];
  const col = armorIndex(armor, c.armorAlias);
  let mul = (row ? row[col] : undefined) ?? FIXED_SCALE;
  const d = c.difficulty[diff];
  if (d && d.compressed) {
    mul = FIXED_SCALE + fmul(mul - FIXED_SCALE, c.compressedFactor);
    if (mul < c.compressedFloor) mul = c.compressedFloor;
  }
  return mul;
}

export function intervalTicksOf(content: SimContent, u: UnitDef): number {
  return Math.max(1, truncDiv(u.attackInterval * content.constants.tickRate, FIXED_SCALE));
}

/** 窃金核心项（不含暴击期望、不含抗性、不含圣物）—— 只用于**候选排序**。 */
export function stealRateOf(content: SimContent, u: UnitDef, attack: Fixed, techStealMul: Fixed = FIXED_SCALE): Fixed {
  if (u.stealBase <= 0) return 0;
  const c = content.constants;
  const levelMul = c.levelMul[u.tier - 1] ?? FIXED_SCALE;
  const atkBonus = FIXED_SCALE + mulDiv(c.stealAtkCoef, attack, FIXED_SCALE);
  const perHit = fmul(fmul(fmul(u.stealBase, levelMul), atkBonus), techStealMul);
  const ticks = intervalTicksOf(content, u);
  return truncDiv(perHit * c.tickRate, ticks);
}

/** 有效 DPS（已过克制矩阵，按下一波护甲构成加权，含科技攻击/攻速乘区）。 */
export function effectiveDps(
  content: SimContent,
  diff: DifficultyId,
  u: UnitDef,
  attack: Fixed,
  snap: WorldSnapshot,
): Fixed {
  if (u.attack <= 0 || attack <= 0) return 0;
  let counters = 0;
  let count = 0;
  const nw = snap.nextWave;
  if (nw) {
    for (const g of nw.groups) {
      const mul = counterMulOf(content, diff, u.attackType, g.armorType);
      counters += mul * g.count;
      count += g.count;
    }
  }
  const avg = count > 0 ? truncDiv(counters, count) : FIXED_SCALE;
  const tech = snap.techEffects;
  const attackWithTech = fmul(attack, tech.attackMul);
  const baseTicks = Math.max(1, truncDiv(u.attackInterval * content.constants.tickRate, FIXED_SCALE));
  const ticks = Math.max(1, mulDiv(baseTicks, FIXED_SCALE, tech.attackSpeedMul));
  const base = truncDiv(attackWithTech * content.constants.tickRate, ticks);
  return fmul(base, avg);
}

/** 周期产木的每秒价值（定点金/秒）。 */
export function woodValueOf(u: UnitDef): Fixed {
  if (u.woodPerSecond <= 0) return 0;
  return fmul(u.woodPerSecond, WOOD_GOLD_EQ);
}

export interface ValueWeights {
  stealW: number;
  dpsW: number;
  /** 触发安全权重的理由（进报告，便于解释 AI 行为） */
  reason: string;
}

export interface TowerMix {
  economy: number;
  output: number;
  support: number;
  /** 产木单位数量 */
  wood: number;
  total: number;
}

/** 按「是否有窃金 / 是否有伤害 / 是否产木」粗分塔的角色（用于配比约束）。 */
export function towerMix(content: SimContent, snap: WorldSnapshot): TowerMix {
  const mix: TowerMix = { economy: 0, output: 0, support: 0, wood: 0, total: 0 };
  for (const t of snap.towers) {
    const d = content.units[t.unitId];
    mix.total++;
    if (!d) continue;
    if (d.stealBase > 0) mix.economy++;
    else if (d.attack > 0) mix.output++;
    else mix.support++;
    if (d.woodPerSecond > 0) mix.wood++;
  }
  return mix;
}

/**
 * 权重：默认「贪钱」，但下列任一情况把 DPS 权重放大 ——
 * ① 上一波漏过怪 / ② 生命跌破 60% → ×6；
 * ③ 输出塔不足 `outputNeeded` → ×6；
 * ④ 经济塔占比超过 40% → ×3。
 */
export function weightsFor(
  snap: WorldSnapshot,
  lastWaveLeaks: number,
  startLives: number,
  mix: TowerMix,
  outputNeeded: number,
  /** 实测覆盖率（千分比）—— 低于数据目标时按需放大窃金权重（见 `BELOW_TARGET_STEAL_WEIGHT`） */
  coverage = 0,
): ValueWeights {
  const reasons: string[] = [];
  let dpsW = 1;
  if (lastWaveLeaks > 0) {
    dpsW = safetyWeight;
    reasons.push('上波漏怪');
  }
  if (startLives > 0 && snap.lives * FIXED_SCALE < startLives * LOW_LIVES_PCT) {
    dpsW = safetyWeight;
    reasons.push('生命<60%');
  }
  if (mix.output < outputNeeded) {
    dpsW = safetyWeight;
    reasons.push(`输出塔不足(${mix.output}/${outputNeeded})`);
  } else if (mix.total >= 5 && mix.economy * 1000 > mix.total * 400) {
    if (dpsW < 3) dpsW = 3;
    reasons.push('经济塔>40%');
  }
  return {
    // ★ 覆盖率感知：让「经济 vs 输出」由**实测需求**决定，而不是由 `rootSet` 的遍历顺序决定
    stealW: coverage < COVERAGE_TARGET_PERMILLE ? BELOW_TARGET_STEAL_WEIGHT : STEAL_WEIGHT,
    dpsW,
    reason: reasons.join('+') || '常规',
  };
}

/** 综合价值（定点）：窃金按金/秒计，伤害与木材按等价权重折算成金/秒后相加。 */
export function valueOf(
  content: SimContent,
  diff: DifficultyId,
  u: UnitDef,
  attack: Fixed,
  snap: WorldSnapshot,
  w: ValueWeights,
): Fixed {
  const steal = stealRateOf(content, u, attack, snap.techEffects.stealMul);
  const dps = effectiveDps(content, diff, u, attack, snap);
  const wood = woodValueOf(u);
  return steal * w.stealW + fmul(dps, dpsGoldEq) * w.dpsW + wood;
}

/** 价值密度（每金币的价值，定点）。 */
export function density(value: Fixed, costGold: Fixed): Fixed {
  if (costGold <= 0) return value;
  return truncDiv(value * FIXED_SCALE, costGold);
}

// ─────────────────────────────────────────────────────────────────────────────
// 科技候选（契约 §14.2：乘法是指数通道，必须进 AI 的选择集）
// ─────────────────────────────────────────────────────────────────────────────

export interface ArmyValue {
  /** Σ 塔的窃金价值（定点金/秒） */
  steal: Fixed;
  /** Σ 塔的伤害价值（定点，已折算成金/秒） */
  dps: Fixed;
  /** Σ 塔的木材价值（定点金/秒） */
  wood: Fixed;
  towerCount: number;
}

/** 统计当前军队价值（用于算科技的边际收益）。 */
export function armyValueOf(
  content: SimContent,
  diff: DifficultyId,
  snap: WorldSnapshot,
  w: ValueWeights,
): ArmyValue {
  const out: ArmyValue = { steal: 0, dps: 0, wood: 0, towerCount: 0 };
  for (const t of snap.towers) {
    const d = content.units[t.unitId];
    if (!d) continue;
    out.steal += stealRateOf(content, d, t.attack, snap.techEffects.stealMul) * w.stealW;
    out.dps += fmul(effectiveDps(content, diff, d, t.attack, snap), dpsGoldEq) * w.dpsW;
    out.wood += woodValueOf(d);
    out.towerCount++;
  }
  return out;
}

export interface TechOption {
  techId: string;
  slot: TechTargetSlot;
  nextLevel: number;
  costGold: Fixed;
  costWood: Fixed;
  marginalValue: Fixed;
  density: Fixed;
}

/**
 * 生成**科技候选**（每条线只给「下一级」一个候选）。
 *
 * 边际价值按槽位分别近似（全整数）：
 *
 * | 槽位 | 边际价值 | 理由 |
 * |---|---|---|
 * | `attackMul` | `(army.steal + army.dps) × (next/cur − 1)` | 攻击同时放大 DPS 与窃金（`stealAtkCoef`） |
 * | `attackSpeedMul` | 同上 | 攻速放大开火频率（DPS 与窃金频率同时受益） |
 * | `stealMul` | `army.steal × (next/cur − 1)` | 只放大窃金 |
 * | `rangeMul` | `army.dps × (next/cur − 1) / 2` | 射程只提高覆盖率，效果打折（÷2） |
 * | `critRateAdd` | `army.steal × Δp × (critMul − 1)` | `E[crit] = 1 + p(critMul−1)` 对 p 求导 |
 * | `critMulAdd` | `army.steal × p × ΔcritMul`（p 估 200‰） | 同上对 critMul 求导 |
 * | `populationAdd` | `每人均塔价值 × Δcount` | 多一个塔位 = 多一座平均强度的塔 |
 * | `woodMul` | `army.wood × (next/cur − 1)` | 只放大木材产出 |
 */
export function techOptions(content: SimContent, snap: WorldSnapshot, army: ArmyValue, critMulEstimate: Fixed = 2000): TechOption[] {
  const out: TechOption[] = [];
  const table = content.tech;
  if (!table) return out;

  const perTower = army.towerCount > 0 ? truncDiv(army.steal + army.dps, army.towerCount) : 0;

  for (const view of snap.techs) {
    const def: TechDef | undefined = table[view.id];
    if (!def || view.level >= view.maxLevel) continue;
    if (!view.affordable) continue;
    // ★ 契约 §16：槽位由**数据侧**的 `TechDef.target` 决定（适配层已映射），
    //   引擎的 `resolveSlot` 优先读 target，读不到才回退 id 硬映射。
    //   我在 balance 侧不再维护自己的 id→槽位表 —— 那份重复映射正是上一轮漏 `target` 的根源。
    const resolved = resolveSlot(def);
    if (resolved.slot === null) continue; // 引擎不认识这条线：跳过（快照有 unimplemented 标记）
    const slot = resolved.slot;
    const cur = techValueAtLevel(def, view.level);
    const next = techValueAtLevel(def, view.level + 1);
    let marginal = 0;
    switch (slot) {
      case 'attackMul':
      case 'attackSpeedMul': {
        if (cur > 0) marginal = truncDiv((army.steal + army.dps) * (next - cur), cur);
        break;
      }
      case 'stealMul': {
        if (cur > 0) marginal = truncDiv(army.steal * (next - cur), cur);
        break;
      }
      case 'rangeMul': {
        if (cur > 0) marginal = truncDiv(truncDiv(army.dps * (next - cur), cur), 2);
        break;
      }
      case 'critRateAdd': {
        const dp = next - cur; // 千分比增量（50 = +5%）
        marginal = mulDiv(fmul(army.steal, dp), critMulEstimate - FIXED_SCALE, FIXED_SCALE);
        break;
      }
      case 'critMulAdd': {
        const dm = next - cur;
        marginal = mulDiv(fmul(army.steal, 200), dm, FIXED_SCALE);
        break;
      }
      case 'populationAdd': {
        marginal = perTower * (next - cur);
        break;
      }
      case 'woodMul': {
        if (cur > 0) marginal = truncDiv(army.wood * (next - cur), cur);
        break;
      }
    }
    if (marginal <= 0) continue;
    out.push({
      techId: view.id,
      slot,
      nextLevel: view.level + 1,
      costGold: view.nextGold,
      costWood: view.nextWood,
      marginalValue: marginal,
      density: density(marginal, Math.max(1, view.nextGold)),
    });
  }
  return out;
}

export type { SimContent, UnitDef, WorldSnapshot, DifficultyId };

/**
 * ★ **实验参数的保存/还原助手**（供测试的 `finally` 使用）。
 *
 * 存在的理由：测试里若漏还原，就会把状态泄漏给**同进程后续的用例** ——
 * 那正是"静默的实验后门"最危险的形态（一个用例改了参数，另一个用例的结论因此变错而无人知道）。
 */
export function cloneSafeDefaults(): { dpsGoldEq: number; safetyWeight: number } {
  return { dpsGoldEq, safetyWeight };
}

export function restoreDefaults(saved: { dpsGoldEq: number; safetyWeight: number }): void {
  dpsGoldEq = saved.dpsGoldEq;
  safetyWeight = saved.safetyWeight;
}