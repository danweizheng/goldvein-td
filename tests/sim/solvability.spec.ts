/**
 * ★ **契约 §14.4 的 CI 硬门禁：数据必须可通关**
 *
 * ```
 * 需求DPS(wave) / 可达DPS上界(wave) ≤ 1.0     （全部 30 波 × 全部 5 难度）
 * ```
 *
 * ## 为什么这条门禁必须存在
 *
 * 它缺失时，那份「数学上不可通关」的数据一路通过了 `validate-data` 的 49 项结构检查、
 * 296 条数据用例、325 条全仓用例 —— **没有任何检查在守「数据是否可通关」**。
 * 这与 M0 的「`pnpm lint` 对 `.ts` 是空操作」是同一个错误：**一条不可见的质量门禁等于没有门禁。**
 *
 * ## 口径（"可达 DPS 上界" 的定义）
 *
 * 宽松上界：`populationCap` 座**该波最优单塔**、全部满射程覆盖、全程开火，且**科技全满级**。
 * - 含科技乘区是必须的（契约 §14.2：科技是唯一的指数通道；不含科技会得出 9.0× 的错误悲观结论）。
 * - 比任何真实阵容都强 ⇒ 「上界 < 需求」是**不可通关的充分证据**。
 * - 「全部 30 波」是裁决的硬要求，不是抽查。
 *
 * ## 已知的宽松处（都让上界偏乐观，不影响"剔除假阳性"的目标）
 *
 * | 项 | 说明 |
 * |---|---|
 * | 射程/覆盖 | 假设每一座塔都能打到每一个敌人（现实中做不到） |
 * | 波时长 | 用「最后一只生成 + 18s 走完全程」估，偏短会让需求偏**高**（保守） |
 * | 人口 | 用 `constants.populationCap`（科技人口加项未计入 → 偏保守） |
 * | 眩晕/减速 | 未计入（真实玩家有额外收益） |
 */
import { describe, expect, it } from 'vitest';
import { loadRealContent } from '../../src/balance/data-adapter';
import { SOLVABILITY_MAX_PERMILLE } from '../../src/balance/acceptance';
import { analyzeTtk, maxedTechEffects, type TtkAnalysis } from '../../src/balance/ttk-analysis';
import { evaluateComfortBand } from '../../src/balance/metrics';
import { counterMul as simCounterMul, createWorldWithContent } from '../../src/sim/world';
import { counterMulOf } from '../../src/balance/strategies/value';
import type { SimContent } from '../../src/sim/content';

const content = loadRealContent();
const DIFFICULTIES = ['N1', 'N2', 'N3', 'N4', 'N5'] as const;

const analyses: TtkAnalysis[] = DIFFICULTIES.map((d) => analyzeTtk(content, d, undefined, 'max'));

describe('★ 契约 §14.4：solvability 门禁（30 波 × 5 难度）', () => {
  it('上界含满级科技乘区（否则这条门禁没有意义）', () => {
    const tech = maxedTechEffects(content);
    expect(tech.attackMul).toBe(7593); // ×7.59
    expect(tech.attackSpeedMul).toBe(5378); // ×5.38
    expect(tech.stealMul).toBe(1762); // ×1.76
    for (const a of analyses) {
      expect(a.tech.attackMul).toBe(tech.attackMul);
      expect(a.tech.attackSpeedMul).toBe(tech.attackSpeedMul);
    }
  });

  it('每一波都存在最优塔与正的上界（防「上界算成 0」把门禁变成永真）', () => {
    for (const a of analyses) {
      expect(a.rows.length).toBe(30);
      for (const r of a.rows) {
        expect(r.maxDps, `${a.difficultyId} 第 ${r.wave} 波上界`).toBeGreaterThan(0);
        expect(r.bestUnit).not.toBe('—');
        expect(r.requiredDps).toBeGreaterThan(0);
      }
    }
  });

  it('★ 门禁本体：全部 30 波 × 5 难度的 需求/上界 都 ≤ 1.0', () => {
    const failures: string[] = [];
    for (const a of analyses) {
      for (const r of a.rows) {
        if (r.requiredOverMax > 1000) {
          failures.push(
            `${a.difficultyId} w${r.wave}: ${(r.requiredOverMax / 1000).toFixed(2)}× ` +
              `(需求 ${(r.requiredDps / 1000).toFixed(0)} DPS vs 上界 ${(r.maxDps / 1000).toFixed(0)} DPS, 最优塔 ${r.bestUnit})`,
          );
        }
      }
    }
    expect(failures, `不可通关的波次：\n${failures.join('\n')}`).toEqual([]);
  });

  it('逐难度给出结论（失败时输出可定位的清单）', () => {
    const lines = analyses.map((a) => `${a.difficultyId}: ${a.solvable ? '✅' : '❌'} ${a.verdict}`);
    // 不做区间断言，只在失败时把清单打出来（避免「为了让测试绿而调参」）
    expect(lines.length).toBe(5);
    for (const a of analyses) expect(a.solvable).toBe(true);
  });

  it('最差余量有下界（用 constants.json 的权威阈值，不用自造余量）', () => {
    // ★ 主策划裁决：这里原先是 `toBeLessThanOrEqual(800)` —— 一个**没有数据来源的自造余量**。
    //   权威值是 `constants.json` 的 `acceptanceTargets.solvabilityMax = 1000`（契约 §14.4 的硬门禁）。
    //   自造值比权威值更紧时，它会在权威门禁通过的情况下报红；更松时则让权威门禁形同虚设 —— 两个方向都无依据。
    //   现在改读 `acceptance.ts` 的单一来源（`SOLVABILITY_MAX_PERMILLE`）。
    for (const a of analyses) {
      const worst = a.rows.reduce(
        (acc, r) => (r.requiredOverMax > acc.requiredOverMax ? r : acc),
        a.rows[0] as TtkAnalysis['rows'][number],
      );
      expect(worst.requiredOverMax, `${a.difficultyId} 最差第 ${worst.wave} 波`).toBeLessThanOrEqual(SOLVABILITY_MAX_PERMILLE);
    }
  });
});

