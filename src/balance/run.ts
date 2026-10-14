/**
 * headless 单局跑批（策划案 §10.2 的地基）
 *
 * 一局 = `createWorldWithContent(cfg, realContent)` + 循环 `step(w, cmds)`，
 * `cmds` 由策略 AI 通过 `decide()` 产出（契约 §5 的 `Command`）。
 *
 * ## 确定性
 *
 * 唯一随机源是 `RunConfig.seed`（mulberry32）。同一个 (seed, 难度, 策略) 一定得到
 * 完全相同的 `RunResult`，因此报告可复现、可回归（见 tests/sim/determinism.spec.ts）。
 *
 * ## 决策节拍
 *
 * 每 `DECIDE_INTERVAL`（默认 15 tick = 0.25s）问一次 AI。真实玩家不可能 60Hz 操作，
 * 这个节拍也顺手把 AI 的 CPU 开销压到可忽略。
 */
import { createWorldWithContent, hashWorld, snapshot } from '../sim/world';
import { drainEvents, step } from '../sim/tick';
import { dpsAtWaveEnd } from './measure';
import type { AttackType } from '../sim/content';
import type { Command } from '../sim/commands';
import type { DifficultyId, SimContent } from '../sim/content';
import type { WaveStats } from '../sim/events';
import type { WorldStatus } from '../sim/types';
import { createStrategy } from './strategies/index';
import type { StrategyId } from './strategies/types';

export const DECIDE_INTERVAL = 15;

export interface RunOptions {
  content: SimContent;
  difficultyId: DifficultyId;
  strategyId: StrategyId;
  seed: number;
  /** 安全上限（tick）。默认 240,000 tick = 66 分钟游戏时间。 */
  maxTicks?: number;
  /** 摆位风格（契约 §16 的★停顿点扫描用）：`uniform` 摊开 / `clustered` 堆在停顿点 */
  placement?: 'uniform' | 'clustered';
  /** 经济倾向（主策划裁决 2 的 A 维度）：`build-first` 铺新塔 / `upgrade-first` 先升级窃金塔 */
  economyPolicy?: 'build-first' | 'upgrade-first';
  /** gap 策略的 aging 上限（漏怪持续时经济最多被饿死几波）—— 主策划裁决 2 */
  agingMax?: number;
  /** 只允许这些输出塔系（护甲克制对照实验用；窃金塔不受限） */
  allowedAttackTypes?: readonly AttackType[];
  /**
   * 拿到策略实例的回调（用于审计：`gap` 策略的 `trace()` 暴露每波的两个缺口与决策）。
   * 策略**有状态**，回调里拿到的引用在跑完后仍可读它的 trace。
   */
  onStrategyReady?: (s: unknown) => void;
}

export interface WaveDps {
  /** 波号 */
  wave: number;
  /** 该波结束时刻的阵容有效 DPS（定点，唯一具名读数 `dpsAtWaveEnd`） */
  dps: number;
  /** 该波结束的 tick */
  tick: number;
}

export interface WaveRecord extends WaveStats {
  /** 本波结束时的 tick */
  tick: number;
  /** 本波结束时剩余生命 */
  lives: number;
  /** 本波结束时金币（定点） */
  gold: number;
  /** 本波结束时已研究的科技总级数（§5.4：第 20 波要 10–16 级） */
  techLevels: number;
}

export type RunStatus = WorldStatus | 'timeout';

