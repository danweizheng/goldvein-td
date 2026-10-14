/**
 * 汇总报告渲染（终端表格 + CSV）与跑批产物（JSON）
 *
 * 报告层可以出现浮点（只用于显示与百分比格式化），**模拟层不允许**（铁律 3）。
 */
import type { AdapterReport } from './data-adapter';
import type { AffordabilityCheck, AltModelResult, KillRewardAnalysis, TailAnalysis } from './tail-model';
import type { TtkAnalysis } from './ttk-analysis';
import type { EconomyBoundAnalysis } from './economy-bound';
import type { ComfortResult, GroupSummary, GateResult, Q1Result, WaveAggregate } from './metrics';
import type { DifficultyId } from '../sim/content';
import type { StrategyId } from './strategies/types';
import type { RunResult } from './run';

/** 一局的精简记录（JSON 产物里保留，便于复核每一局的走向）。 */
export interface RunDetail {
  strategyId: StrategyId;
  difficultyId: DifficultyId;
  seed: number;
  status: string;
  win: boolean;
  waveReached: number;
  minutes: number;
  stolen: number;
  income: number;
  spent: number;
  killGold: number;
  leaked: number;
  spawned: number;
  towersAtWave10: number;
  blockShare: number;
  rejections: number;
  hash: string;
  /**
   * ★ 逐波 DPS（定点）。
   *
   * 唯一来源：`src/balance/measure.ts` 的 `dpsAtWaveEnd`，在唯一时刻（`waveEnd`）读取，
   * 由 `run.ts` 放进 `RunResult.waveDps`。**打进产物是为了让别人不必另写一份** ——
   * 适配层四次事故（漏 tech 表 / 漏 target / `map.json` 未迁 / 按下标取难度）
   * 全部源于"同一事实有两个来源"。任何消费方请用这个字段，不要自己重算。
   */
  waveDps: { wave: number; dps: number; tick: number }[];
}

export function detailOf(r: RunResult): RunDetail {
  return {
    strategyId: r.strategyId,
    difficultyId: r.difficultyId,
    seed: r.seed,
    status: r.status,
    win: r.win,
    waveReached: r.waveReached,
    minutes: Math.round((r.seconds / 60) * 10) / 10,
    stolen: r.stolenTotal,
    income: r.incomeTotal,
    spent: r.spentTotal,
    killGold: r.killGoldTotal,
    leaked: r.leaked,
    spawned: r.spawned,
    towersAtWave10: r.towersAtWave10,
    blockShare: r.stolenTotal > 0 ? Math.trunc((r.blockExtraSteal * 1000) / r.stolenTotal) : 0,
    rejections: r.rejections,
    hash: r.hash,
    waveDps: r.waveDps.map((x) => ({ wave: x.wave, dps: x.dps, tick: x.tick })),
  };
}

