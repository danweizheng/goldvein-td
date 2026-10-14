/**
 * ★★ **护甲克制假设**（主策划裁决 3）—— 先测假设，不先调策略
 *
 * ## 待验证的假设
 *
 * 观察到：**agingMax 在 1..5 全区间，存活都是 11–12 波** ⇒ 这更像**硬门槛**而非"分配梯度"。
 * 而第 12–13 波正是策划案 §4.5.1 的波段边界（「分化 9–12：重甲、城甲出现」），
 * §14.2 的第 12 波是 `{混混 12, 装甲车 3}` —— **城甲**。
 *
 * **假设**：这道门槛是「**护甲克制失败**」，不是"塔不够多"。
 * 依据：§4.3 标准矩阵里 **城甲只被「攻城」克制（×2.0），被穿刺压制到 ×0.35**。
 * 若 AI 建的是弓箭系（穿刺），打城甲只有 1/3 的伤害，而且它会**建更多同类型的塔来补输出，越补越亏**。
 *
 * ## 三项测试（主策划指定）
 *
 * 1. **逐波护甲构成表**：每个策略**首次漏怪那一波**的敌人护甲构成（尤其城甲占比）
 * 2. **对照**：把 AI 输出动作集**限制为只能建攻城系（`siege`）** → 存活是否越过第 12 波？
 * 3. **反向对照**：限制为**只能建穿刺系（`pierce`）** → 是否死得更早？
 *
 * ⚠️ 经济（窃金塔）在两个对照里都**不受限** —— 要隔离的是"输出类型选错"，不是"没有经济"。
 *
 * 用法：`pnpm exec tsx src/balance/armor-hypothesis.ts [--difficulty N2] [--runs 3]`
 */
import { loadRealContent } from './data-adapter';
import { runOne, type RunResult } from './run';
import type { AttackType, DifficultyId } from '../sim/content';

interface ArmorShare {
  armor: string;
  count: number;
}

function pct(v: number): string {
  return `${(v / 10).toFixed(1)}%`;
}

/** 取某一波的敌人护甲构成（来自 `content.waves` 的配置）。 */
function armorComposition(content: ReturnType<typeof loadRealContent>, wave: number): ArmorShare[] {
  const def = content.waves.find((w) => w.wave === wave);
  if (!def) return [];
  const byArmor = new Map<string, number>();
  for (const g of def.groups) {
    const e = content.enemies[g.enemy];
    const armor = String(e?.armorType ?? '?');
    byArmor.set(armor, (byArmor.get(armor) ?? 0) + g.count);
  }
  return [...byArmor.entries()].map(([armor, count]) => ({ armor, count })).sort((a, b) => b.count - a.count);
}

