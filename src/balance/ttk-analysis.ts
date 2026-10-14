/**
 * 塔的 DPS 上限 vs 波次血量需求的**可行性分析**（与 AI 策略无关的硬边界）
 *
 * ## 为什么需要这个模块
 *
 * 跑批只能告诉你「某个 AI 打到了第几波」。要判断「这是 AI 太弱，还是数据不可能通关」，
 * 必须把**上界**算出来：即使玩家拥有 `populationCap` 座**当前波次最优**的塔、
 * 全部满射程覆盖、全程开火，能提供的 DPS 也不够清掉某一波时，那一波就是**数学上打不过**的。
 *
 * 这是一个**宽松上界**（比任何真实阵容都强），所以「上界 < 需求」是不可通关的充分证据。
 *
 * ## 契约 §14.4：这条检查现在是 CI 硬门禁
 *
 * `需求DPS(wave) / 可达DPS上界(wave) ≤ 1.0`（全部 30 波 × 5 难度）——
 * 见 `tests/sim/solvability.spec.ts`。它的缺失正是那份"数学上不可通关"的数据
 * 一路通过 49 项结构检查 + 296 条数据用例的原因。
 *
 * ## 契约 §14.2：可达上界**必须包含科技乘区**
 *
 * 科技改乘法后 `攻击 ×7.59`、`攻速 ×5.38` 是本作的主要强度通道；不含科技的
 * "可达上界"会给出错误的悲观结论（上一轮就是这么得出 9.0× 的）。
 * 这里直接复用 `src/sim/tech.ts` 的 `computeTechEffects`，保证与引擎同一真相。
 *
 * 全程整数/定点。
 */
import { FIXED_SCALE, fmul, fpow, mulDiv, truncDiv, type Fixed } from '../sim/fixed';
import { armorIndex, attackIndex, type ArmorType, type DifficultyId, type SimContent, type UnitDef } from '../sim/content';
import { computeTechEffects, type TechEffects } from '../sim/tech';

/** 敌人通过整条路径的估计时间（秒）。map.json 的路径 34–38 格、慢速敌人 1.2 格/秒。 */
const TRAVEL_SECONDS = 18;

export interface WaveFeasibility {
  wave: number;
  /** 本波敌人数量 */
  enemyCount: number;
  /** 本波敌人总血量（定点） */
  totalHp: Fixed;
  /** 本波总钱包（定点） */
  totalWallet: Fixed;
  /** 本波从第一个生成到最后一个走完宝库的估计时长（秒） */
  durationSec: number;
  /** 通关本波所需的平均 DPS（定点） */
  requiredDps: Fixed;
  /** 上界：`populationCap` 座「本波最优单塔（含满级科技）」的总 DPS（定点） */
  maxDps: Fixed;
  /** 上界所用的塔 */
  bestUnit: string;
  /** 需求 / 上界（千分比，> 1000 表示数学上不可能） */
  requiredOverMax: number;
  /** 单体最优塔对该波代表敌人的 TTK（秒，定点） */
  ttkSec: Fixed;
  /** 本波代表敌人（血量最高者）的单体血量 */
  toughestHp: Fixed;
}

export interface TtkAnalysis {
  difficultyId: DifficultyId;
  populationCap: number;
  /** 本次分析用的科技口径（`none` = 不含科技乘区，`max` = 满级科技 + 人口加项） */
  techMode: TtkTechMode;
  /** 上界使用的科技乘区 */
  tech: { attackMul: Fixed; attackSpeedMul: Fixed; rangeMul: Fixed };
  rows: WaveFeasibility[];
  /** 是否存在 requiredOverMax > 1000 的波次 */
  hasImpossibleWave: boolean;
  /** 第一个不可能波次 */
  firstImpossibleWave: number | null;
  /** 全程总血量 / 总钱包 */
  sumHp: Fixed;
  sumWallet: Fixed;
  /** 把「全程总血量」按「cap 座最优塔 × 全程游戏时长」折算的可击伤总量上界 */
  totalDamageUpperBound: Fixed;
  /** 全部 30 波 × 该难度是否都 ≤ 1.0（契约 §14.4 的门禁口径） */
  solvable: boolean;
  verdict: string;
}

/** 满级科技乘区（全部科技线点满）——「可达 DPS 上界」用的就是这个。 */
export function maxedTechEffects(content: SimContent): TechEffects {
  const levels: Record<string, number> = {};
  for (const [id, def] of Object.entries(content.tech ?? {})) levels[id] = def.maxLevel;
  return computeTechEffects(content.tech, levels);
}

