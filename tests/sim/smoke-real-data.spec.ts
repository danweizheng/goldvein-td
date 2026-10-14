/**
 * 冒烟验证：**真实数据**能驱动一局完整模拟
 *
 * 这是「问题 1」的验收：确认敌人真的按 `waves.json` 出场、窃金真的入账、波次真的推进，
 * 且**科技表真的进了 `SimContent`**（契约 §14.2 的端到端验证 —— 缺这张表时
 * `research` 会返回「未知科技」，整条指数通道静默失效）。
 */
import { describe, expect, it } from 'vitest';
import { loadRealContent } from '../../src/balance/data-adapter';
import { runOne } from '../../src/balance/run';
import { analyzeTail, waveWalletTheory } from '../../src/balance/tail-model';
import { buildPlacement } from '../../src/balance/strategies/placement';
import { createWorldWithContent, snapshot } from '../../src/sim/world';
import { drainEvents, step } from '../../src/sim/tick';
import type { SimContent } from '../../src/sim/content';
import type { Cell } from '../../src/sim/types';

/** 取第一个可建造格（只用于把「科技乘区作用到塔」这一段跑通）。 */
function firstBuildableCell(c: SimContent): Cell {
  const model = buildPlacement(c, 2);
  const cell = model.pick(new Set<number>(), [], -1);
  if (!cell) throw new Error('没有可建造格（地图数据异常）');
  return cell;
}

const content = loadRealContent();

/**
 * §5.2 / §14.12 的文档值（**由主策划维护**）。
 * 测试从数据算出、再与这些文档值比对 —— 而不是两边都硬编码，
 * 这样上游调参只需要改文档一处（见 §14.5 的教训）。
 */
const DOC_WAVE_WALLET: readonly [number, number][] = [
  [1, 192],
  [5, 690],
  [10, 2509],
  [20, 41911],
  [25, 142458],
  [30, 633004],
];
const DOC_TOTAL_WALLET = 2204577;
const DOC_TAIL_SHARE_PERMILLE = 740;

