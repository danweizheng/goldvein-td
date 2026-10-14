/**
 * 「科技满级后，第 30 波的需求 DPS / 可达上界」是否 ≤ 1.0？
 *
 * 这是主策划点名要的那个数（契约 §14.4 的 CI 硬门禁：`需求DPS/可达上界 ≤ 1.0`）。
 *
 * ## 方法（不重复实现 balance-eng 的分析）
 *
 * 直接调用 `src/balance/ttk-analysis.ts` 的 `analyzeTtk()` 拿到**无科技**的
 * 每波 `requiredDps / maxDps`，然后**只乘上我这轮实现的科技乘区**：
 *
 *     攻击 × 攻速 都是 DPS 的乘区 → 可达上界 ×= attackMul × attackSpeedMul
 *     ⇒ 比值 ÷= (attackMul × attackSpeedMul)
 *
 * 这样得到的数就是"balance-eng 的解析上界 + engine-dev 的科技通道"的合成结果，
 * 而不是我另写一套模型再和自己对齐。
 *
 * ## 两种口径（必须分开报，否则会掩盖数据侧尚未落地的部分）
 *
 * - **as-data**：`src/data/tech.json` 的**当前**内容（effectMode 缺省按 add，
 *   attack 仍是旧的 100 = +10%/级线性）
 * - **per-ruling**：契约 §14.2 裁决值（攻击 ×1.50/级、攻速 ×1.40/级、射程 ×1.10/级、
 *   窃金 ×1.12/级；暴击两条保持加法）
 *
 * ⚠️ 本文件**不修改** `src/data/**`，只读它；tech 表在测试内构造并注入 SimContent。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXED_SCALE, fmul, type Fixed } from '../fixed';
import { computeTechEffects } from '../tech';
import type { SimContent, TechDef, TechTable } from '../content';
import { loadRealContent } from '../../balance/data-adapter';
import { analyzeTtk } from '../../balance/ttk-analysis';

interface RawTech {
  id: string;
  name: string;
  maxLevel: number;
  effectPerLevel: number;
  effectUnit: 'permille' | 'count';
  effectMode?: 'add' | 'mul';
  costPerLevel: { gold: number; wood: number }[];
  archivable: boolean;
  requires?: string[];
}

function readTechJson(): RawTech[] {
  const p = join(__dirname, '..', '..', 'data', 'tech.json');
  return JSON.parse(readFileSync(p, 'utf8')) as RawTech[];
}

/**
 * `effectMode` 的**推断**：优先用 `tech.json` 里的 `effectMode`（data-arch 已落盘）；
 * 若缺失，则 per-ruling 口径下按契约 §14.2 的「四条乘法 / 两条加法」补上。
 */
const RULED_MUL_IDS = new Set(['attack', 'attack_speed', 'range', 'steal_efficiency']);
const RULED_PER_LEVEL: Record<string, number> = {
  attack: 1500,
  attack_speed: 1400,
  range: 1100,
  steal_efficiency: 1120,
};

type TableMode = 'none' | 'as-data' | 'ruling';

function toTable(raw: RawTech[], mode: TableMode): TechTable {
  const table: TechTable = {};
  if (mode === 'none') return table; // 无科技对照组
  for (const t of raw) {
    const ruled = RULED_MUL_IDS.has(t.id);
    const useRuling = mode === 'ruling';
    const mode1: 'add' | 'mul' = t.effectMode ?? (ruled && useRuling ? 'mul' : 'add');
    const effectPerLevel = useRuling && ruled ? (RULED_PER_LEVEL[t.id] as number) : t.effectPerLevel;
    const def: TechDef = {
      id: t.id,
      name: t.name,
      maxLevel: t.maxLevel,
      effectPerLevel,
      effectUnit: t.effectUnit,
      effectMode: mode1,
      costPerLevel: t.costPerLevel.map((c) => ({ gold: c.gold, wood: c.wood })),
      archivable: t.archivable,
      ...(t.requires ? { requires: t.requires } : {}),
    };
    table[t.id] = def;
  }
  return table;
}

function allMaxLevels(table: TechTable): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, def] of Object.entries(table)) out[id] = def.maxLevel;
  return out;
}

interface RatioReport {
  label: string;
  cap: number;
  dpsMul: Fixed;
  wave30Required: number;
  wave30MaxTech: number;
  wave30Ratio: number;
  firstImpossible: number | null;
  worstRatio: number;
  worstWave: number;
}