export interface RunResult {
  strategyId: StrategyId;
  difficultyId: DifficultyId;
  seed: number;
  status: RunStatus;
  win: boolean;
  /** 通关/失败时所在的波次 */
  waveReached: number;
  /** 实际推进的 tick（= 游戏时间 × 60） */
  ticks: number;
  /** 游戏时间（秒，向下取整） */
  seconds: number;
  waves: WaveRecord[];
  /** 第 10 波结束时的塔数（§5.4 要求 6–9） */
  towersAtWave10: number;
  /** 第 20 波结束时的塔数 */
  towersAtWave20: number;
  /** 第 20 波结束时已研究的科技总级数（§5.4 要求 10–16） */
  techLevelsAtWave20: number;
  /** 累计科技支出（定点，契约 §14.12：科技应占支出 35%） */
  techSpentGold: number;
  /** 累计科技支出木材（定点） */
  techSpentWood: number;
  /** 已研究的科技总级数 */
  techResearched: number;
  /**
   * ★ 逐攻击类型的塔数（键为 `attackType`）。
   *
   * 扫描「金币陷阱」时要看**弓箭手有几座**（便宜的、看起来有用的、回不了本的），
   * 所以这个计数是一等输出，不是调试信息。
   */
  attackTypeCounts: Record<string, number>;
  /** 窃金塔数量（`def.isSteal`）—— 主策划要求：必须能分辨「塔多」还是「塔强」 */
  thiefCount: number;
  /** 窃金塔平均等级 ×100（整数，300 = 平均 T3） */
  avgThiefTierX100: number;
  /** 窃金塔最高等级 */
  maxThiefTier: number;
  /** 窃金塔的窃金合计（定点） */
  thiefStolenTotal: number;
  /**
   * ★ 逐波 DPS（定点）。
   *
   * 唯一来源：`src/balance/measure.ts` 的 `dpsAtWaveEnd`，在唯一时刻（`waveEnd` 被 drain 的那一刻）读取。
   * 打进产物是为了让"下一个人"不必另写一份 —— 适配层前四次事故（漏 tech 表 / 漏 target /
   * `map.json` 未迁 / 按下标取难度）全部源于**同一事实有两个来源**。
   */
  waveDps: WaveDps[];
  /** 累计窃金（定点） */
  stolenTotal: number;
  /** 累计击杀奖励（定点） */
  killGoldTotal: number;
  /** 累计波次结算奖励（定点，由 content.waves 求和） */
  waveRewardTotal: number;
  /** 累计「领工资」收入（定点，由指令计数 × 单次收益推算） */
  salaryTotal: number;
  /** 累计收入 = 窃金 + 击杀 + 波次奖励 + 领工资 */
  incomeTotal: number;
  /** 累计支出（含备战期） */
  spentTotal: number;
  /** 其中因「敌人处于被阻挡状态」而发生的窃取（定点） */
  blockExtraSteal: number;
  /** 累计窃取总额（用于覆盖率的分母对账） */
  walletTotal: number;
  leaked: number;
  killed: number;
  spawned: number;
  livesLeft: number;
  finalGold: number;
  finalWood: number;
  towerCount: number;
  /** 被拒绝的指令条数与样本（指令通路健康度） */
  rejections: number;
  rejectionSamples: string[];
  /** 发出的指令条数（按类型） */
  commands: Record<string, number>;
  peakAliveEnemies: number;
  peakActiveProjectiles: number;
  /** 终态哈希（复现性证据） */
  hash: string;
  /** 最后一次 waveEnd 的覆盖率（千分比） */
  lastCoverage: number;
}

