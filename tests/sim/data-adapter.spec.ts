/**
 * 适配层验证：`src/data/*.json` → `SimContent`
 *
 * 重点是**四条易错读数**（契约 §3.2 / §14.10 / schema README §2、§3）：
 *   1. `attackInterval` 是间隔秒（定点），不是频率；
 *   2. 一切数值是定点整数（含金币、木材）；
 *   3. `abilities[].params` 的键名后缀决定单位（…Pct / …Sec / …Cells / …PerCycle）；
 *   4. ★ `auras[].value`（增量千分比）→ `SimContent.AuraDef.value`（乘区千分比）的语义换算。
 *
 * 契约 §14.2 之后还多了 `tech`（乘法科技）与 `map.json`（第 10 张表）。
 *
 * ⚠️ **本文件不硬编码上游容易改动的取值**：`stealWoodRatio` 这类被裁决改过的常量
 * 一律从 `constants.json` 读，再断言适配层**忠实透传**。硬编码常量会在上游调参时反复误报
 * （§14.5 裁决就是这么让本文件红过一次）。
 */
import { describe, expect, it } from 'vitest';
import { loadRealContent, loadRealContentWithReport, toGridAndPaths, toTechTable } from '../../src/balance/data-adapter';
import { mulDiv } from '../../src/sim/fixed';
import { createWorldWithContent } from '../../src/sim/world';
import constantsJson from '../../src/data/constants.json';
import mapJson from '../../src/data/map.json';
import techJson from '../../src/data/tech.json';
import type { BalanceConstants, MapDef, TechDef } from '../../src/data/types.generated';

const { content, report } = loadRealContentWithReport();
const RAW_CONSTANTS = constantsJson as unknown as BalanceConstants;
const RAW_MAP = mapJson as unknown as MapDef;
const RAW_TECH = techJson as unknown as TechDef[];

function collectNonInteger(value: unknown, path: string, out: string[]): void {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) out.push(`${path} = ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectNonInteger(v, `${path}[${i}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectNonInteger(v, `${path}.${k}`, out);
  }
}

describe('data-adapter：规模与形状', () => {
  it('29 单位 / 11 敌人 / 30 波 / 8 科技（契约 §3.1 + §14.2）', () => {
    expect(report.unitCount).toBe(29);
    expect(report.enemyCount).toBe(11);
    expect(report.waveCount).toBe(30);
    expect(report.techCount).toBe(8);
  });

  it('标注为真实数据（不是 M0 合成夹具）', () => {
    expect(content.synthetic).toBe(false);
    expect(content.label).toContain('src/data');
  });

  it('★ attackInterval 是间隔秒，不做倒数换算', () => {
    // units.json: master_thief 1.2/s → 833（round(1000/1.2)）
    expect(content.units['master_thief']?.attackInterval).toBe(833);
    // 若被误当成频率取倒数，这里会变成 1200
    expect(content.units['master_thief']?.attackInterval).not.toBe(1200);
    expect(content.units['pickpocket']?.attackInterval).toBe(1000); // 1.0/s
    expect(content.units['cannon_tower']?.attackInterval).toBe(1667); // 0.6/s
    expect(content.units['archer']?.attackInterval).toBe(1111); // 0.9/s
  });

  it('定点：所有数值字段都是整数（铁律 3）', () => {
    const bad: string[] = [];
    for (const u of Object.values(content.units)) collectNonInteger(u, `unit.${u.id}`, bad);
    for (const e of Object.values(content.enemies)) collectNonInteger(e, `enemy.${e.id}`, bad);
    for (const w of content.waves) collectNonInteger(w, `wave.${w.wave}`, bad);
    for (const t of Object.values(content.tech ?? {})) collectNonInteger(t, `tech.${t.id}`, bad);
    collectNonInteger(content.constants, 'constants', bad);
    expect(bad).toEqual([]);
  });

  it('金币/木材是定点（1000 = 1 金）', () => {
    expect(content.units['pickpocket']?.costGold).toBe(250000);
    expect(content.units['cutpurse']?.costGold).toBe(800000);
    expect(content.units['goldfinger']?.costGold).toBe(25000000);
  });
});

