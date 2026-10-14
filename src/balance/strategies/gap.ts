/**
 * ★★ **缺口驱动（反馈式）** —— 主策划裁决 1 的**主方案**（不是兜底）
 *
 * ## 为什么改成反馈式
 *
 * 预测式连败两次：
 * 1. 第一版用解析需求 DPS 当门槛（假设 100% 命中与全程开火）→ 第 5 波 `dpsNeed=3.4%`
 *    而实测漏怪 75%，AI 在"看着安全"时把 DPS 饿死。
 * 2. 第二版想用"漏怪起始点的 DPS 比"标定门槛 → **4 条策略极差 106.4pt**，
 *    且同一策略在两条读取路径下从 151.8% 跳到 222.6%（采样约定敏感）。
 *
 * ⇒ 主策划裁决：**"漏怪不能被任何我方可算的阵容指标稳定预测"已被证明，那就别算。**
 *
 * ## 现在的分工（★ 关键）
 *
 * | 维度 | 用什么 | 为什么 |
 * |---|---|---|
 * | **数量**：要不要加输出 | **上一波实测漏怪数**（反馈） | 定量预测已证明不可靠；实测无模型 |
 * | **数量**：要不要加窃金塔 | **实测覆盖率**（反馈） | 覆盖率本来就是实测值 |
 * | **类型**：买哪种塔 | **波次预告**（`nextWave` 的护甲构成，前瞻） | 定性信息不需要模型；避免 Boss 波前无准备 |
 *
 * 一句话：**类型用前瞻、数量用反馈。** 代价是慢一波（单波 35–50s），
 * 而这恰好就是真人玩家的做法 —— 看到漏怪才反应。
 *
 * ## 可审计
 *
 * 每波记录一条 `GapTrace`（**上一波漏怪数** → 决策），由 `trace()` 暴露。
 */
import type { Command } from '../../sim/commands';
import { FIXED_SCALE, truncDiv } from '../../sim/fixed';
import type { AttackType, UnitDef } from '../../sim/content';
import type { Cell } from '../../sim/types';
import { buildPlacement, occupiedKeys, type PlacementMode, type PlacementModel } from './placement';
import { laneCountOf, rootUnitIds, salaryCommand, unitOf } from './common';
import { createValueBrain } from './actions';
import type { Strategy, StrategyInput } from './types';
import { COVERAGE_TARGET_PERMILLE } from '../acceptance';

/** 目标覆盖率（§5.4 的 [650, 800] 取中值）。 */
// ★ 目标覆盖率从 constants.json 的 stealCoverageMin/Max 推中值（曾经硬编码 725）
export { COVERAGE_TARGET_PERMILLE as COVERAGE_TARGET } from '../acceptance';
/** 攒钱容忍倍数（千分比）：升级造价 ≤ 金币 × 该倍数 就停下来攒。 */
const SAVE_MULT = 4000;
/** 攒钱耐心上限（tick）：为同一档升级攒超过这个时长就放弃。 */
const SAVE_PATIENCE_TICKS = 25 * 60;

export interface GapTrace {
  wave: number;
  /** **上一波实测漏怪数**（反馈信号，不是预测） */
  lastLeaks: number;
  /** 上一整波的窃金覆盖率（千分比，实测） */
  coverage: number;
  /** ★ 距上次**真的做了经济动作**已过几波（aging 计数器） */
  wavesSinceEconomy: number;
  /** ★ 距上次**真的做了生存动作**已过几波（aging 计数器） */
  wavesSinceSurvival: number;
  /** 下一波的预告护甲构成（前瞻，决定"买什么类型"） */
  nextWaveArmor: string;
  decision: string;
}

export interface GapStrategy extends Strategy {
  trace(): GapTrace[];
}