function main(): void {
  const argv = process.argv.slice(2);
  let diff: DifficultyId = 'N2';
  let runs = 3;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--difficulty') diff = (argv[i + 1] ?? 'N2') as DifficultyId;
    if (argv[i] === '--runs') runs = Math.max(1, Number.parseInt(argv[i + 1] ?? '3', 10) || 3);
  }
  const content = loadRealContent();
  const seeds = [20261013, 20268932, 20276851].slice(0, runs);

  // ── 测试 ①：现有各策略「首次漏怪那一波」的护甲构成 ──
  console.log(`★护甲克制假设 ｜ 难度 ${diff} ｜ 每格 ${runs} 局\n`);
  console.log('【① 首次漏怪那一波的护甲构成】');
  console.log(
    ['策略', '局', '首漏波', '该波护甲构成（数量）', '城甲占比'].map((h, i) => (i < 2 ? h.padEnd(10) : h.padStart(12))).join(' '),
  );
  const strategies = ['balanced', 'gap', 'heuristic', 'noop'] as const;
  const firstLeakWaves: number[] = [];
  for (const sid of strategies) {
    for (const seed of seeds) {
      const r = runOne({ content, difficultyId: diff, strategyId: sid, seed, maxTicks: 240_000 });
      const firstLeak = r.waves.find((w) => w.leaks > 0);
      if (!firstLeak) {
        console.log([sid.padEnd(10), String(seed).slice(-4).padStart(10), '无漏怪'.padStart(12)].join(' '));
        continue;
      }
      firstLeakWaves.push(firstLeak.wave);
      const comp = armorComposition(content, firstLeak.wave);
      const total = comp.reduce((a, c) => a + c.count, 0);
      const fortified = comp.find((c) => c.armor === 'fortified')?.count ?? 0;
      console.log(
        [
          sid.padEnd(10),
          String(seed).slice(-4).padStart(10),
          String(firstLeak.wave).padStart(12),
          ` ${comp.map((c) => `${c.armor}×${c.count}`).join(' + ')}`,
          `${((fortified * 100) / Math.max(1, total)).toFixed(0)}%`.padStart(8),
        ].join(' '),
      );
    }
  }
  if (firstLeakWaves.length > 0) {
    const avg = firstLeakWaves.reduce((a, b) => a + b, 0) / firstLeakWaves.length;
    console.log(`  ⇒ 首次漏怪波：平均第 ${avg.toFixed(1)} 波（范围 ${Math.min(...firstLeakWaves)}–${Math.max(...firstLeakWaves)}）`);
  }

  // ── ②③：限制输出攻击类型的对照 ──
  console.log('\n【②③ 限制输出攻击类型的对照（经济不受限）】');
  console.log(
    ['限制', '载体', '窃金覆盖', '均到波', '最好', '漏怪率', '窃金塔数', '最高等级']
      .map((h, i) => (i < 2 ? h.padEnd(12) : h.padStart(10)))
      .join(' '),
  );
  const cases: readonly [string, readonly string[] | undefined][] = [
    ['不限（现状）', undefined],
    ['只攻城 siege', ['siege']],
    ['只穿刺 pierce', ['pierce']],
    ['只魔法 magic', ['magic']],
  ];
  const results: { label: string; avgWave: number; cov: number }[] = [];
  for (const [label, types] of cases) {
    for (const carrier of ['gap', 'heuristic'] as const) {
      const rs: RunResult[] = [];
      for (const seed of seeds) {
        rs.push(
          runOne({
            content,
            difficultyId: diff,
            strategyId: carrier,
            seed,
            maxTicks: 240_000,
            allowedAttackTypes: types as readonly AttackType[] | undefined,
          }),
        );
      }
      const n = rs.length;
      const stolen = rs.reduce((a, r) => a + r.stolenTotal, 0);
      const wallet = rs.reduce((a, r) => a + r.walletTotal, 0);
      const cov = wallet > 0 ? Math.trunc((stolen * 1000) / wallet) : 0;
      const avgWave = Math.round(rs.reduce((a, r) => a + r.waveReached, 0) / n);
      if (carrier === 'gap') results.push({ label, avgWave, cov });
      console.log(
        [
          label.padEnd(12),
          carrier.padEnd(12),
          pct(cov).padStart(10),
          String(avgWave).padStart(10),
          String(Math.max(...rs.map((r) => r.waveReached))).padStart(10),
          pct(Math.trunc((rs.reduce((a, r) => a + r.leaked, 0) * 1000) / Math.max(1, rs.reduce((a, r) => a + r.spawned, 0)))).padStart(10),
          (rs.reduce((a, r) => a + r.thiefCount, 0) / n).toFixed(1).padStart(10),
          `T${Math.max(...rs.map((r) => r.maxThiefTier))}`.padStart(10),
        ].join(' '),
      );
    }
  }

  // ── 判定 ──
  const none = results.find((r) => r.label.startsWith('不限'));
  const siege = results.find((r) => r.label.includes('siege'));
  const pierce = results.find((r) => r.label.includes('pierce'));
  console.log('\n【假设判定】（载体 = gap，其输出完全由价值大脑决定）');
  if (none && siege && pierce) {
    console.log(`  不限 ${none.avgWave} 波 ｜ 只攻城 ${siege.avgWave} 波 ｜ 只穿刺 ${pierce.avgWave} 波`);
    const siegeWins = siege.avgWave > none.avgWave;
    const pierceLoses = pierce.avgWave <= none.avgWave;
    console.log(
      siegeWins && pierceLoses
        ? '  ⇒ ✅ 方向成立：只攻城活得**更久**、只穿刺**不更久** → 假设（护甲克制失败）得到支持'
        : siegeWins
          ? '  ⇒ ⚠️ 部分成立：只攻城更久，但只穿刺没有更差 → 需再看①的城甲占比'
          : '  ⇒ ❌ 未成立：限制攻城没有带来存活改善 → 假设被否证，倾向"塔数/人口利用率"方向',
    );
  }
  console.log('\n注：① 的"城甲占比"读的是**配置**（waves.json），不是实测出怪；②③ 的经济不受限。');
  console.log('    若①显示漏怪波以城甲为主 **且** ②③方向成立 ⇒ 修 AI 的类型选择，不动数值。');
}

main();