describe('data-adapter：abilities.params 的单位后缀', () => {
  it('…Pct 千分比 → 光环乘区（+25% → 1250）；光环已数组化（§14.10）', () => {
    expect(content.units['shaman']?.auras).toEqual([{ kind: 'attack', value: 1250, radius: 4000 }]);
    expect(content.units['watcher']?.auras).toEqual([{ kind: 'attackSpeed', value: 1300, radius: 4000 }]);
  });

  it('★ slowPct 是「减速率」，AuraDef.slow 要「移速乘区」：−40% → 600', () => {
    expect(content.units['mage_dad']?.auras).toEqual([{ kind: 'slow', value: 600, radius: 5000 }]);
  });

  it('★ 多效果光环不再丢：法师爷爷 allPct + rangePct 两条都在', () => {
    expect(content.units['archmage_grandpa']?.auras).toEqual([
      { kind: 'all', value: 1150, radius: 0 },
      { kind: 'range', value: 1100, radius: 0 },
    ]);
    // 旧实现只能表达 1 条 → 这条断言是 §14.10 的回归防线
    expect(content.units['archmage_grandpa']?.auras?.length).toBe(2);
  });

  it('★ 训导主任的两条光环都在：降抗（量）+ 窃金效率（乘区）', () => {
    expect(content.units['discipline_dean']?.auras).toEqual([
      { kind: 'stealResistDebuff', value: 250, radius: 4000 },
      { kind: 'steal', value: 1200, radius: 4000 },
    ]);
  });

  it('…Cells 格定点 → splash（1.2 格 → 1200）', () => {
    expect(content.units['cannon_tower']?.splash).toBe(1200);
    expect(content.units['howitzer']?.splash).toBe(1800);
    expect(content.units['hellfire']?.splash).toBe(2500);
  });

  it('无后缀 = 纯计数（multishot targets）', () => {
    expect(content.units['archer']?.multiShot).toBe(1);
    expect(content.units['multi_archer']?.multiShot).toBe(2);
    expect(content.units['principal_mom']?.multiShot).toBe(4);
  });

  it('…PerCycle + cooldown → 每秒产木（定点/秒）', () => {
    expect(content.units['sprite_clumsy']?.woodPerSecond).toBe(200); // 1 木 / 5s
    expect(content.units['sprite_common']?.woodPerSecond).toBe(1000); // 1 木 / 1s
    expect(content.units['sprite_advanced']?.woodPerSecond).toBe(2000); // 2 木 / 1s
    expect(content.units['worker']?.woodPerSecond).toBe(100); // 0.5 木 / 5s
  });

  it('slowPct → slowOnHit（移速乘区，方向相反）', () => {
    expect(content.units['ice_beauty']?.slowOnHit).toBe(750); // −25%
    expect(content.units['ice_beauty']?.slowDuration).toBe(2000);
    expect(content.units['mermaid']?.slowOnHit).toBe(650); // −35%
    expect(content.units['mermaid_mother']?.slowOnHit).toBe(500); // −50%
  });

  it('detention 的 stealResistDebuffPct → resistReduce', () => {
    expect(content.units['discipline_dean']?.resistReduce).toBe(250);
  });

  it('stealth 的 stealPct → stealBonus（T3+ 常驻 +25%）', () => {
    expect(content.units['pickpocket']?.stealBonus).toBe(0);
    expect(content.units['cutpurse']?.stealBonus).toBe(0);
    expect(content.units['master_thief']?.stealBonus).toBe(250);
    expect(content.units['goldfinger']?.stealBonus).toBe(250);
  });

  it('relocate_free → canRelocate（只有飞贼）', () => {
    expect(content.units['goldfinger']?.canRelocate).toBe(true);
    expect(content.units['pickpocket']?.canRelocate).toBe(false);
  });

  it('★ stealWoodRatio 忠实透传 constants.json（不硬编码裁决值，见 §14.5）', () => {
    expect(content.units['pickpocket']?.stealWoodRatio).toBe(RAW_CONSTANTS.stealWoodRatio);
    expect(content.units['archer']?.stealWoodRatio).toBe(0);
  });
});

