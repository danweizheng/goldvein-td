/**
 * ★ **生存缺口门槛标定**（主策划裁决 1）—— 从**多条策略**的 trace 反推"漏怪起始点"的 DPS 比
 *
 * ## 要回答的问题
 *
 * `gap` 策略上一轮失败在**我自己的生存缺口估计器**：它用解析需求 DPS 当门槛
 * （`totalHp / 波时长`，假设 100% 命中与全程开火），于是第 5 波 `dpsNeed=3.4%`
 * （"看着安全"）而实测漏怪率 75%。
 *
 * **主策划的收紧要求**：不能只从一条策略反推（那条策略的漏怪点自身是它分配方式的产物）。
 * 必须从 **balanced / upgrade-first / noop / gap 四条**分别取「首个漏怪率 > 0 的波」，
 * 算该波的 `当前DPS / 需求DPS`，**报告离散度**：
 *
 * - 四条接近 ⇒ 门槛稳健，直接采用
 * - 离散很大 ⇒ 说明"漏怪"不只由 DPS 决定（还有射程覆盖/摆位/护甲），
 *   那时门槛要写成**两个条件**（DPS 比 + 覆盖比），而不是硬取一个平均数
 *
 * 用法：`pnpm exec tsx src/balance/survival-threshold.ts [--difficulty N2] [--seeds 3]`
 */
import { loadRealContent } from './data-adapter';
import type { DifficultyId, SimContent } from '../sim/content';
import { createWorldWithContent, snapshot } from '../sim/world';
import { drainEvents, step } from '../sim/tick';
import { createStrategy } from './strategies/index';
import { effectiveDps } from './strategies/value';
import { analyzeTtk } from './ttk-analysis';
import { FIXED_SCALE, truncDiv, type Fixed } from '../sim/fixed';
import type { StrategyId } from './strategies/types';
import type { Command } from '../sim/commands';

interface WaveProbe {
  wave: number;
  /** 该波**开始时**的阵容有效 DPS（定点） */
  dps: Fixed;
  /** 该波的需求 DPS（定点，来自 ttk-analysis） */
  requiredDps: Fixed;
  /** dps / requiredDps（千分比，无量纲） */
  ratio: number;
  /** 该波结束时的漏怪数 */
  leaks: number;
  /** 该波结束时的窃金覆盖率（千分比） */
  coverage: number;
}

interface RunProbe {
  strategyId: string;
  seed: number;
  waves: WaveProbe[];
  /** 首个「漏怪 > 0」的波；没有则 null */
  firstLeak: WaveProbe | null;
  waveReached: number;
  status: string;
}

function probeRun(
  content: SimContent,
  difficultyId: DifficultyId,
  strategyId: StrategyId,
  seed: number,
  economyPolicy: 'build-first' | 'upgrade-first',
): RunProbe {
  const w = createWorldWithContent({ seed, difficultyId, relics: {}, techArchive: {} }, content);
  const strategy = createStrategy(strategyId, { economyPolicy });
  const ttk = analyzeTtk(content, difficultyId, undefined, 'max');
  const waves: WaveProbe[] = [];
  let curWave = w.wave;
  let dpsAtWaveStart = 0;
  let pending: { leaks: number; coverage: number } | null = null;
  let lastDecide = -15;

  const measureDps = (): Fixed => {
    let sum = 0;
    for (const t of w.towers) sum += effectiveDps(content, difficultyId, t.def, t.attack, snapshot(w));
    return sum;
  };

  for (let tick = 0; tick < 240_000 && w.status === 'running'; tick++) {
    let cmds: readonly Command[] = [];
    if (tick - lastDecide >= 15) {
      lastDecide = tick;
      cmds = strategy.decide({ snap: snapshot(w), content, difficultyId });
    }
    step(w, cmds);
    const evs = drainEvents(w);
    // 波切换：先把上一波的结果固化
    if (w.wave !== curWave) {
      const prev = pending ?? { leaks: 0, coverage: 0 };
      const req = ttk.rows[curWave - 1]?.requiredDps ?? 0;
      waves.push({
        wave: curWave,
        dps: dpsAtWaveStart,
        requiredDps: req,
        ratio: req > 0 ? truncDiv(dpsAtWaveStart * FIXED_SCALE, req) : 0,
        leaks: prev.leaks,
        coverage: prev.coverage,
      });
      curWave = w.wave;
      dpsAtWaveStart = measureDps();
      pending = { leaks: 0, coverage: 0 };
    }
    for (const ev of evs) {
      if (ev.type === 'waveEnd') {
        const req = ttk.rows[curWave - 1]?.requiredDps ?? 0;
        waves.push({
          wave: curWave,
          dps: dpsAtWaveStart,
          requiredDps: req,
          ratio: req > 0 ? truncDiv(dpsAtWaveStart * FIXED_SCALE, req) : 0,
          leaks: ev.stats.leaks,
          coverage: ev.stats.stealCoverage,
        });
        pending = null;
      } else if (ev.type === 'leak') {
        if (pending) pending.leaks++;
      }
    }
  }
  // 收尾：未记录的当前波
  if (pending !== null) {
    const req = ttk.rows[curWave - 1]?.requiredDps ?? 0;
    waves.push({
      wave: curWave,
      dps: dpsAtWaveStart,
      requiredDps: req,
      ratio: req > 0 ? truncDiv(dpsAtWaveStart * FIXED_SCALE, req) : 0,
      leaks: pending.leaks,
      coverage: pending.coverage,
    });
  } else if (waves.length === 0 || (waves[waves.length - 1] as WaveProbe).wave !== curWave) {
    // 最后一次 waveEnd 已记录；无需再补
  }

  const firstLeak = waves.find((x) => x.leaks > 0) ?? null;
  return { strategyId, seed, waves, firstLeak, waveReached: w.wave, status: w.status };
}