/**
 * ★★ **aging 上限**（主策划裁决：用记忆解反馈闩锁，不用配额）
 *
 * 含义：**在漏怪持续的前提下，经济最多可以被连续饿死几波。**
 *
 * ## 为什么会闩锁（实测）
 *
 * 纯反馈版从第 8 波起**每一波都漏怪** → 反馈永远指向"补输出" → 经济被永久饿死
 * （覆盖率 9.8%、只剩 2 座窃金塔）。这是控制论里"纯比例控制器无积分项"的经典问题：
 * 误差信号持续存在时，控制器会**一直朝同一方向出力**，永远不回头。
 *
 * ## 为什么 aging 能解、而配额不能
 *
 * - **配额**（每 N 波强行投一次经济）是 aging 的**粗糙特例** —— 经济已经够时它也会白白浪费一次；
 *   而 aging 只在"经济**确实**被饿着（覆盖率仍低于目标）"时才出手。
 * - aging 用的全是**已有信号 + 一个计数**：漏怪数、覆盖率、以及"距上次满足已过几波"。
 *   **没有引入任何新的、未经验证的度量**（定量预测已连败两次）。
 *
 * ## 可解释性（主策划的硬要求）
 *
 * trace 同时打出两个计数器，所以任何一波都能回答"为什么选经济而不是输出"：
 * 例如「生存信号持续、但经济已被饿 2 波（= aging 上限）→ 这一波投经济」。
 *
 * ## 取值来自**扫描**（不是猜的）
 *
 * `src/balance/aging-scan.ts` 扫 `{1,2,3,4,5}`（N2，每值 3 局），**两个指标都报**：
 *
 * | agingMax | 窃金覆盖 | 均到波 | 窃金塔数 | 漏怪率 |
 * |---|---|---|---|---|
 * | **1** | **28.2%** | **12** | 8.0 | 26.3% |
 * | 2 | 17.1% | 11 | 4.0 | 26.3% |
 * | 3 | 17.2% | 11 | 3.0 | 26.3% |
 * | 4 | 17.2% | 11 | 2.0 | 26.3% |
 * | 5 | 11.5% | 12 | 3.0 | 23.2% |
 *
 * ⇒ **`1` 在覆盖率上明显最好（28.2% vs 11.5–17.2%），存活与最好值持平（12 波）**
 * ⇒ 故取 `1`。注意：**纯反馈版是 9.8%**，aging 把它提到 28.2%（2.9×），且存活没有变差。
 */
export const DEFAULT_AGING_MAX = 1;