describe('data-adapter：地图是第 10 张表（契约 §14.11）', () => {
  it('grid / vault / buildDepth 逐字段来自 map.json', () => {
    expect(content.grid.width).toBe(RAW_MAP.grid.width);
    expect(content.grid.height).toBe(RAW_MAP.grid.height);
    expect(content.grid.vault).toEqual(RAW_MAP.vault);
    expect(content.constants.buildDepth).toBe(RAW_MAP.buildDepth);
  });

  it('路径顺序是 A, C, B, D（契约 §14.14：N1/N2 打开前 2 条 = A、C）', () => {
    expect(content.paths.map((p) => p.id)).toEqual([0, 1, 2, 3]);
    expect(toGridAndPaths(RAW_MAP).paths.map((p) => p.waypoints[0]?.x)).toEqual([3000, 3000, 45000, 45000]);
    // 前两条都在左侧 → N1/N2 的可建造区集中在左半（更简单，与新手定位一致）
    expect(content.paths[0]?.waypoints[0]?.x).toBe(3000);
    expect(content.paths[1]?.waypoints[0]?.x).toBe(3000);
  });

  it('不再有 map-not-in-data 缺口记录', () => {
    expect(report.warnings.some((w) => w.code === 'map-not-in-data')).toBe(false);
  });

  it('每条路恰好 1 个 ★停顿点（haltIndex 合法）', () => {
    for (const p of content.paths) {
      expect(p.haltIndex).toBeGreaterThanOrEqual(0);
      expect(p.haltIndex).toBeLessThan(p.waypoints.length);
    }
    expect(RAW_MAP.haltPointsPerLane).toBe(1);
  });
});

describe('data-adapter：科技表（契约 §14.2）', () => {
  it('8 条线全部映射，effectMode 逐条一致', () => {
    const table = content.tech;
    expect(table).toBeDefined();
    expect(Object.keys(table ?? {}).sort()).toEqual(RAW_TECH.map((t) => t.id).sort());
    for (const t of RAW_TECH) {
      expect(table?.[t.id]?.effectMode, t.id).toBe(t.effectMode);
      expect(table?.[t.id]?.effectPerLevel, t.id).toBe(t.effectPerLevel);
      expect(table?.[t.id]?.costPerLevel.length, t.id).toBe(t.maxLevel);
    }
  });

  it('★ 乘法线：攻击 ×1.50/级、攻速 ×1.40/级（这是游戏能否通关的关键）', () => {
    expect(content.tech?.['attack']?.effectMode).toBe('mul');
    expect(content.tech?.['attack']?.effectPerLevel).toBe(1500);
    expect(content.tech?.['attack_speed']?.effectMode).toBe('mul');
    expect(content.tech?.['attack_speed']?.effectPerLevel).toBe(1400);
  });

  it('★ 暴击两条保持加法且有上限（不得被一并改成乘法）', () => {
    expect(content.tech?.['steal_crit_rate']?.effectMode).toBe('add');
    expect(content.tech?.['steal_crit_mul']?.effectMode).toBe('add');
    expect(content.constants.critRateCap).toBe(300);
    expect(content.constants.critMulCap).toBe(2750);
  });

  it('toTechTable 是纯函数（两次调用等价）', () => {
    expect(toTechTable(RAW_TECH)).toEqual(toTechTable(RAW_TECH));
  });
});

describe('data-adapter：敌人与波次', () => {
  it('★ killGoldRatio 显式写上（契约 §14.6：击杀奖励必须按当波钱包缩放）', () => {
    for (const e of Object.values(content.enemies)) {
      expect(e.killGoldRatio, e.id).toBe(170);
      expect(e.killWoodRatio, e.id).toBe(0);
    }
    // killGold 仍保留第 1 波基准（对账/兼容用）
    expect(content.enemies['thug']?.killGold).toBe(mulDiv(32000, 170, 1000));
  });

  it('hooks → splitOnDeath / reviveOnce', () => {
    expect(content.enemies['boss_inner_demon']?.splitOnDeath).toBe(2);
    expect(content.enemies['boss_reincarnator']?.reviveOnce).toBe(true);
    expect(content.enemies['thug']?.splitOnDeath).toBe(0);
    expect(content.enemies['thug']?.reviveOnce).toBe(false);
  });

  it('飞升者窃金免疫 + 飞行 + BOSS', () => {
    const a = content.enemies['ascendant'];
    expect(a?.stealResist).toBe(1000);
    expect(a?.flying).toBe(true);
    expect(a?.boss).toBe(true);
  });

  it('BOSS 钱包系数已生效（荒兽 ×12 / 心魔 ×12 / 转生者 ×16 / 飞升者 ×20，契约 §13.5/§14.13）', () => {
    const base = content.enemies['thug']?.baseWallet ?? 0;
    expect(content.enemies['boss_behemoth']?.baseWallet).toBe(base * 12);
    expect(content.enemies['boss_inner_demon']?.baseWallet).toBe(base * 12);
    expect(content.enemies['boss_reincarnator']?.baseWallet).toBe(base * 16);
    expect(content.enemies['ascendant']?.baseWallet).toBe(base * 20);
  });

  it('波次 1 与波次 30 的形状', () => {
    const w1 = content.waves[0];
    expect(w1?.wave).toBe(1);
    expect(w1?.prepTime).toBe(20000);
    expect(w1?.groups).toEqual([{ enemy: 'thug', count: 6, interval: 1200, delay: 0 }]);
    expect(w1?.rewardGold).toBe(50000);
    const w30 = content.waves[29];
    expect(w30?.wave).toBe(30);
    expect(w30?.groups.map((g) => g.enemy)).toEqual(['temple_guard', 'ascendant']);
  });

  it('第 5 波的 path 字段被保留（只走 0/1 路）', () => {
    expect(content.waves[4]?.groups[1]?.path).toEqual([0, 1]);
  });
});

