/**
 * 尾部占比实测 + 备选经济模型评估（策划案 §5.3.1 / §5.4）
 *
 * ⚠️ **本模块只做测量与评估，不改任何数据。** 策划案 §5.3.1 把「第 26–30 波占累计钱包
 * 70.9%」登记为**模型层**问题（单指数 `G(n)=Q(n)·W(n)` 在 30 波下的固有形状），
 * 并把备选模型的实现列为「M2 评估，本轮不实现」。这里给出可执行的数字。
 *
 * 全程整数/定点运算，不使用浮点。
 */
import { FIXED_SCALE, fmul, fpow, mulDiv, truncDiv, type Fixed } from '../sim/fixed';
import type { DifficultyId, SimContent } from '../sim/content';

export interface WaveWalletRow {
  wave: number;
  /** 本波敌人数量（纯计数） */
  count: number;
  /** 本波总钱包（定点） */
  wallet: Fixed;
  /** 累计到本波（定点） */
  cumulative: Fixed;
  /** 占总量的千分比 */
  share: number;
  /** 本波单体平均钱包（定点） */
  avgPerEnemy: Fixed;
}

export interface TailAnalysis {
  fromWave: number;
  toWave: number;
  totalWallet: Fixed;
  tailWallet: Fixed;
  /** 尾部占比（千分比） */
  tailShare: number;
  rows: WaveWalletRow[];
  totalEnemies: number;
}

/** 某一波的理论总钱包（与模拟层同公式：Σ 数量 × 该敌 baseWallet × walletIndex^(n-1)）。 */
export function waveWalletTheory(content: SimContent, wave: number): { count: number; wallet: Fixed } {
  const def = content.waves.find((w) => w.wave === wave);
  if (!def) return { count: 0, wallet: 0 };
  const r = content.constants.walletIndex;
  const growth = fpow(r, wave - 1);
  let count = 0;
  let wallet = 0;
  for (const g of def.groups) {
    const e = content.enemies[g.enemy];
    if (!e) continue;
    count += g.count;
    wallet += g.count * mulDiv(e.baseWallet, growth, FIXED_SCALE);
  }
  return { count, wallet };
}

/**
 * 实测尾部占比：`Σ(wallet[from..to]) / Σ(wallet[1..30])`。
 * 分母与模拟层的 `WaveStats.walletTotal` 同公式，因此可直接与跑批结果对账。
 */
export function analyzeTail(content: SimContent, fromWave = 26, toWave = 30): TailAnalysis {
  const total = content.constants.totalWaves;
  const rows: WaveWalletRow[] = [];
  let cumulative = 0;
  let totalEnemies = 0;
  for (let n = 1; n <= total; n++) {
    const { count, wallet } = waveWalletTheory(content, n);
    cumulative += wallet;
    totalEnemies += count;
    rows.push({
      wave: n,
      count,
      wallet,
      cumulative,
      share: 0,
      avgPerEnemy: count > 0 ? truncDiv(wallet, count) : 0,
    });
  }
  for (const r of rows) r.share = cumulative > 0 ? permilleOf(r.wallet, cumulative) : 0;

  let tailWallet = 0;
  for (const r of rows) if (r.wave >= fromWave && r.wave <= toWave) tailWallet += r.wallet;

  return {
    fromWave,
    toWave,
    totalWallet: cumulative,
    tailWallet,
    tailShare: permilleOf(tailWallet, cumulative),
    rows,
    totalEnemies,
  };
}

function permilleOf(num: number, den: number): number {
  if (den <= 0) return 0;
  return Math.trunc((num * 1000) / den);
}

// ─────────────────────────────────────────────────────────────────────────────
// 备选模型：T(n) = T₁ × g^(n−1)，W(n) = T(n) / Q(n)
// ─────────────────────────────────────────────────────────────────────────────