/**
 * 上界里要不要并入科技乘区。⚠️ **没有默认值，调用方必须表态**（主策划裁决）。
 *
 * - `'none'`：不并入 —— 与 `engine-dev` 的 `src/sim/__tests__/solvability-tech.spec.ts`
 *   的口径一致（它自己按模式把 `dpsMul` 乘进去，做「无科技 / 有科技」对照）。
 * - `'max'`：并入满级科技（攻击/攻速/射程/窃金）**并把人口加项计入塔位上限** ——
 *   这是契约 §14.4 门禁该用的口径。
 *
 * ## 为什么必填（这一条是事故复盘，不是洁癖）
 *
 * 上一轮我把默认值定成 `'max'`，**静默改掉了这个共享 API 的语义**，打断了
 * `engine-dev` 那份「自己在外面乘 `dpsMul`」的对照测试。它是「隐式默认 + 两个 owner
 * 各假定不同口径」的典型事故。必填会强迫每个调用点表态，这类分歧无法再静默发生。
 */
export type TtkTechMode = 'none' | 'max';

function techEffectsFor(content: SimContent, mode: TtkTechMode): TechEffects {
  if (mode === 'max') return maxedTechEffects(content);
  return computeTechEffects(undefined, {});
}

/** 单塔对该护甲的实际 DPS（定点），已含科技乘区。 */
function unitDpsVs(content: SimContent, u: UnitDef, armor: ArmorType, tech: TechEffects): Fixed {
  const baseTicks = Math.max(1, truncDiv(u.attackInterval * content.constants.tickRate, FIXED_SCALE));
  const ticks = Math.max(1, mulDiv(baseTicks, FIXED_SCALE, tech.attackSpeedMul));
  const attack = fmul(u.attack, tech.attackMul);
  const base = truncDiv(attack * content.constants.tickRate, ticks);
  const row = content.constants.counterMatrixStandard[attackIndex(u.attackType)];
  const col = armorIndex(armor, content.constants.armorAlias);
  const mul = (row ? row[col] : undefined) ?? FIXED_SCALE;
  return fmul(base, mul);
}

/** 按数量加权的「该波平均护甲构成」下的单塔 DPS。 */
function unitDpsVsWave(content: SimContent, u: UnitDef, wave: number, tech: TechEffects): Fixed {
  const def = content.waves.find((w) => w.wave === wave);
  if (!def) return 0;
  let total = 0;
  let count = 0;
  for (const g of def.groups) {
    const e = content.enemies[g.enemy];
    if (!e) continue;
    total += unitDpsVs(content, u, e.armorType, tech) * g.count;
    count += g.count;
  }
  return count > 0 ? truncDiv(total, count) : 0;
}

/** 某波某敌人的实际血量（含难度血量系数）。 */
export function enemyHpAt(content: SimContent, enemyId: string, wave: number, diff: DifficultyId): Fixed {
  const e = content.enemies[enemyId];
  const d = content.constants.difficulty[diff];
  if (!e || !d) return 0;
  return fmul(fmul(e.baseHp, fpow(content.constants.hpIndex, wave - 1)), d.hpMul);
}

/** 本波从第一个生成到最后一个走完全程的估计时长（秒，纯计数）。 */
function waveDuration(content: SimContent, wave: number): number {
  const def = content.waves.find((w) => w.wave === wave);
  if (!def) return TRAVEL_SECONDS;
  let lastSpawnMs = 0;
  for (const g of def.groups) {
    const t = g.delay + g.interval * Math.max(0, g.count - 1);
    if (t > lastSpawnMs) lastSpawnMs = t;
  }
  return Math.max(1, Math.round(lastSpawnMs / FIXED_SCALE)) + TRAVEL_SECONDS;
}

/**
 * 可行性分析。
 *
 * @param content 真实内容
 * @param diff 难度
 * @param populationCap 塔位上限；`undefined` = 用 `constants.populationCap`
 * @param techMode ★ **必填**：`'none'` = 上界不含科技乘区；`'max'` = 含满级科技 + 人口加项
 */