export function runOne(opts: RunOptions): RunResult {
  const cfg = {
    seed: opts.seed >>> 0,
    difficultyId: opts.difficultyId,
    relics: {} as Readonly<Record<string, number>>,
    techArchive: {} as Readonly<Record<string, number>>,
  };
  const w = createWorldWithContent(cfg, opts.content);
  const strategy = createStrategy(opts.strategyId, { placement: opts.placement, economyPolicy: opts.economyPolicy, agingMax: opts.agingMax, allowedAttackTypes: opts.allowedAttackTypes });
  opts.onStrategyReady?.(strategy);
  const maxTicks = opts.maxTicks ?? 240_000;

  const waves: WaveRecord[] = [];
  const waveDps: WaveDps[] = [];
  let rejections = 0;
  const rejectionSamples: string[] = [];
  const commands: Record<string, number> = {};
  let salaryTotal = 0;
  const salaryPerUse = (opts.content.constants.salaryMultiplier * opts.content.constants.baseIncomePerSec) / 1000;

  let lastCoverage = 0;
  let lastDecide = -DECIDE_INTERVAL; // 让 tick=0 也决策一次（备战期第一件事就是建造）

  while (w.status === 'running' && w.tick < maxTicks) {
    let cmds: readonly Command[] = [];
    if (w.tick - lastDecide >= DECIDE_INTERVAL) {
      lastDecide = w.tick;
      cmds = strategy.decide({ snap: snapshot(w), content: opts.content, difficultyId: opts.difficultyId });
      for (const c of cmds) {
        commands[c.type] = (commands[c.type] ?? 0) + 1;
        if (c.type === 'activateSkill' && c.skillId === 'salary') salaryTotal += salaryPerUse;
      }
    }
    step(w, cmds);

    const events = drainEvents(w);
    for (const ev of events) {
      if (ev.type === 'waveEnd') {
        lastCoverage = ev.stats.stealCoverage;
        // ★ 唯一具名读数（`src/balance/measure.ts`）在**唯一时刻**（waveEnd 被 drain 的那一刻）读取。
        //   把逐波 DPS 打进产物，是为了让"下一个人"不必另写一份 —— 适配层前四次事故
        //   （漏 tech 表 / 漏 target / map 未迁 / 按下标取难度）全部源于**同一事实有两个来源**。
        waveDps.push({ wave: ev.stats.wave, dps: dpsAtWaveEnd(w), tick: w.tick });
        waves.push({ ...ev.stats, tick: w.tick, lives: Math.max(0, w.lives), gold: w.gold, techLevels: w.techResearched });
      } else if (ev.type === 'commandRejected') {
        rejections++;
        if (rejectionSamples.length < 8) rejectionSamples.push(`${ev.reason}`);
      }
    }
  }

  let waveRewardTotal = 0;
  for (const rec of waves) {
    const def = opts.content.waves.find((d) => d.wave === rec.wave);
    if (def) waveRewardTotal += def.rewardGold;
  }

  // —— 窃金塔指标：主策划要求必须能分辨「塔多」还是「塔强」
  //   （他上一条误判的根源就是"假设了塔数与射程，没看实际值"）——
  let thiefCount = 0;
  let tierSum = 0;
  let maxThiefTier = 0;
  let thiefStolenTotal = 0;
  const attackTypeCounts: Record<string, number> = {};
  for (const t of w.towers) {
    attackTypeCounts[t.def.attackType] = (attackTypeCounts[t.def.attackType] ?? 0) + 1;
    if (!t.def.isSteal) continue;
    thiefCount++;
    tierSum += t.tier;
    if (t.tier > maxThiefTier) maxThiefTier = t.tier;
    thiefStolenTotal += t.totalStolen;
  }

  const status: RunStatus = w.status === 'running' ? 'timeout' : w.status;
  const incomeTotal = w.stolenTotal + w.earnedTotal;
  const towersAtWave10 = waves.find((r) => r.wave === 10)?.towerCount ?? 0;
  const towersAtWave20 = waves.find((r) => r.wave === 20)?.towerCount ?? 0;

  // ★ 覆盖率的分母必须与分子**同基**：
  //   `stolenTotal`（分子）含**当前进行中的那一波**，而 `waves[]` 只含已结束的波。
  //   旧实现直接用「Σ已结束波的 walletTotal」当分母 → 分母少一波 → 覆盖率能算出 **104%、151%** 这种不可能值
  //   （实测 noop@N2 1042‰、balanced@N4 1455‰）。这里把进行中的那一波补进分母。
  //
  //   为什么用 `phase === 'combat'` 判断：`startWave` 才重置 waveAcc，而 `waveSystem` 在
  //   emit waveEnd 后立刻把 phase 置为 'prep' —— 所以 **prep 期间 waveAcc 仍属于已记录的那一波**，
  //   那时加进去就会重复计数。
  const inProgressWallet = w.phase === 'combat' ? w.waveAcc.walletTotal : 0;

  return {
    strategyId: opts.strategyId,
    difficultyId: opts.difficultyId,
    seed: cfg.seed,
    status,
    win: status === 'won',
    waveReached: w.wave,
    ticks: w.tick,
    seconds: Math.floor(w.tick / opts.content.constants.tickRate),
    waves,
    towersAtWave10,
    towersAtWave20,
    techLevelsAtWave20: waves.find((r) => r.wave === 20)?.techLevels ?? 0,
    techSpentGold: w.techSpentGold,
    techSpentWood: w.techSpentWood,
    techResearched: w.techResearched,
    attackTypeCounts,
    thiefCount,
    avgThiefTierX100: thiefCount > 0 ? Math.trunc((tierSum * 100) / thiefCount) : 0,
    maxThiefTier,
    thiefStolenTotal,
    waveDps,
    stolenTotal: w.stolenTotal,
    killGoldTotal: w.killGoldTotal,
    waveRewardTotal,
    salaryTotal,
    incomeTotal,
    spentTotal: w.spentTotal,
    blockExtraSteal: accumulatedBlockExtra(waves),
    walletTotal: accumulatedWallet(waves) + inProgressWallet,
    leaked: w.leaked,
    killed: w.killed,
    spawned: w.spawnedTotal,
    livesLeft: Math.max(0, w.lives),
    finalGold: w.gold,
    finalWood: w.wood,
    towerCount: w.towers.length,
    rejections,
    rejectionSamples,
    commands,
    peakAliveEnemies: w.peakAliveEnemies,
    peakActiveProjectiles: w.peakActiveProjectiles,
    hash: hashWorld(w),
    lastCoverage,
  };
}

function accumulatedBlockExtra(waves: readonly WaveRecord[]): number {
  let s = 0;
  for (const r of waves) s += r.blockExtraSteal;
  return s;
}

function accumulatedWallet(waves: readonly WaveRecord[]): number {
  let s = 0;
  for (const r of waves) s += r.walletTotal;
  return s;
}