export interface AltModelSample {
  wave: number;
  count: number;
  /** 每波总收入（定点） */
  total: Fixed;
  /** 反推的单体平均钱包（定点） */
  perEnemy: Fixed;
  /** 对比：现行单指数模型下的单体平均钱包（定点） */
  currentPerEnemy: Fixed;
}

export interface AltModelResult {
  /** 每波总收入的增长率（千分比定点） */
  g: Fixed;
  /** 归一化后的总收入（与现行模型同量级） */
  totalIncome: Fixed;
  tailShare: number;
  /** W(n)=T(n)/Q(n) 的首/末波单体钱包 */
  perEnemyFirst: Fixed;
  perEnemyLast: Fixed;
  /** 单体钱包在 30 波内的总倍数（千分比） */
  growthMultiple: Fixed;
  samples: AltModelSample[];
  /** 同一 g 下每波总收入的增速是否单调（BOSS 波 Q 骤降会让单体钱包跳变） */
  maxPerEnemyJumpRatio: Fixed;
}

/**
 * 在「每波总收入直接控形」的备选模型下求**能满足目标尾部占比的最大**增长率 g。
 *
 * 为什么求最大而不是最小：g 越大成长感越强，所以设计问题是「在尾部 ≤ 目标的前提下，
 * 增长率最多能做到多少」。用**整数网格搜索**（1.40 → 1.00，步长 0.005），不用浮点。
 */
export function solveAltGrowthForTail(content: SimContent, targetTailPermille: number, fromWave = 26, toWave = 30): Fixed {
  const total = content.constants.totalWaves;
  for (let g = 1400; g >= 1000; g -= 5) {
    let all = 0;
    let tail = 0;
    for (let n = 1; n <= total; n++) {
      const t = fpow(g, n - 1);
      all += t;
      if (n >= fromWave && n <= toWave) tail += t;
    }
    if (all > 0 && permilleOf(tail, all) <= targetTailPermille) return g;
  }
  return 1000;
}

/**
 * 评估备选模型：`T(n) = T₁ × g^(n−1)`，`W(n) = T(n) / Q(n)`。
 * `T₁` 取「归一化到现行模型的累计总钱包」，这样两条曲线的**总量可比**，只比形状。
 */
export function evaluateAltModel(content: SimContent, g: Fixed, fromWave = 26, toWave = 30): AltModelResult {
  const total = content.constants.totalWaves;
  const counts: number[] = [];
  let currentTotal = 0;
  const currentPerEnemy: number[] = [];
  for (let n = 1; n <= total; n++) {
    const { count, wallet } = waveWalletTheory(content, n);
    counts.push(count);
    currentTotal += wallet;
    currentPerEnemy.push(count > 0 ? truncDiv(wallet, count) : 0);
  }

  let shapeSum = 0;
  for (let n = 1; n <= total; n++) shapeSum += fpow(g, n - 1);
  const t1 = shapeSum > 0 ? truncDiv(currentTotal, shapeSum) : 0;

  const samples: AltModelSample[] = [];
  let tail = 0;
  let alloc = 0;
  let perEnemyFirst = 0;
  let perEnemyLast = 0;
  let maxJump = 0;
  let prevPerEnemy = 0;
  for (let n = 1; n <= total; n++) {
    const t = t1 * fpow(g, n - 1);
    alloc += t;
    if (n >= fromWave && n <= toWave) tail += t;
    const q = counts[n - 1] as number;
    const per = q > 0 ? truncDiv(t, q) : 0;
    if (n === 1) perEnemyFirst = per;
    if (n === total) perEnemyLast = per;
    if (prevPerEnemy > 0 && per > prevPerEnemy) {
      const jump = truncDiv(per, prevPerEnemy);
      if (jump > maxJump) maxJump = jump;
    }
    prevPerEnemy = per;
    samples.push({ wave: n, count: q, total: t, perEnemy: per, currentPerEnemy: currentPerEnemy[n - 1] as number });
  }

  return {
    g,
    totalIncome: alloc,
    tailShare: permilleOf(tail, alloc),
    perEnemyFirst,
    perEnemyLast,
    growthMultiple: perEnemyFirst > 0 ? truncDiv(perEnemyLast * FIXED_SCALE, perEnemyFirst) : 0,
    samples,
    maxPerEnemyJumpRatio: maxJump,
  };
}