describe('真实数据冒烟', () => {
  it('第 1 波总钱包 = 解析值（§5.2 表：192 金）', () => {
    const theory = waveWalletTheory(content, 1);
    expect(theory.count).toBe(6);
    expect(theory.wallet).toBe(192000); // 6 × 32 金
  });

  it('波次总钱包与策划案 §5.2 的关键点一致（从数据算出 vs 文档值，±0.2%）', () => {
    for (const [wave, gold] of DOC_WAVE_WALLET) {
      const got = waveWalletTheory(content, wave).wallet / 1000;
      expect(Math.abs(got - gold) / gold, `第 ${wave} 波：算出 ${got.toFixed(0)} vs 文档 ${gold}`).toBeLessThan(0.002);
    }
    const tail = analyzeTail(content);
    const totalDisplay = tail.totalWallet / 1000;
    expect(Math.abs(totalDisplay - DOC_TOTAL_WALLET) / DOC_TOTAL_WALLET).toBeLessThan(0.002);
  });

  it('尾部占比与 §14.12 记录的 74.0% 同量级', () => {
    const tail = analyzeTail(content);
    expect(Math.abs(tail.tailShare - DOC_TAIL_SHARE_PERMILLE)).toBeLessThan(20);
  });

  it('★ 科技管线端到端：表进世界 → research 被接受 → 乘区真的变大', () => {
    expect(content.tech).toBeDefined();
    expect(Object.keys(content.tech ?? {}).length).toBe(8);

    // ① 表真的进了**世界**：新建世界的快照就应当有 8 条科技线
    const w = createWorldWithContent({ seed: 1, difficultyId: 'N1', relics: {}, techArchive: {} }, content);
    const techs = snapshot(w).techs;
    expect(techs.length).toBe(8);
    expect(techs.every((t) => t.maxLevel >= 1)).toBe(true);

    // ② 直接发一条 research（不依赖 AI 的经济）：必须被接受，且效果真的落到乘区上。
    //    这一步是「表接错了」的最强探针 —— 接错时 researchTech 会返回"未知科技"。
    const before = w.tech.attackMul;
    expect(before).toBe(1000);
    step(w, [{ type: 'research', techId: 'attack' }]);
    const evs = drainEvents(w);
    const rejected = evs.filter((e) => e.type === 'commandRejected');
    expect(rejected.map((e) => (e.type === 'commandRejected' ? e.reason : '')), 'research 被拒').toEqual([]);
    expect(w.techLevels['attack']).toBe(1);
    // 攻击 ×1.50/级 → 1500（这条断言同时证明了 effectMode='mul' 真的生效，而不是 +10% 加法）
    expect(w.tech.attackMul).toBe(1500);

    // ③ 乘区真的作用到塔：同一座塔的面板攻击被放大
    step(w, [{ type: 'build', unitId: 'pickpocket', cell: firstBuildableCell(content) }]);
    drainEvents(w);
    const tower = w.towers[0];
    expect(tower).toBeDefined();
    // 拾取小偷偷的 baseAttack 是 8（定点 8000），科技 ×1.5 → 12000
    expect(tower?.attack).toBe(12000);
  });

  it('AI 侧记录：科技造价 ×2.16 后，N1/N2 的 balanced 已买不起第一级（策略侧结论，非管线故障）', () => {
    const r = runOne({ content, difficultyId: 'N1', strategyId: 'balanced', seed: 20261013, maxTicks: 240_000 });
    const issued = r.commands['research'] ?? 0;
    console.log(
      `[科技可达性] balanced@N1 到第 ${r.waveReached} 波 ｜ research 指令 ${issued} 条 ｜ 已研究 ${r.techResearched} 级 ｜ ` +
        `科技支出 ${(r.techSpentGold / 1000).toFixed(0)} 金（占支出 ${(r.techSpentGold / Math.max(1, r.spentTotal) * 100).toFixed(1)}%）`,
    );
    // 这条**不**断言"必须研究"（那会把 AI 的经济能力当成管线正确性）；只记录数字。
    expect(r.techResearched).toBeGreaterThanOrEqual(0);
    expect(r.rejections).toBe(0);
  });

  it('balanced @ N2：敌人按 waves.json 出场、窃金入账、波次推进', () => {
    const r = runOne({ content, difficultyId: 'N2', strategyId: 'balanced', seed: 12345, maxTicks: 240_000 });

    expect(r.waves.length).toBeGreaterThanOrEqual(3);
    const numbers = r.waves.map((w) => w.wave);
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1));

    const w1 = r.waves[0];
    expect(w1?.walletTotal).toBe(192000);
    expect(w1?.leaks).toBe(0);

    expect(r.stolenTotal).toBeGreaterThan(0);
    expect(w1?.stolenTotal).toBeGreaterThan(0);
    expect(w1?.stealCoverage).toBeGreaterThan(0);
    expect(w1?.stealCoverage).toBeLessThanOrEqual(1000);

    expect(r.towerCount).toBeGreaterThan(0);
    expect(r.commands['build'] ?? 0).toBeGreaterThan(0);
    // 没有非法指令（build 全部落在可建造格 + 根单位上，契约 §14.7）
    expect(r.rejections).toBe(0);
  });

  it('逐波 WaveStats 与全局累计自洽（差值为「未结算的最后一波」）', () => {
    const r = runOne({ content, difficultyId: 'N2', strategyId: 'balanced', seed: 999, maxTicks: 240_000 });
    let sumStolen = 0;
    let sumWallet = 0;
    for (const w of r.waves) {
      sumStolen += w.stolenTotal;
      sumWallet += w.walletTotal;
    }
    expect(sumStolen).toBeLessThanOrEqual(r.stolenTotal);
    expect(sumWallet).toBeLessThanOrEqual(r.walletTotal);
    if (r.status === 'won') {
      expect(sumStolen).toBe(r.stolenTotal);
      expect(sumWallet).toBe(r.walletTotal);
    }
  });

  it('同一 (seed, 难度, 策略) 两次跑批完全一致（可复现）', () => {
    const opts = { content, difficultyId: 'N2', strategyId: 'balanced', seed: 4242, maxTicks: 20_000 } as const;
    const a = runOne(opts);
    const b = runOne(opts);
    expect(a.hash).toBe(b.hash);
    expect(a.ticks).toBe(b.ticks);
    expect(a.stolenTotal).toBe(b.stolenTotal);
    expect(a.techResearched).toBe(b.techResearched);
    expect(a.waves.length).toBe(b.waves.length);
  });

  it('换种子会改变结果（证明哈希有区分度，不是恒等）', () => {
    const base = { content, difficultyId: 'N2', strategyId: 'balanced', maxTicks: 20_000 } as const;
    const a = runOne({ ...base, seed: 1 });
    const b = runOne({ ...base, seed: 2 });
    expect(a.hash).not.toBe(b.hash);
  });
});