export function createGapDriven(opts: { placement?: PlacementMode; agingMax?: number; allowedAttackTypes?: readonly AttackType[] } = {}): GapStrategy {
  const agingMax = opts.agingMax ?? DEFAULT_AGING_MAX;
  let model: PlacementModel | null = null;
  let roots: Set<string> | null = null;
  const traces: GapTrace[] = [];
  const brain = createValueBrain({ allowBlock: true, allowTech: true, buildSaturation: true, placement: opts.placement, allowedAttackTypes: opts.allowedAttackTypes });

  let lastLeaks = 0;
  let liveLeaks = 0;
  let coverageOfLastWave = 0;
  let liveCoverage = 0;
  let watchingWave = -1;
  let savingTicks = 0;
  /** ★ aging 计数器：距上次真的做了该类动作已过几波 */
  let wavesSinceEconomy = 0;
  let wavesSinceSurvival = 0;
  /** 上次推进 aging 计数器时的波号（每波只推一次） */
  let lastCountedWave = -1;

  function ensure(input: StrategyInput): void {
    if (model) return;
    const lanes = laneCountOf(input.content, input.difficultyId);
    model = buildPlacement(input.content, lanes, opts.placement ?? 'uniform');
    roots = rootUnitIds(input.content);
  }

  function pickCell(input: StrategyInput, lane: number): Cell | null {
    const m = model as PlacementModel;
    const snap = input.snap;
    const cells: Cell[] = snap.towers.map((t) => t.cell);
    const occupied = occupiedKeys(snap.towers, input.content.grid.width);
    const counts = new Array<number>(m.laneCount).fill(0);
    for (const c of cells) {
      const l = m.laneOf(c);
      if (l >= 0 && l < m.laneCount) counts[l] = (counts[l] as number) + 1;
    }
    let best = 0;
    for (let i = 1; i < counts.length; i++) if ((counts[i] as number) < (counts[best] as number)) best = i;
    return m.pick(occupied, cells, lane >= 0 ? lane : best);
  }

  /** 经济分支：优先升级窃金塔（含攒钱），否则铺一座新的。 */
  function economyAction(input: StrategyInput, allowSave: boolean): { cmd: Command | null; why: string } {
    const snap = input.snap;
    let bestTid = -1;
    let bestTier = -1;
    let bestCost = 0;
    for (const t of snap.towers) {
      const cur = unitOf(input.content, t.unitId);
      if (!cur || !cur.isSteal || !cur.upgradeTo) continue;
      const next = unitOf(input.content, cur.upgradeTo);
      if (!next) continue;
      if (next.costGold > snap.gold || next.costWood > snap.wood) {
        if (
          allowSave &&
          bestTid < 0 &&
          next.costGold <= truncDiv(snap.gold * SAVE_MULT, FIXED_SCALE) &&
          next.costWood <= snap.wood
        ) {
          bestTid = t.id;
          bestTier = next.tier;
          bestCost = next.costGold;
        }
        continue;
      }
      if (next.tier > bestTier) {
        bestTid = t.id;
        bestTier = next.tier;
        bestCost = next.costGold;
      }
    }
    if (bestTid >= 0) {
      if (bestCost > snap.gold) {
        savingTicks++;
        if (savingTicks <= SAVE_PATIENCE_TICKS) {
          return { cmd: null, why: `攒钱升 T${bestTier}（需 ${(bestCost / 1000).toFixed(0)} 金，已等 ${(savingTicks / 60).toFixed(0)}s）` };
        }
      } else {
        savingTicks = 0;
        return { cmd: { type: 'upgrade', towerId: bestTid }, why: `升窃金塔→T${bestTier}` };
      }
    }
    if (snap.population < snap.populationCap) {
      let cheapest: UnitDef | null = null;
      for (const id of roots as Set<string>) {
        const def = unitOf(input.content, id);
        if (!def || !def.isSteal) continue;
        if (def.costGold > snap.gold) continue;
        if (!cheapest || def.costGold < cheapest.costGold) cheapest = def;
      }
      if (cheapest) {
        const cell = pickCell(input, -1);
        if (cell) {
          savingTicks = 0;
          return { cmd: { type: 'build', unitId: cheapest.id, cell }, why: `铺新窃金塔 ${cheapest.id}` };
        }
      }
    }
    return { cmd: null, why: '经济分支无可用动作' };
  }

  /**
   * 生存分支：按价值/金币买**能真正加 DPS** 的东西
   * （`valueOf` 内部用 `nextWave` 的护甲构成 ⇒ 类型是前瞻的）。
   *
   * ⚠️ 必须过滤掉 `attack <= 0` 的动作：产木单位（工人/小精灵）的价值来自木材，
   * 在漏怪时买它等于**花掉全部现金换零 DPS**。实测 trace 抓到过这个缺陷
   * （第 3/8/9 波在"补输出"分支买了 `worker`，`attack = 0`）。
   * 若一个能加 DPS 的动作都买不起 → **什么都不做（攒钱）**，这比乱花好。
   */
  function survivalAction(input: StrategyInput): { cmd: Command | null; why: string } {
    for (const a of brain.candidates(input)) {
      if (a.kind === 'research') continue; // 科技是慢变量，生存分支不靠它
      const def = unitOf(input.content, a.unitId);
      if (!def || def.attack <= 0) continue; // ★ 零 DPS 的动作一律不买
      const cmd = brain.commandFor(input, a);
      if (cmd) return { cmd, why: `补输出（按下一波护甲构成选型）：${a.kind} ${a.unitId}` };
    }
    return { cmd: null, why: '生存分支：没有任何"能加 DPS"的动作买得起 → 攒钱' };
  }

  return {
    id: 'gap',
    label: '缺口驱动·反馈式（漏怪驱动 + 覆盖率驱动 + 波次预告选型）',
    description:
      '数量用反馈：上一波漏怪 → 转输出；实测覆盖率低于 725‰ → 加窃金塔。' +
      '类型用前瞻：按下一波护甲构成挑塔。不预测 DPS 需求（已证明预测不可靠）。',
    decide(input: StrategyInput): Command[] {
      ensure(input);
      const snap = input.snap;
      if (snap.status !== 'running') return [];
      const skills = salaryCommand(snap);

      // —— 波切换：把上一波的**实测**结果固化为反馈信号 ——
      if (snap.wave !== watchingWave) {
        if (watchingWave >= 0) {
          lastLeaks = liveLeaks;
          coverageOfLastWave = liveCoverage;
        }
        watchingWave = snap.wave;
        liveLeaks = 0;
        liveCoverage = 0;
      }
      const seenLeaks = snap.currentWaveStats.leaks;
      if (seenLeaks > liveLeaks) liveLeaks = seenLeaks;
      const seenCov = snap.currentWaveStats.stealCoverage;
      if (seenCov > liveCoverage) liveCoverage = seenCov;

      const coverage = coverageOfLastWave;
      const nextArmor =
        snap.nextWave && snap.nextWave.groups.length > 0 ? String(snap.nextWave.groups[0]?.armorType ?? '—') : '—';

      // ★ aging 计数器在**波切换那一刻**推进（每波只推一次）
      if (snap.wave !== lastCountedWave) {
        lastCountedWave = snap.wave;
        wavesSinceEconomy++;
        wavesSinceSurvival++;
      }

      const survivalUnmet = lastLeaks > 0;
      const economyUnmet = coverage < COVERAGE_TARGET_PERMILLE;

      let branch: string;
      /**
       * ★★ **aging 决策规则**（可解释，全部量都是已有的）
       *
       * ```
       * 生存信号存在 且 经济还没被饿够 agingMax 波 → 补输出
       * 否则（经济被饿了 ≥ agingMax 波，或生存信号不存在） → 补经济（若仍不足）
       * 两个信号都不存在 → 价值兜底
       * ```
       * `agingMax` 的含义是**在漏怪持续时，经济最多被连续饿死几波** —— 它是闩锁的解锁上限。
       */
      let branchKind: 'survival' | 'economy' | 'value';
      if (survivalUnmet && wavesSinceEconomy < agingMax) {
        branchKind = 'survival';
        branch = `上波漏 ${lastLeaks} 只→补输出（经济已被饿 ${wavesSinceEconomy} 波 < aging 上限 ${agingMax}）`;
      } else if (economyUnmet) {
        branchKind = 'economy';
        branch = survivalUnmet
          ? `★ aging 解锁：漏怪仍在（${lastLeaks} 只），但经济已被饿 ${wavesSinceEconomy} 波 ≥ 上限 ${agingMax} → 这一波投经济（覆盖 ${(coverage / 10).toFixed(1)}%<${COVERAGE_TARGET_PERMILLE / 10}%）`
          : `无漏怪但覆盖 ${(coverage / 10).toFixed(1)}%<${COVERAGE_TARGET_PERMILLE / 10}%→补经济`;
      } else if (survivalUnmet) {
        branchKind = 'survival';
        branch = `上波漏 ${lastLeaks} 只（经济已达标）→补输出`;
      } else {
        branchKind = 'value';
        branch = '双缺口=0→价值兜底';
      }

      // 允许为升级攒钱的前提：**没有生存压力**（否则不该憋钱）
      const out = branchKind === 'economy' ? economyAction(input, !survivalUnmet) : survivalAction(input);
      // ★ 计数器只在**真的发出了该类动作**时才清零（"距上次被满足"才是 aging 的正确定义）
      if (out.cmd) {
        if (branchKind === 'economy') wavesSinceEconomy = 0;
        else if (branchKind === 'survival') wavesSinceSurvival = 0;
      }

      if (traces.length < 40 && (traces.length === 0 || (traces[traces.length - 1] as GapTrace).wave !== snap.wave)) {
        traces.push({
          wave: snap.wave,
          lastLeaks,
          coverage,
          wavesSinceEconomy,
          wavesSinceSurvival,
          nextWaveArmor: nextArmor,
          decision: `${branch} ｜ ${out.why}`,
        });
      }

      return out.cmd ? [...skills, out.cmd] : skills;
    },
    trace(): GapTrace[] {
      return traces;
    },
  };
}