export interface BalanceArtifact {
  generatedAt: string;
  command: string;
  contentLabel: string;
  adapter: AdapterReport;
  runs: number;
  seeds: number[];
  summaries: GroupSummary[];
  /** key = `${strategyId}|${difficultyId}` */
  waveAggregates: Record<string, WaveAggregate[]>;
  gates: GateResult[];
  q1: Q1Result[];
  tail: TailAnalysis;
  altModels: AltModelResult[];
  affordability: AffordabilityCheck;
  killReward: KillRewardAnalysis;
  ttk: TtkAnalysis[];
  /** ★ 舒适带（§5.4 塔数指标的替代）套在**最大军队上界**上的读数（仅诊断：这把尺子对舒适带是错的） */
  comfort: ComfortResult[];
  /** ★ 契约 §16.3：舒适带的**正确尺子** —— 经济感知上界 */
  economyComfort: ComfortResult[];
  economyBound: EconomyBoundAnalysis[];
  details: RunDetail[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 终端表格
// ─────────────────────────────────────────────────────────────────────────────

/** 定点 → 金币（1 位小数）。仅显示用。 */
export function gold(fixed: number, digits = 1): string {
  return (fixed / 1000).toFixed(digits);
}

/** 千分比 → `72.5%`。 */
export function pct(permille: number, digits = 1): string {
  return `${(permille / 10).toFixed(digits)}%`;
}

function pad(s: string, width: number, align: 'l' | 'r' = 'l'): string {
  const str = s.length > width ? s.slice(0, width) : s;
  return align === 'l' ? str.padEnd(width) : str.padStart(width);
}

const HEADERS = [
  ['策略', 10],
  ['难度', 5],
  ['局数', 5],
  ['通关率', 9],
  ['均到波', 7],
  ['窃金覆盖', 9],
  ['支出/收入', 10],
  ['漏怪率', 8],
  ['塔@10', 6],
  ['科技级', 6],
  ['科技占比', 9],
  ['均时长', 7],
  ['拒指令', 7],
] as const;

export function renderGroupTable(summaries: readonly GroupSummary[]): string {
  const lines: string[] = [];
  lines.push(HEADERS.map(([h, w]) => pad(h, w, 'r')).join(' '));
  lines.push(HEADERS.map(([, w]) => '-'.repeat(w)).join(' '));
  for (const s of summaries) {
    lines.push(
      [
        pad(s.strategyId, 10),
        pad(s.difficultyId, 5),
        pad(String(s.runs), 5, 'r'),
        pad(`${s.wins}/${s.runs} ${pct(s.winRate, 0)}`, 9, 'r'),
        pad(String(s.avgWaveReached), 7, 'r'),
        pad(pct(s.stealCoverage), 9, 'r'),
        pad(pct(s.spendRatio), 10, 'r'),
        pad(pct(s.leakRate, 2), 8, 'r'),
        pad(s.avgTowersAtWave10.toFixed(1), 6, 'r'),
        pad(s.avgTechResearched.toFixed(1), 6, 'r'),
        pad(pct(s.techSpendShare, 0), 9, 'r'),
        pad(`${s.avgMinutes}min`, 7, 'r'),
        pad(String(s.rejections), 7, 'r'),
      ].join(' '),
    );
  }
  return lines.join('\n');
}

/** 契约 §14.4 的硬门禁：需求 DPS / 可达上界 ≤ 1.0。 */
export function renderSolvability(
  list: readonly TtkAnalysis[],
  comfort: readonly ComfortResult[] = [],
  econComfort: readonly ComfortResult[] = [],
): string {
  const lines: string[] = [];
  lines.push('★ 可通关性门禁（契约 §14.4）：需求DPS(wave) / 可达DPS上界(wave) ≤ 1.0，30 波 × 5 难度');
  lines.push(
    pad('难度', 5) + ' ' + pad('判定', 8) + ' ' + pad('第一个 >1.0 的波', 18, 'r') + ' ' + pad('最差波', 7, 'r') + ' ' + pad('最差比值', 9, 'r') + ' 满级科技乘区',
  );
  for (const a of list) {
    const worst = a.rows.reduce((acc, r) => (r.requiredOverMax > acc.requiredOverMax ? r : acc), a.rows[0] as TtkAnalysis['rows'][number]);
    lines.push(
      pad(a.difficultyId, 5) +
        ' ' +
        pad(a.solvable ? '✅ 通过' : '❌ 不通过', 8) +
        ' ' +
        pad(a.firstImpossibleWave === null ? '—' : String(a.firstImpossibleWave), 18, 'r') +
        ' ' +
        pad(String(worst.wave), 7, 'r') +
        ' ' +
        pad(`${(worst.requiredOverMax / 1000).toFixed(2)}×`, 9, 'r') +
        ` 攻击 ×${(a.tech.attackMul / 1000).toFixed(2)} / 攻速 ×${(a.tech.attackSpeedMul / 1000).toFixed(2)}`,
    );
  }
  if (comfort.length > 0) {
    lines.push('');
    lines.push('★ 舒适带（§5.4 塔数指标的替代，目标 [0.20, 0.60]）—— 两把尺子并列，**不得混用**（契约 §16.3）');
    lines.push('  【尺子 A：最大军队上界】仅诊断用 —— 拿"无限资源"的上界量"第 10 波该有多少压力"必然永远"太轻松"');
    lines.push('  ' + pad('难度', 5) + ' ' + pad('波', 4, 'r') + ' ' + pad('需求/上界', 10, 'r') + ' ' + pad('判定', 10) + ' 偏离');
    for (const c of comfort) {
      lines.push(
        '  ' +
          pad(c.difficultyId, 5) +
          ' ' +
          pad(String(c.wave), 4, 'r') +
          ' ' +
          pad(c.ratio === null ? '—' : `${(c.ratio / 1000).toFixed(2)}×`, 10, 'r') +
          ' ' +
          pad(c.verdict, 10) +
          (c.deviation ? ` ${(c.deviation / 1000).toFixed(2)}×` : ''),
      );
    }
    if (econComfort.length > 0) {
      lines.push('');
      lines.push('  【尺子 B：★ 经济感知上界】舒适带的**正确尺子** —— 用"到该波的累计到手收入"能买到的最强阵容');
      lines.push('  ' + pad('难度', 5) + ' ' + pad('波', 4, 'r') + ' ' + pad('需求/上界', 10, 'r') + ' ' + pad('判定', 10) + ' 偏离');
      for (const c of econComfort) {
        lines.push(
          '  ' +
            pad(c.difficultyId, 5) +
            ' ' +
            pad(String(c.wave), 4, 'r') +
            ' ' +
            pad(c.ratio === null ? '—' : `${(c.ratio / 1000).toFixed(2)}×`, 10, 'r') +
            ' ' +
            pad(c.verdict, 10) +
            (c.deviation ? ` ${(c.deviation / 1000).toFixed(2)}×` : ''),
        );
      }
      lines.push('  口径：预算 = 起始金币 + 累计钱包×725‰ + 击杀奖励(17%) + 波次奖励；科技乘区取满级；');
      lines.push('        已知宽松处：预算全部变成 DPS、忽略建造节奏、不扣科技支出（→ 判定偏"太轻松"，方向保守）。');
    }
  }
  return lines.join('\n');
}

export function renderGates(gates: readonly GateResult[]): string {
  const lines: string[] = [];
  lines.push('门禁（策划案 §10.2「验收门槛（自动判定）」）');
  lines.push(pad('策略', 10) + ' ' + pad('难度', 5) + ' ' + pad('目标区间', 14, 'r') + ' ' + pad('实测', 9, 'r') + ' ' + pad('判定', 12) + ' 说明');
  for (const g of gates) {
    const range = `${pct(g.gate.min, 0)}–${pct(g.gate.max, 0)}`;
    const actual = g.actual === null ? '—' : pct(g.actual, 0);
    const verdict =
      g.verdict === 'pass'
        ? '✅ 达标'
        : g.verdict === 'missing'
          ? '⚠️ 未跑'
          : `❌ ${g.verdict === 'fail-high' ? '偏高' : '偏低'} ${(Math.abs(g.deviation) / 10).toFixed(0)}pt`;
    lines.push(
      pad(g.gate.strategyId, 10) +
        ' ' +
        pad(g.gate.difficultyId, 5) +
        ' ' +
        pad(range, 14, 'r') +
        ' ' +
        pad(actual, 9, 'r') +
        ' ' +
        pad(verdict, 12) +
        ' ' +
        g.gate.note,
    );
  }
  return lines.join('\n');
}

export function renderQ1(results: readonly Q1Result[]): string {
  const lines: string[] = [];
  lines.push('Q1：军训系存在性（目标 blockExtraSteal / stolenTotal ≥ 25%，且 balanced 与 noblock 通关波次差 ≥ 2）');
  lines.push(
    pad('难度', 5) +
      ' ' +
      pad('balanced 通关率', 16, 'r') +
      ' ' +
      pad('noblock 通关率', 15, 'r') +
      ' ' +
      pad('均波差', 7, 'r') +
      ' ' +
      pad('卡位占比', 9, 'r') +
      ' 判定',
  );
  for (const q of results) {
    lines.push(
      pad(q.difficultyId, 5) +
        ' ' +
        pad(q.balanced ? pct(q.balanced.winRate, 0) : '—', 16, 'r') +
        ' ' +
        pad(q.noblock ? pct(q.noblock.winRate, 0) : '—', 15, 'r') +
        ' ' +
        pad(String(q.waveGap), 7, 'r') +
        ' ' +
        pad(pct(q.blockShare), 9, 'r') +
        ' ' +
        q.verdict,
    );
  }
  return lines.join('\n');
}

export function renderTail(tail: TailAnalysis, alt: readonly AltModelResult[]): string {
  const lines: string[] = [];
  lines.push(`尾部占比（第 ${tail.fromWave}–${tail.toWave} 波 / 第 1–30 波，累计理论钱包）`);
  lines.push(
    `  总钱包 ${gold(tail.totalWallet, 0)} 金 ｜ 尾部 ${gold(tail.tailWallet, 0)} 金 ｜ **实测尾部占比 ${pct(tail.tailShare)}**（策划案 §5.4 目标 ≤ 50%，§5.2 记录 70.9%）`,
  );
  lines.push('  逐波累计（每 5 波取一点 + 尾部逐波）：');
  lines.push(
    '  ' + pad('波', 4, 'r') + ' ' + pad('敌数', 6, 'r') + ' ' + pad('本波钱包', 12, 'r') + ' ' + pad('累计', 14, 'r') + ' ' + pad('累计占比', 9, 'r') + ' ' + pad('单体钱包', 12, 'r'),
  );
  for (const r of tail.rows) {
    const show = r.wave <= 10 || r.wave % 5 === 0 || r.wave >= 26;
    if (!show) continue;
    lines.push(
      '  ' +
        pad(String(r.wave), 4, 'r') +
        ' ' +
        pad(String(r.count), 6, 'r') +
        ' ' +
        pad(gold(r.wallet, 0), 12, 'r') +
        ' ' +
        pad(gold(r.cumulative, 0), 14, 'r') +
        ' ' +
        pad(pct(Math.trunc((r.cumulative * 1000) / (tail.totalWallet || 1)), 0), 9, 'r') +
        ' ' +
        pad(gold(r.avgPerEnemy, 1), 12, 'r'),
    );
  }
  for (const a of alt) {
    lines.push('');
    lines.push(
      `  备选模型 T(n)=T₁×g^(n−1)、W(n)=T(n)/Q(n)：g = ${(a.g / 1000).toFixed(3)} → 尾部占比 ${pct(a.tailShare)}；` +
        `单体钱包 ${gold(a.perEnemyFirst, 1)} → ${gold(a.perEnemyLast, 1)} 金（×${(a.growthMultiple / 1000).toFixed(1)}）；` +
        `T(n) 已归一化到现行累计总量 ${gold(a.totalIncome, 0)} 金`,
    );
  }
  return lines.join('\n');
}

export function renderAffordability(a: AffordabilityCheck): string {
  const lines: string[] = [];
  lines.push('§5.4 资金充足性（解析对账，N2 基准 walletMul=1.0）');
  for (const c of a.cumulativeWallet) {
    const r = a.stealIncomeRange.find((x) => x.wave === c.wave);
    lines.push(
      `  第 ${pad(String(c.wave), 2, 'r')} 波：累计理论钱包 ${pad(gold(c.wallet, 0), 9, 'r')} 金` +
        (r ? ` ｜ 窃金收入(65–80%) ${pad(gold(r.low, 0), 8, 'r')}–${pad(gold(r.high, 0), 8, 'r')} 金` : ''),
    );
  }
  lines.push(
    '  科技下界成本：' + a.techCostMin.map((t) => `${t.levels} 级 ≥ ${gold(t.gold, 0)} 金`).join(' ｜ ') + '（跨 8 线取最便宜的前 N 级）',
  );
  lines.push(`  ${a.verdict}`);
  return lines.join('\n');
}

export function renderAdapter(rep: AdapterReport): string {
  const lines: string[] = [];
  lines.push(`适配层：${rep.label}`);
  lines.push(`  单位 ${rep.unitCount} ｜ 敌人 ${rep.enemyCount} ｜ 波次 ${rep.waveCount} ｜ 科技 ${rep.techCount} ｜ 缺口记录 ${rep.warnings.length} 条`);
  for (const w of rep.warnings) lines.push(`  • [${w.code}] ${w.detail}`);
  return lines.join('\n');
}

/** 击杀奖励量级对账（契约 §12.1 的坑换形式复发）。 */
export function renderKillReward(k: KillRewardAnalysis): string {
  return [
    '击杀奖励量级（§4.1.1 要求占总收入 15–20%）',
    `  全 30 波敌人 ${k.totalEnemies} 只 ｜ 理论钱包 ${gold(k.totalWallet, 0)} 金`,
    `  设计意图 ${gold(k.intendedKill, 0)} 金 vs sim 实际 ${gold(k.simKill, 0)} 金 → ${(k.ratio / 1000).toFixed(2)}%`,
    `  ${k.verdict}`,
  ].join('\n');
}

/** DPS 可行性（与 AI 无关的硬边界）。 */
export function renderTtk(list: readonly TtkAnalysis[]): string {
  const lines: string[] = [];
  lines.push('DPS 可行性：需求 DPS vs「人口上限座本波最优塔」的 DPS 上界（> 1.00× 即数学上清不掉）');
  for (const a of list) {
    lines.push('');
    lines.push(`── ${a.difficultyId}（人口上限 ${a.populationCap}）${a.verdict}`);
    lines.push(
      '  ' +
        pad('波', 3, 'r') +
        ' ' +
        pad('敌数', 5, 'r') +
        ' ' +
        pad('总血量', 12, 'r') +
        ' ' +
        pad('时长s', 6, 'r') +
        ' ' +
        pad('需求DPS', 10, 'r') +
        ' ' +
        pad('上界DPS', 10, 'r') +
        ' ' +
        pad('需求/上界', 9, 'r') +
        ' ' +
        pad('最优塔', 14) +
        ' ' +
        pad('单体TTK', 8, 'r'),
    );
    for (const r of a.rows) {
      if (!(r.wave <= 5 || r.wave % 5 === 0 || r.requiredOverMax > 1000)) continue;
      lines.push(
        '  ' +
          pad(String(r.wave), 3, 'r') +
          ' ' +
          pad(String(r.enemyCount), 5, 'r') +
          ' ' +
          pad(gold(r.totalHp, 0), 12, 'r') +
          ' ' +
          pad(String(r.durationSec), 6, 'r') +
          ' ' +
          pad(gold(r.requiredDps, 0), 10, 'r') +
          ' ' +
          pad(gold(r.maxDps, 0), 10, 'r') +
          ' ' +
          pad(`${(r.requiredOverMax / 1000).toFixed(2)}×`, 9, 'r') +
          ' ' +
          pad(r.bestUnit, 14) +
          ' ' +
          pad(`${(r.ttkSec / 1000).toFixed(1)}s`, 8, 'r'),
      );
    }
  }
  return lines.join('\n');
}

export function renderFullReport(a: BalanceArtifact): string {
  return [
    '════════════════ 《窃金者 TD》headless 平衡报告 ════════════════════',
    `生成时间 ${a.generatedAt} ｜ 命令 \`${a.command}\` ｜ 每格 ${a.runs} 局 ｜ 种子 ${a.seeds.join(',')}`,
    '',
    renderAdapter(a.adapter),
    '',
    '── 策略 × 难度 汇总 ─────────────────────────────────────────────',
    renderGroupTable(a.summaries),
    '',
    renderGates(a.gates),
    '',
    renderQ1(a.q1),
    '',
    renderTail(a.tail, a.altModels),
    '',
    renderSolvability(a.ttk, a.comfort, a.economyComfort),
    '',
    renderKillReward(a.killReward),
    '',
    renderTtk(a.ttk),
    '',
    renderAffordability(a.affordability),
    '',
    '说明：',
    '  · 卡位占比 = blockExtraSteal / stolenTotal，**只是诊断指标**（契约 §14.8）。sim 已改成',
    '    「增量」口径（= 该笔窃取 × slowWhileBlocked），但那是**推导式归因**而非真反事实，',
    '    并且会**低估**铁闸守卫（锁链拉回的停留时间没被计入）。Q1 的判据是 balanced vs noblock',
    '    的**通关波次差**（跑两个世界做差值），不是这个比值。',
    '  · 「支出/收入」用累计 w.spentTotal / 累计 w.earnedTotal 计算。按 WaveStats 逐波加总会系统性偏低：',
    '    备战期的建造发生在 waveEnd 之后、下次 startWave 之前，会被 startWave 清零。',
    '  · 科技已实现（契约 §14.2），支出因此有了第二条消耗口；但科技树总额（313,200 金）相对远期',
    '    收入（约 194 万）偏小 → 科技占比达不到 §14.12 的 35% 目标（§14.12 已预判要 ×1.8）。',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────────────────────

export const CSV_HEADER = [
  'strategy',
  'difficulty',
  'runs',
  'wins',
  'losses',
  'timeouts',
  'win_rate_permille',
  'avg_wave_reached',
  'avg_seconds',
  'avg_minutes',
  'steal_coverage_permille',
  'spend_ratio_permille',
  'leak_rate_permille',
  'block_share_permille',
  'avg_stolen_gold',
  'avg_income_gold',
  'avg_spent_gold',
  'avg_kill_gold',
  'avg_wave_reward_gold',
  'avg_salary_gold',
  'avg_towers_wave10',
  'avg_towers_wave20',
  'avg_tower_count',
  'avg_tech_researched',
  'tech_levels_wave20',
  'tech_spend_share_permille',
  'avg_tech_spent_gold',
  'rejections',
  'waves_reached',
] as const;

export function toCsv(summaries: readonly GroupSummary[]): string {
  const rows: string[] = [CSV_HEADER.join(',')];
  for (const s of summaries) {
    rows.push(
      [
        s.strategyId,
        s.difficultyId,
        s.runs,
        s.wins,
        s.losses,
        s.timeouts,
        s.winRate,
        s.avgWaveReached,
        s.avgSeconds,
        s.avgMinutes,
        s.stealCoverage,
        s.spendRatio,
        s.leakRate,
        s.blockShare,
        gold(s.avgStolen, 1),
        gold(s.avgIncome, 1),
        gold(s.avgSpent, 1),
        gold(s.avgKillGold, 1),
        gold(s.avgWaveReward, 1),
        gold(s.avgSalary, 1),
        s.avgTowersAtWave10.toFixed(2),
        s.avgTowersAtWave20.toFixed(2),
        s.avgTowerCount.toFixed(2),
        s.avgTechResearched.toFixed(2),
        s.avgTechLevelsAtWave20.toFixed(2),
        s.techSpendShare,
        gold(s.avgTechSpent, 1),
        s.rejections,
        `"${s.wavesReached.join(' ')}"`,
      ].join(','),
    );
  }
  return rows.join('\n');
}

export const WAVE_CSV_HEADER = [
  'strategy',
  'difficulty',
  'wave',
  'runs',
  'gold_earned',
  'gold_spent',
  'stolen_total',
  'wallet_total',
  'steal_coverage_permille',
  'block_extra_steal',
  'leaks',
  'tower_count',
  'tech_levels',
] as const;

export function toWaveCsv(aggregates: Record<string, WaveAggregate[]>): string {
  const rows: string[] = [WAVE_CSV_HEADER.join(',')];
  for (const key of Object.keys(aggregates).sort()) {
    const [strategy, difficulty] = key.split('|');
    for (const w of aggregates[key] as WaveAggregate[]) {
      rows.push(
        [
          strategy,
          difficulty,
          w.wave,
          w.runs,
          gold(w.goldEarned, 1),
          gold(w.goldSpent, 1),
          gold(w.stolenTotal, 1),
          gold(w.walletTotal, 1),
          w.stealCoverage,
          gold(w.blockExtraSteal, 1),
          w.leaks,
          w.towerCount,
          w.techLevels,
        ].join(','),
      );
    }
  }
  return rows.join('\n');
}
