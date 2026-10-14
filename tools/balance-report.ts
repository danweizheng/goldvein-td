/**
 * `tools/balance-report.ts` —— 读跑批产物，渲染终端报告 + 汇总 CSV
 *
 * 所有者：`balance-eng`。这是 `pnpm balance --json <f>` 产物的**离线消费者**，
 * 便于把 CI 里跑出的数字拿回来单独出报告（不必重跑模拟）。
 *
 * ```bash
 * pnpm exec tsx tools/balance-report.ts --in out/balance.json
 * pnpm exec tsx tools/balance-report.ts --in out/balance.json --csv out/summary.csv
 * pnpm exec tsx tools/balance-report.ts --in out/balance.json --markdown > report.md
 * ```
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  renderAdapter,
  renderAffordability,
  renderFullReport,
  renderGates,
  renderGroupTable,
  renderKillReward,
  renderQ1,
  renderTail,
  renderTtk,
  toCsv,
  toWaveCsv,
  type BalanceArtifact,
} from '../src/balance/report';

interface Args {
  in: string | null;
  csv: string | null;
  markdown: boolean;
  waves: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { in: null, csv: null, markdown: false, waves: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`参数 ${a} 缺少取值`);
      i++;
      return v;
    };
    switch (a) {
      case '--in':
        args.in = next();
        break;
      case '--csv':
        args.csv = next();
        break;
      case '--markdown':
      case '--md':
        args.markdown = true;
        break;
      case '--waves':
        args.waves = true;
        break;
      case '--help':
      case '-h':
        console.log('tools/balance-report.ts --in <balance.json> [--csv out.csv] [--markdown] [--waves]');
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数 '${a}'`);
    }
  }
  return args;
}

function renderWaves(artifact: BalanceArtifact): string {
  const lines: string[] = ['逐波汇总（每格取平均；只列 balanced/noblock 与最优策略）'];
  const keys = Object.keys(artifact.waveAggregates).sort();
  const interesting = keys.filter((k) => k.startsWith('balanced|') || k.startsWith('noblock|'));
  for (const key of interesting) {
    const rows = artifact.waveAggregates[key] as NonNullable<BalanceArtifact['waveAggregates'][string]>;
    lines.push('');
    lines.push(`── ${key} ──`);
    lines.push('波  自出怪  窃金覆盖率  卡位窃金  漏怪  塔数');
    for (const w of rows) {
      lines.push(
        [
          String(w.wave).padStart(2),
          String(w.walletTotal / 1000).padStart(8),
          `${(w.stealCoverage / 10).toFixed(1)}%`.padStart(10),
          (w.blockExtraSteal / 1000).toFixed(1).padStart(9),
          String(w.leaks).padStart(4),
          String(w.towerCount).padStart(5),
        ].join(' '),
      );
    }
  }
  return lines.join('\n');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.in) throw new Error('缺少 --in <balance.json>（先跑 `pnpm balance --json out/balance.json`）');

  const artifact = JSON.parse(readFileSync(resolve(args.in), 'utf8')) as BalanceArtifact;

  if (args.markdown) {
    console.log(
      [
        `# 《窃金者 TD》平衡报告（来自 ${args.in}）`,
        '',
        `生成时间：${artifact.generatedAt}　｜　命令：\`${artifact.command}\`　｜　每格 ${artifact.runs} 局　｜　种子 ${artifact.seeds.join(', ')}`,
        '',
        '## 适配层与数据缺口',
        '```',
        renderAdapter(artifact.adapter),
        '```',
        '',
        '## 策略 × 难度 汇总',
        '```',
        renderGroupTable(artifact.summaries),
        '```',
        '',
        '## 门禁',
        '```',
        renderGates(artifact.gates),
        '```',
        '',
        '## Q1（军训系存在性）',
        '```',
        renderQ1(artifact.q1),
        '```',
        '',
        '## 尾部占比与备选模型',
        '```',
        renderTail(artifact.tail, artifact.altModels),
        '```',
        '',
        '## DPS 可行性（与 AI 无关的硬边界）',
        '```',
        renderTtk(artifact.ttk),
        '```',
        '',
        '## §5.4 资金充足性',
        '```',
        renderAffordability(artifact.affordability),
        '```',
        '',
        '## 击杀奖励量级',
        '```',
        renderKillReward(artifact.killReward),
        '```',
      ].join('\n'),
    );
  } else {
    console.log(renderFullReport(artifact));
  }

  if (args.waves) {
    console.log('');
    console.log(renderWaves(artifact));
  }

  if (args.csv) {
    mkdirSync(dirname(resolve(args.csv)), { recursive: true });
    writeFileSync(args.csv, toCsv(artifact.summaries) + '\n', 'utf8');
    writeFileSync(`${args.csv}.waves.csv`, toWaveCsv(artifact.waveAggregates) + '\n', 'utf8');
    console.log(`\nCSV：${args.csv}（+ ${args.csv}.waves.csv）`);
  }
}

main();