export function analyzeTtk(
  content: SimContent,
  diff: DifficultyId,
  populationCap: number | undefined,
  techMode: TtkTechMode,
): TtkAnalysis {
  const baseCap = populationCap ?? content.constants.populationCap;
  const tech = techEffectsFor(content, techMode);
  // 'max' 口径下人口科技会抬高塔位上限（+10 → 50），这是"可达上界"的一部分
  const cap = techMode === 'max' ? baseCap + tech.populationAdd : baseCap;
  const allUnits = Object.values(content.units);
  const rows: WaveFeasibility[] = [];
  let sumHp = 0;
  let sumWallet = 0;
  let firstImpossible: number | null = null;

  for (let n = 1; n <= content.constants.totalWaves; n++) {
    const def = content.waves.find((w) => w.wave === n);
    if (!def) continue;
    let totalHp = 0;
    let totalWallet = 0;
    let enemyCount = 0;
    let toughestHp = 0;
    for (const g of def.groups) {
      const hp = enemyHpAt(content, g.enemy, n, diff);
      const e = content.enemies[g.enemy];
      const d = content.constants.difficulty[diff];
      const wallet = e && d ? fmul(fmul(e.baseWallet, fpow(content.constants.walletIndex, n - 1)), d.walletMul) : 0;
      totalHp += hp * g.count;
      totalWallet += wallet * g.count;
      enemyCount += g.count;
      if (hp > toughestHp) toughestHp = hp;
    }

    // 上界：cap 座「本波 DPS 最高的单塔（含满级科技）」
    let bestUnit: UnitDef | null = null;
    let bestDps = 0;
    for (const u of allUnits) {
      if (u.attack <= 0) continue;
      const d = unitDpsVsWave(content, u, n, tech);
      if (d > bestDps) {
        bestDps = d;
        bestUnit = u;
      }
    }

    const durationSec = waveDuration(content, n);
    const requiredDps = truncDiv(totalHp, durationSec);
    const maxDps = bestDps * cap;
    const ttk = bestDps > 0 ? truncDiv(toughestHp, bestDps) : 0;

    rows.push({
      wave: n,
      enemyCount,
      totalHp,
      totalWallet,
      durationSec,
      requiredDps,
      maxDps,
      bestUnit: bestUnit ? bestUnit.id : '—',
      requiredOverMax: maxDps > 0 ? truncDiv(requiredDps * FIXED_SCALE, maxDps) : Number.MAX_SAFE_INTEGER,
      ttkSec: ttk,
      toughestHp,
    });
    sumHp += totalHp;
    sumWallet += totalWallet;
    if (firstImpossible === null && maxDps > 0 && requiredDps > maxDps) firstImpossible = n;
  }

  const totalDamageUpperBound = rows.reduce((acc, r) => acc + r.maxDps * r.durationSec, 0);
  const worst = rows.reduce(
    (acc, r) => (r.requiredOverMax > acc.requiredOverMax ? r : acc),
    rows[0] as WaveFeasibility,
  );

  const verdict =
    firstImpossible === null
      ? `✅ 每一波的「需求 DPS」都低于「${cap} 座${techMode === 'max' ? '满级科技' : '无科技'}最优塔」的上界（最差第 ${worst.wave} 波 ${(worst.requiredOverMax / 1000).toFixed(2)}×）—— 数据层不存在硬性不可通关波次。`
      : `★ 从第 ${firstImpossible} 波起，「需求 DPS」超过「${cap} 座${techMode === 'max' ? '满级科技' : '无科技'}最优塔」的上界（最差第 ${worst.wave} 波 ${(worst.requiredOverMax / 1000).toFixed(2)}×）` +
        ` —— 与 AI 强弱无关，任何阵容都清不掉。全程可击伤总量上界 ${(totalDamageUpperBound / FIXED_SCALE).toFixed(0)} vs 敌人总血量 ${(sumHp / FIXED_SCALE).toFixed(0)}。`;

  return {
    difficultyId: diff,
    populationCap: cap,
    techMode,
    tech: { attackMul: tech.attackMul, attackSpeedMul: tech.attackSpeedMul, rangeMul: tech.rangeMul },
    rows,
    hasImpossibleWave: firstImpossible !== null,
    firstImpossibleWave: firstImpossible,
    sumHp,
    sumWallet,
    totalDamageUpperBound,
    solvable: firstImpossible === null,
    verdict,
  };
}

/** 该波「需求 DPS / 上界」的文本。 */
export function ratioText(permille: number): string {
  return `${(permille / 1000).toFixed(2)}×`;
}