/**
 * §5.4 的两条资金充足性检查：
 * - 第 10 波要能养 6–9 座塔（§5.4）
 * - 第 20 波要能养 10–16 级科技（§5.4）
 *
 * **科技侧只能给解析下界**：sim 里没有科技系统（没有对应 `Command`、科技塔也不解锁面板），
 * 因此「第 20 波 10–16 级科技」这一条**无法在模拟中验证**，只能按 `tech.json` 的真实逐级造价
 * 算「最少要花多少钱」。这一点会写进汇报的「未验证」。
 */
export interface AffordabilityCheck {
  /** 到第 N 波的累计理论钱包（定点，N2 基准：walletMul = 1.0） */
  cumulativeWallet: { wave: number; wallet: Fixed }[];
  /** 按 §5.4 窃金覆盖率 65%–80% 折算的窃金收入区间 */
  stealIncomeRange: { wave: number; low: Fixed; high: Fixed }[];
  /** 达到 L 级科技所需的**最少**金币（跨 8 条线取最便宜的前 L 级） */
  techCostMin: { levels: number; gold: Fixed }[];
  /** 每条科技线满级的总投入（对账 §4.4.1 的表） */
  techLineTotals: { id: string; gold: Fixed }[];
  verdict: string;
}

interface RawTech {
  id: string;
  maxLevel: number;
  costPerLevel: { gold: number; wood: number }[];
}

export function analyzeAffordability(content: SimContent, techs: readonly RawTech[]): AffordabilityCheck {
  const tail = analyzeTail(content);
  const cumulativeWallet = [10, 20, 25, 30].map((wave) => ({
    wave,
    wallet: tail.rows[wave - 1]?.cumulative ?? 0,
  }));
  const stealIncomeRange = cumulativeWallet.map((r) => ({
    wave: r.wave,
    low: mulDiv(r.wallet, 650, 1000),
    high: mulDiv(r.wallet, 800, 1000),
  }));

  const perLevel: number[] = [];
  const techLineTotals: { id: string; gold: Fixed }[] = [];
  for (const t of techs) {
    let total = 0;
    for (const c of t.costPerLevel) {
      perLevel.push(c.gold);
      total += c.gold;
    }
    techLineTotals.push({ id: t.id, gold: total });
  }
  perLevel.sort((a, b) => a - b);
  const techCostMin: { levels: number; gold: Fixed }[] = [];
  for (const levels of [10, 16]) {
    let s = 0;
    for (let i = 0; i < levels && i < perLevel.length; i++) s += perLevel[i] as number;
    techCostMin.push({ levels, gold: s });
  }

  const income20 = cumulativeWallet.find((c) => c.wave === 20)?.wallet ?? 0;
  const cheap10 = techCostMin[0]?.gold ?? 0;
  const verdict =
    income20 > 0
      ? `第 20 波前累计理论钱包 ${fmt(income20)} 金；按 65%–80% 覆盖率折算窃金收入 ${fmt(mulDiv(income20, 650, 1000))}–${fmt(mulDiv(income20, 800, 1000))} 金。` +
        `科技 10 级的下界成本 ${fmt(cheap10)} 金。**注意：这是解析下界，且要与塔的投入抢同一笔钱。**`
      : '无法计算';

  return { cumulativeWallet, stealIncomeRange, techCostMin, techLineTotals, verdict };
}

function fmt(fixed: Fixed): string {
  return (fixed / FIXED_SCALE).toFixed(0);
}