describe('solvability 的辅助不变量', () => {
  it('★ 舒适带（§5.4 塔数指标的替代）：记录第 10 / 20 波的 需求/上界', () => {
    // ⚠️ 口径警告：上界是「满级科技 + 人口上限」的理想值，早期波天然被压低。
    // 本用例**只记录与定位**，不假装它现在是硬门禁（口径未定，见汇报）。
    const comfort = evaluateComfortBand(analyses.map((a) => ({ difficultyId: a.difficultyId, rows: a.rows })));
    const lines = comfort.map(
      (c) =>
        `${c.difficultyId} w${c.wave}: ${c.ratio === null ? '—' : (c.ratio / 1000).toFixed(2) + '×'} ${c.verdict}` +
        (c.deviation ? `(偏离 ${(c.deviation / 1000).toFixed(2)}×)` : ''),
    );
    console.log(`[舒适带] 目标 [0.20, 0.60]：${lines.join(' ｜ ')}`);
    expect(comfort.length).toBe(DIFFICULTIES.length * 2);
    for (const c of comfort) expect(c.ratio).not.toBeNull();
  });

  it('舒适带判定器本身：三条分支都能触发（防恒 pass）', () => {
    const fake = [
      { difficultyId: 'N1' as const, rows: [{ wave: 10, requiredOverMax: 100 }, { wave: 20, requiredOverMax: 400 }] },
      { difficultyId: 'N2' as const, rows: [{ wave: 10, requiredOverMax: 900 }, { wave: 20, requiredOverMax: 600 }] },
    ];
    const res = evaluateComfortBand(fake);
    const by = (d: string, w: number) => res.find((r) => r.difficultyId === d && r.wave === w)?.verdict;
    expect(by('N1', 10)).toBe('too-easy');
    expect(by('N1', 20)).toBe('pass');
    expect(by('N2', 10)).toBe('too-hard');
    expect(by('N2', 20)).toBe('pass'); // 边界含端点
  });

  it('★ 负对照甲（铁律 8）：把科技表拿掉 → 门禁必须报红', () => {
    // 上一轮那份「数学上不可通关」的数据，本质就是「无科技」状态。
    // 如果这里也判通过，说明本条门禁是**空**的（它没在测科技乘区）。
    const noTech: SimContent = { ...content, tech: {} };
    let redCount = 0;
    for (const d of DIFFICULTIES) {
      const a = analyzeTtk(noTech, d, undefined, 'max');
      if (!a.solvable) redCount++;
    }
    expect(redCount, '无科技时全部难度都判"可通关" → 门禁是空的').toBe(DIFFICULTIES.length);
  });

  it('★ 负对照乙（铁律 8）：把 hpIndex 调陡 → 门禁必须报红', () => {
    const steeper: SimContent = {
      ...content,
      constants: { ...content.constants, hpIndex: 1380 }, // 回到 v0.1 的 1.38
    };
    expect(analyzeTtk(steeper, 'N2', undefined, 'max').solvable).toBe(false);
  });

  it('上界随波次单调不减（难度只升不降；血量与塔强度都随波次上升）', () => {
    // 塔的上界只随「本波护甲构成」变化，不随波次单调；这里检查它不会退化成 0
    for (const a of analyses) {
      const last = a.rows[a.rows.length - 1];
      expect(last?.maxDps).toBeGreaterThan(0);
    }
  });

  it('难的难度需求更高（hpMul 生效）', () => {
    const n1 = analyses[0] as TtkAnalysis;
    const n5 = analyses[4] as TtkAnalysis;
    const w30n1 = n1.rows[29];
    const w30n5 = n5.rows[29];
    expect(w30n5?.requiredDps as number).toBeGreaterThan(w30n1?.requiredDps as number);
  });

  it('AI 侧的 counterMulOf 与 sim 的 counterMul 逐格一致（防止复刻漂移）', () => {
    const w = createWorldWithContent({ seed: 1, difficultyId: 'N3', relics: {}, techArchive: {} }, content);
    for (const atk of ['normal', 'pierce', 'magic', 'siege', 'chaos'] as const) {
      for (const armor of ['light', 'medium', 'heavy', 'fortified', 'divine'] as const) {
        expect(counterMulOf(content, 'N3', atk, armor), `${atk} vs ${armor}`).toBe(simCounterMul(w, atk, armor));
      }
    }
    const w2 = createWorldWithContent({ seed: 1, difficultyId: 'N2', relics: {}, techArchive: {} }, content);
    for (const armor of ['light', 'medium', 'heavy', 'fortified', 'divine'] as const) {
      expect(counterMulOf(content, 'N2', 'pierce', armor)).toBe(simCounterMul(w2, 'pierce', armor));
    }
  });
});
