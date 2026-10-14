/**
 * `pnpm balance` 入口 —— headless 平衡跑批（策划案 §10.2）
 *
 * ```bash
 * pnpm balance --difficulty N3 --strategy greedy --runs 100 --out report.csv
 * pnpm balance --difficulty all --strategy all --runs 3 --out out/balance.csv --json out/balance.json
 * pnpm balance --tail-only           # 只做尾部占比 / 备选模型分析（不跑批）
 * ```
 *
 * 参数：
 * | 参数 | 说明 |
 * |---|---|
 * | `--difficulty` | `N1..N5` 或 `all`，逗号分隔，默认 `all` |
 * | `--strategy` | `greedy/balanced/optimal/noop/noblock` 或 `all`，默认 `all` |
 * | `--runs` | 每个「策略 × 难度」格跑几局（不同种子），默认 1 |
 * | `--out` | 汇总 CSV 路径（会一并写出 `<out>.waves.csv`） |
 * | `--json` | 完整产物 JSON 路径（`tools/balance-report.ts` 消费它） |
 * | `--seed` | 起始种子，默认 20261013 |
 * | `--max-ticks` | 单局 tick 上限，默认 240000 |
 * | `--tail-only` | 只输出尾部占比与备选模型分析 |
 * | `--quiet` | 不打印终端表格（仍写文件） |
 *
 * ⚠️ 不修改 `package.json`；脚本名 `balance` 已由主策划冻结并指向本文件。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadRealContentWithReport } from './data-adapter';
import { runOne, type RunResult } from './run';
import {
  aggregateWaves,
  evaluateComfortBand,
  evaluateGates,
  evaluateQ1,
  summarize,
  type GroupSummary,
  type WaveAggregate,
} from './metrics';
import {
  analyzeAffordability,
  analyzeKillReward,
  analyzeTail,
  evaluateAltModel,
  solveAltGrowthForTail,
} from './tail-model';
import {
  detailOf,
  renderFullReport,
  renderTail,
  toCsv,
  toWaveCsv,
  type BalanceArtifact,
  type RunDetail,
} from './report';
import { analyzeTtk, maxedTechEffects } from './ttk-analysis';
import { analyzeEconomyBound } from './economy-bound';
import { isStrategyId, STRATEGY_IDS, type StrategyId } from './strategies/index';
import type { DifficultyId } from '../sim/content';

import techJson from '../data/tech.json';

const ALL_DIFFICULTIES: readonly DifficultyId[] = ['N1', 'N2', 'N3', 'N4', 'N5'];
const DEFAULT_SEED = 20261013;

interface Args {
  difficulties: DifficultyId[];
  strategies: StrategyId[];
  runs: number;
  out: string | null;
  json: string | null;
  seed: number;
  maxTicks: number;
  tailOnly: boolean;
  quiet: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    difficulties: [...ALL_DIFFICULTIES],
    strategies: [...STRATEGY_IDS],
    runs: 1,
    out: null,
    json: null,
    seed: DEFAULT_SEED,
    maxTicks: 240_000,
    tailOnly: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`参数 ${a} 缺少取值`);
      i++;
      return v;
    };
    switch (a) {
      case '--difficulty': {
        const v = next();
        args.difficulties =
          v === 'all'
            ? [...ALL_DIFFICULTIES]
            : (v.split(',').map((s) => s.trim().toUpperCase()) as DifficultyId[]).filter((d) =>
                (ALL_DIFFICULTIES as readonly string[]).includes(d),
              );
        if (args.difficulties.length === 0) throw new Error(`--difficulty '${v}' 无法识别（N1..N5 / all）`);
        break;
      }
      case '--strategy': {
        const v = next();
        if (v === 'all') args.strategies = [...STRATEGY_IDS];
        else {
          const list = v.split(',').map((s) => s.trim());
          for (const s of list) if (!isStrategyId(s)) throw new Error(`--strategy '${s}' 无法识别（${STRATEGY_IDS.join('/')} / all）`);
          args.strategies = list as StrategyId[];
        }
        break;
      }
      case '--runs':
        args.runs = Math.max(1, Number.parseInt(next(), 10) || 1);
        break;
      case '--out':
        args.out = next();
        break;
      case '--json':
        args.json = next();
        break;
      case '--seed':
        args.seed = Number.parseInt(next(), 10) || DEFAULT_SEED;
        break;
      case '--max-ticks':
        args.maxTicks = Math.max(60, Number.parseInt(next(), 10) || 240_000);
        break;
      case '--tail-only':
        args.tailOnly = true;
        break;
      case '--quiet':
        args.quiet = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数 '${a}'（--help 看用法）`);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(
    [
      'pnpm balance [选项]',
      '  --difficulty N1..N5|all   逗号分隔，默认 all',
      '  --strategy   greedy|balanced|optimal|noop|noblock|all   默认 all',
      '  --runs N                  每格局数（不同种子），默认 1',
      '  --out  <path.csv>         汇总 CSV（另写 <path>.waves.csv）',
      '  --json <path.json>        完整产物 JSON（tools/balance-report.ts 消费）',
      '  --seed N                  起始种子（默认 20261013）',
      '  --max-ticks N             单局 tick 上限（默认 240000 = 66 分钟）',
      '  --tail-only               只做尾部占比 / 备选模型分析',
      '  --quiet                   不打印终端表格',
    ].join('\n'),
  );
}

interface RawTech {
  id: string;
  maxLevel: number;
  costPerLevel: { gold: number; wood: number }[];
}

function prettyPath(p: string): string {
  const abs = resolve(p);
  const cwd = process.cwd();
  return abs.startsWith(cwd) ? abs.slice(cwd.length + 1) : abs;
}

function ensureDir(path: string): void {
  const dir = dirname(resolve(path));
  mkdirSync(dir, { recursive: true });
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const { content, report: adapterReport } = loadRealContentWithReport();

  const tail = analyzeTail(content, 26, 30);
  const targetTail = 500; // §5.4 目标 ≤ 50%
  const gSolved = solveAltGrowthForTail(content, targetTail);
  const gKeepScale = solveAltGrowthForTail(content, 700);
  const altModels = [evaluateAltModel(content, gSolved), evaluateAltModel(content, gKeepScale)];
  const affordability = analyzeAffordability(content, techJson as unknown as RawTech[]);
  const killReward = analyzeKillReward(content);

  if (args.tailOnly) {
    console.log(renderTail(tail, altModels));
    console.log('');
    console.log(
      `求解：要把尾部占比压到 ≤ ${targetTail / 10}%，每波总收入的增长率 g **最大**只能到约 ${(gSolved / 1000).toFixed(3)}（整数网格步长 0.005）——` +
        `g 越大成长感越强，所以这是「尾部约束下的成长上限」。`,
    );
    console.log('（本轮只评估，不实现；见 src/balance/tail-model.ts 与汇报的「未验证与缺口」）');
    return;
  }

  const summaries: GroupSummary[] = [];
  const aggregates: Record<string, WaveAggregate[]> = {};
  const details: RunDetail[] = [];
  const seeds: number[] = [];
  for (let i = 0; i < args.runs; i++) seeds.push((args.seed + i * 7919) >>> 0);

  const t0 = Date.now();
  for (const strategyId of args.strategies) {
    for (const difficultyId of args.difficulties) {
      const results: RunResult[] = [];
      for (const seed of seeds) {
        results.push(runOne({ content, difficultyId, strategyId, seed, maxTicks: args.maxTicks }));
      }
      const s = summarize(strategyId, difficultyId, results);
      summaries.push(s);
      aggregates[`${strategyId}|${difficultyId}`] = aggregateWaves(results, content.constants.totalWaves);
      for (const r of results) details.push(detailOf(r));
      if (!args.quiet) {
        console.log(
          `  ✓ ${strategyId} @ ${difficultyId}: ${s.wins}/${s.runs} 通关 ｜ 均到第 ${s.avgWaveReached} 波 ｜ 覆盖率 ${(s.stealCoverage / 10).toFixed(1)}% ｜ 漏怪率 ${(s.leakRate / 10).toFixed(2)}% ｜ 拒指令 ${s.rejections}`,
        );
      }
    }
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const gates = evaluateGates(summaries);
  const q1 = ALL_DIFFICULTIES.map((d) => evaluateQ1(d, summaries)).filter((x) => x !== null);
  const ttk = args.difficulties.map((d) => analyzeTtk(content, d, undefined, 'max'));
  const comfort = evaluateComfortBand(ttk.map((a) => ({ difficultyId: a.difficultyId, rows: a.rows })));
  // ★ 契约 §16.3：舒适带要用**经济感知上界**（到该波"合理经济能支撑的阵容"），不是最大军队上界。
  //   科技乘区取"满级"= 长期玩家的可达强度（该上界已含"预算"这个真实约束）。
  const maxTech = maxedTechEffects(content);
  const econ = args.difficulties.map((d) => analyzeEconomyBound(content, d, maxTech.attackMul, maxTech.attackSpeedMul));
  const econComfort = evaluateComfortBand(econ.map((a) => ({ difficultyId: a.difficultyId, rows: a.rows })));

  const artifact: BalanceArtifact = {
    generatedAt: new Date().toISOString(),
    command: `pnpm balance ${process.argv.slice(2).join(' ')}`.trim(),
    contentLabel: content.label,
    adapter: adapterReport,
    runs: args.runs,
    seeds,
    summaries,
    waveAggregates: aggregates,
    gates,
    q1,
    tail,
    altModels,
    affordability,
    killReward,
    ttk,
    comfort,
    economyComfort: econComfort,
    economyBound: econ,
    details,
  };

  if (args.out) {
    ensureDir(args.out);
    writeFileSync(args.out, toCsv(summaries) + '\n', 'utf8');
    writeFileSync(`${args.out}.waves.csv`, toWaveCsv(aggregates) + '\n', 'utf8');
    console.log(`\nCSV 已写出：${prettyPath(args.out)} 与 ${prettyPath(`${args.out}.waves.csv`)}`);
  }
  if (args.json) {
    ensureDir(args.json);
    writeFileSync(args.json, JSON.stringify(artifact, null, 2), 'utf8');
    console.log(`JSON 产物：${prettyPath(args.json)}`);
  }
  if (!args.quiet) {
    console.log('');
    console.log(renderFullReport(artifact));
  }
  console.log(`\n总耗时 ${elapsed}s，共 ${summaries.length} 格 / ${details.length} 局。`);
}

main();