/**
 * 击杀奖励的量级对账（契约 §12.1 的坑，§14.6 已裁决修复）
 *
 * 设计：`击杀奖励 = 当波钱包 × bountyRatio.gold‰`，占收入 15–20%（§4.1.1）。
 * sim：契约 §14.6 之后 `killRewardOf()` 按 `walletMax × killGoldRatio‰` 结算 —— **按波次缩放**。
 *
 * 本函数**镜像 `killRewardOf` 的公式**逐波累加，用来验证修复真的端到端生效
 * （而不是「字段填了但没人读」）。
 */
export interface KillRewardAnalysis {
  totalEnemies: number;
  /** 全 30 波理论钱包 */
  totalWallet: Fixed;
  /** 设计意图：钱包 × 17% */
  intendedKill: Fixed;
  /** sim 实际：逐波按 killGoldRatio 结算 */
  simKill: Fixed;
  /** sim / 设计（千分比） */
  ratio: number;
  /** 第 30 波单只混混的击杀奖励 / 当波钱包（千分比，设计 170） */
  wave30Ratio: number;
  verdict: string;
}

/** 与 `src/sim/world.ts` 的 `killRewardOf()` 同公式：优先 ratio，否则从常量反推。 */
function killRatioOf(e: { killGoldRatio?: Fixed; killGold: Fixed; baseWallet: Fixed }): Fixed {
  if ((e.killGoldRatio ?? 0) > 0) return e.killGoldRatio as Fixed;
  return e.baseWallet > 0 ? mulDiv(e.killGold, FIXED_SCALE, e.baseWallet) : 0;
}

export function analyzeKillReward(content: SimContent, diff: DifficultyId = 'N2'): KillRewardAnalysis {
  const tail = analyzeTail(content);
  const diffMul = content.constants.difficulty[diff]?.walletMul ?? FIXED_SCALE;
  let simKill = 0;
  let totalEnemies = 0;
  for (let n = 1; n <= content.constants.totalWaves; n++) {
    const wave = content.waves.find((w) => w.wave === n);
    if (!wave) continue;
    for (const g of wave.groups) {
      const e = content.enemies[g.enemy];
      if (!e) continue;
      const wallet = fmul(fmul(e.baseWallet, fpow(content.constants.walletIndex, n - 1)), diffMul);
      simKill += g.count * mulDiv(wallet, killRatioOf(e), FIXED_SCALE);
      totalEnemies += g.count;
    }
  }
  const intendedKill = mulDiv(tail.totalWallet, 170, 1000);
  const thug = content.enemies['thug'];
  const wallet30 = thug ? fmul(thug.baseWallet, fpow(content.constants.walletIndex, 29)) : 0;
  const kill30 = thug ? mulDiv(wallet30, killRatioOf(thug), FIXED_SCALE) : 0;
  const wave30Ratio = wallet30 > 0 ? Math.trunc((kill30 * 1000) / wallet30) : 0;

  const ratio = intendedKill > 0 ? Math.trunc((simKill * 1000) / intendedKill) : 0;
  const inRange = ratio >= 950 && ratio <= 1050;
  return {
    totalEnemies,
    totalWallet: tail.totalWallet,
    intendedKill,
    simKill,
    ratio,
    wave30Ratio,
    verdict:
      `设计意图击杀奖励 = ${fmt(intendedKill)} 金（钱包 × 17%）；sim 逐波结算 = ${fmt(simKill)} 金（${totalEnemies} 只）` +
      ` → ${inRange ? '✅ 与设计一致' : '❌ 偏离'}（${(ratio / 10).toFixed(2)}%）。` +
      `第 30 波单只混混：击杀奖励 ${fmt(kill30)} 金 vs 当波钱包 ${fmt(wallet30)} 金 = ${wave30Ratio}‰（设计 170‰）。` +
      `（契约 §14.6 之前实测只有 4,529 金 = 设计的 1.40%，根因是 killGold 是常量、不随波次缩放。）`,
  };
}