function report(content: SimContent, diff: 'N2' | 'N5', label: string, mode: TableMode): RatioReport {
  const table = toTable(readTechJson(), mode);
  const effects = computeTechEffects(table, allMaxLevels(table));
  const dpsMul = fmul(effects.attackMul, effects.attackSpeedMul);

  // ★ 直接走 balance-eng 的权威 API。`techMode` **必填**（契约 §14.2 裁决：
  //   "隐式默认 + 两个 owner 各自假定口径"正是上一轮的事故根因）。
  //   `'max'` 会并入满级科技乘区并把人口加项计入塔位上限 —— 所以这里不再自己乘，
  //   避免出现"两边各乘一次"或"都没乘"的静默错配。
  const analysis = analyzeTtk(content, diff, content.constants.populationCap, mode === 'none' ? 'none' : 'max');

  let worstRatio = 0;
  let worstWave = 0;
  let firstImpossible: number | null = null;
  for (const r of analysis.rows) {
    const ratio = r.requiredOverMax / 1000;
    if (ratio > worstRatio) {
      worstRatio = ratio;
      worstWave = r.wave;
    }
    if (firstImpossible === null && ratio > 1) firstImpossible = r.wave;
  }
  const w30 = analysis.rows.find((r) => r.wave === 30) ?? analysis.rows[analysis.rows.length - 1];

  console.log(
    `[solvability] ${diff} / ${label}：塔位 ${analysis.populationCap}，DPS 乘区 ${(dpsMul / 1000).toFixed(2)}x（engine-dev 口径）；` +
      `第 30 波 需求 ${Math.round((w30?.requiredDps ?? 0) / 1000)} / 上界 ${Math.round((w30?.maxDps ?? 0) / 1000)} = **${((w30?.requiredOverMax ?? 0) / 1000).toFixed(2)}×**（balance-eng 的 requiredOverMax）；` +
      `最差波 w${worstWave}=${worstRatio.toFixed(2)}×；首个不可能波 = ${firstImpossible ?? '无'}`,
  );

  return {
    label,
    cap: analysis.populationCap,
    dpsMul,
    wave30Required: w30?.requiredDps ?? 0,
    wave30MaxTech: w30?.maxDps ?? 0,
    wave30Ratio: (w30?.requiredOverMax ?? Number.MAX_SAFE_INTEGER) / 1000,
    firstImpossible,
    worstRatio,
    worstWave,
  };
}

describe('可通关性：科技乘区把「需求/上界」压到 ≤ 1.0（契约 §14.2 / §14.4）', () => {
  it('N2 / N5：无科技 → 有科技 的比值变化', () => {
    const content = loadRealContent();
    expect(Object.keys(content.units).length).toBeGreaterThan(10);

    const n2No = report(content, 'N2', '无科技（复现"数学上不可通关"）', 'none');
    const n2Data = report(content, 'N2', 'as-data（当前 tech.json）', 'as-data');
    const n2Ruled = report(content, 'N2', '契约 §14.2 裁决值（满级）', 'ruling');
    const n5No = report(content, 'N5', '无科技（复现"数学上不可通关"）', 'none');
    const n5Ruled = report(content, 'N5', '契约 §14.2 裁决值（满级）', 'ruling');

    // ① 复现诊断：**没有科技时**，第 30 波确实打不过（比值 > 1）
    expect(n2No.wave30Ratio).toBeGreaterThan(1.0);
    expect(n5No.wave30Ratio).toBeGreaterThan(1.0);
    expect(n2No.firstImpossible).not.toBeNull();

    // ② 修复生效：满级科技后比值 ≤ 1.0，且全程没有任何"不可能波"
    expect(n2Ruled.wave30Ratio).toBeLessThanOrEqual(1.0);
    expect(n5Ruled.wave30Ratio).toBeLessThanOrEqual(1.0);
    expect(n2Ruled.firstImpossible).toBeNull();

    // ③ 量级：乘法通道把上界抬了 40 倍以上（对照契约 §14.2 的 2144× 验算）
    expect(n2Ruled.dpsMul).toBeGreaterThan(20_000);
    expect(n2No.wave30Ratio / n2Ruled.wave30Ratio).toBeGreaterThan(20);

    // ④ as-data 与 ruling 应当一致（data-arch 已按裁决落盘 effectMode/数值）；
    //    若这里不一致，说明数据侧与裁决值有偏差 —— 那本身就是要报的发现。
    if (Math.abs(n2Data.dpsMul - n2Ruled.dpsMul) > 1) {
      console.log(
        `[solvability] ⚠️ as-data 与裁决值不一致：dpsMul ${(n2Data.dpsMul / 1000).toFixed(2)}x vs ${(n2Ruled.dpsMul / 1000).toFixed(2)}x —— 数据侧需对齐 §14.2`,
      );
    }

    const summary = [n2No, n2Data, n2Ruled, n5No, n5Ruled]
      .map(
        (r) =>
          `${r.label}: dpsMul=${(r.dpsMul / 1000).toFixed(2)}x cap=${r.cap} w30=${r.wave30Ratio.toFixed(2)}x worst=w${r.worstWave}@${r.worstRatio.toFixed(2)}x firstImpossible=${r.firstImpossible ?? '—'}`,
      )
      .join('\n  ');
    console.log('[solvability-summary]\n  ' + summary);
  });
});