function main(): void {
  const argv = process.argv.slice(2);
  let diff: DifficultyId = 'N2';
  let seedCount = 3;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--difficulty') diff = (argv[i + 1] ?? 'N2') as DifficultyId;
    if (argv[i] === '--seeds') seedCount = Math.max(1, Number.parseInt(argv[i + 1] ?? '3', 10) || 3);
  }
  const content = loadRealContent();
  const seeds = [20261013, 20268932, 20276851].slice(0, seedCount);

  const cases: readonly [StrategyId, 'build-first' | 'upgrade-first'][] = [
    ['balanced', 'build-first'],
    ['balanced', 'upgrade-first'],
    ['noop', 'build-first'],
    ['gap', 'build-first'],
  ];

  console.log(`★生存缺口门槛标定 ｜ 难度 ${diff} ｜ 每策略 ${seedCount} 个种子`);
  console.log('（比值 = 该波开始时的阵容有效 DPS / 该波解析需求 DPS；取「首个漏怪 > 0 的波」）\n');
  console.log(
    ['策略', '经济倾向', '种子', '首个漏怪波', '该波DPS', '该波需求', '比值', '该波覆盖', '到第几波']
      .map((h, i) => (i < 2 ? h.padEnd(14) : h.padStart(11)))
      .join(' '),
  );

  const ratios: number[] = [];
  const byStrategy = new Map<string, number[]>();
  for (const [sid, policy] of cases) {
    for (const seed of seeds) {
      const p = probeRun(content, diff, sid, seed, policy);
      const label = sid === 'balanced' && policy === 'upgrade-first' ? 'upgrade-first' : sid;
      if (!p.firstLeak) {
        console.log(
          [label.padEnd(14), policy.padEnd(14), String(seed).padStart(11), '无漏怪'.padStart(11), ''.padStart(11), ''.padStart(11), ''.padStart(11), ''.padStart(11), String(p.waveReached).padStart(11)].join(' '),
        );
        continue;
      }
      const f = p.firstLeak;
      ratios.push(f.ratio);
      const arr = byStrategy.get(label) ?? [];
      arr.push(f.ratio);
      byStrategy.set(label, arr);
      console.log(
        [
          label.padEnd(14),
          policy.padEnd(14),
          String(seed).padStart(11),
          String(f.wave).padStart(11),
          (f.dps / 1000).toFixed(0).padStart(11),
          (f.requiredDps / 1000).toFixed(0).padStart(11),
          `${(f.ratio / 10).toFixed(1)}%`.padStart(11),
          `${(f.coverage / 10).toFixed(1)}%`.padStart(11),
          String(p.waveReached).padStart(11),
        ].join(' '),
      );
    }
  }

  console.log('\n【按策略汇总】首个漏怪波的 DPS 比');
  for (const [label, arr] of byStrategy) {
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    console.log(`  ${label.padEnd(16)} 比值 ${arr.map((r) => `${(r / 10).toFixed(1)}%`).join(', ')} ｜ 极差 ${((max - min) / 10).toFixed(1)}pt`);
  }
  const min = Math.min(...ratios);
  const max = Math.max(...ratios);
  console.log(
    `\n全样本：n=${ratios.length} ｜ 最小 ${(min / 10).toFixed(1)}% ｜ 最大 ${(max / 10).toFixed(1)}% ｜ **极差 ${((max - min) / 10).toFixed(1)}pt**`,
  );
  console.log(
    ((max - min) / 10 <= 15
      ? '⇒ 离散**小**（≤15pt）：门槛稳健，可取「最保守值 = 最大比值」作为触发线 —— 即"比值低于它就要预期漏怪"。'
      : '⇒ 离散**大**（>15pt）：**单条件不够**，需要"DPS 比 + 覆盖比"双条件（见主策划裁决 1）。'),
  );
  console.log(`⇒ 本次标定取值（保守 = 最大比值）：**${(max / 10).toFixed(1)}%** = ${max}‰`);
}

main();