describe('data-adapter：常量与难度', () => {
  it('§5.1 四个基线 + 比值 1.069（一阶参数）', () => {
    const c = content.constants;
    expect(c.baseHp).toBe(60000);
    expect(c.hpIndex).toBe(1283);
    expect(c.baseWallet).toBe(32000);
    expect(c.walletIndex).toBe(1200);
    const rise = mulDiv(c.hpIndex, 1000, c.walletIndex);
    expect(rise).toBeGreaterThanOrEqual(1050);
    expect(rise).toBeLessThanOrEqual(1090);
  });

  it('克制矩阵 5×5 与压缩系数', () => {
    expect(content.constants.counterMatrixStandard).toHaveLength(5);
    expect(content.constants.counterMatrixStandard[0]).toHaveLength(5);
    expect(content.constants.counterMatrixStandard[1]?.[3]).toBe(350); // 穿刺 vs 城甲
    expect(content.constants.compressedFactor).toBe(500);
    expect(content.constants.compressedFloor).toBe(600);
  });

  it('难度行：N2 压缩 2 路 / N3 标准 4 路', () => {
    expect(content.constants.difficulty.N2.compressed).toBe(true);
    expect(content.constants.difficulty.N2.paths).toBe(2);
    expect(content.constants.difficulty.N3.compressed).toBe(false);
    expect(content.constants.difficulty.N3.paths).toBe(4);
    expect(content.constants.difficulty.N4.hpMul).toBe(2400);
    expect(content.constants.difficulty.N5.walletMul).toBe(700);
  });

  it('存档继承常量已透传（§4.4.2）', () => {
    expect(content.constants.techArchiveFreeLevelDivisor).toBe(RAW_CONSTANTS.techArchiveFreeLevelDivisor);
    expect(content.constants.techArchiveCostReductionPct).toBe(RAW_CONSTANTS.techArchiveCostReductionPct);
  });

  it('★ 必须留痕的缺口清单（不许静默推断）', () => {
    const codes = report.warnings.map((w) => w.code);
    for (const need of [
      'attackInterval-no-reciprocal',
      'no-population-spec',
      'unlockwave-disabled',
      'tech-open-from-start',
      'midas-global',
      'enemy-hook-unimplemented',
      'ability-unimplemented',
    ]) {
      expect(codes, `缺少缺口记录 ${need}`).toContain(need);
    }
    // 已被上游修掉的缺口不应再出现（每条都注明是哪一次裁决关掉的）
    for (const gone of [
      'map-not-in-data', // §14.11 新增 map.json
      'killreward-unscaled', // §14.6 killGoldRatio
      'stealWoodRatio-unit', // §14.5 值改为 3
      'tech-slot-by-id', // §16 TechDef.target（适配层已映射）
    ]) {
      expect(codes, `缺口 ${gone} 已被裁决修掉，不该还在`).not.toContain(gone);
    }
  });

  it('★ 契约 §16：TechDef.target 被逐条映射（漏映射会让引擎回退到 id 硬映射表）', () => {
    for (const t of RAW_TECH) {
      expect(content.tech?.[t.id]?.target, `${t.id} 的 target 没被映射`).toBe(t.target);
    }
    // 引擎侧不得再出现 legacy 回退（回退即说明映射漏了）
    const w = createWorldWithContent({ seed: 1, difficultyId: 'N2', relics: {}, techArchive: {} }, content);
    expect(w.tech.unknownTechIds).toEqual([]);
  });
});

describe('data-adapter：纯函数可重复', () => {
  it('两次加载得到等价的单位表与科技表', () => {
    const a = loadRealContent();
    const b = loadRealContent();
    expect(Object.keys(a.units).sort()).toEqual(Object.keys(b.units).sort());
    expect(a.units['master_thief']).toEqual(b.units['master_thief']);
    expect(a.tech).toEqual(b.tech);
  });
});
