/**
 * tests/data/validator.spec.ts —— 校验器自身的行为测试（data-arch 所有）
 *
 * 关键点：不只测「真实数据通过」，还要测「坏数据能被拦住，且报错能定位到
 * 文件名 + 条目索引 + 字段名」。这是 config 门禁可信度的唯一证据。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { DATA_DIR, TABLES, loadTables, validateAllData, type Issue } from '../../tools/validate-data';

// ---------------------------------------------------------------------------
// 真实数据：必须 0 问题
// ---------------------------------------------------------------------------

describe('真实数据（src/data/*.json）', () => {
  const report = validateAllData();

  it('8 张表全部通过 Schema + 引用完整性校验', () => {
    expect(report.issues.map((i) => `${i.file}#${i.index}.${i.field}: ${i.message}`)).toEqual([]);
  });

  it('条目数与接口契约 §3.1 一致（23/11/30/8/9/6/5 + 单对象）', () => {
    for (const t of TABLES) {
      if (t.count === null) continue;
      expect(report.counts[t.file], t.file).toBe(t.count);
    }
  });

  it('执行了引用完整性检查（不是只跑 Schema）', () => {
    const refs = report.checks.filter((c) => c.startsWith('ref:'));
    expect(refs.length).toBeGreaterThanOrEqual(4);
    expect(refs.join('\n')).toContain('waves.groups[].enemy→enemies.id');
    expect(refs.join('\n')).toContain('units.upgradesTo→units.id');
    expect(refs.join('\n')).toContain('units.abilities.id');
    expect(refs.join('\n')).toContain('relics.unlocksUnit→units.id');
  });
});

// ---------------------------------------------------------------------------
// 坏数据：必须被拦住 + 报错必须可定位
// ---------------------------------------------------------------------------

type Tables = ReturnType<typeof loadTables>;

const FILES = [
  'units.json',
  'enemies.json',
  'waves.json',
  'tech.json',
  'relics.json',
  'equipment.json',
  'difficulty.json',
  'constants.json',
  'audio.json',
  'map.json',
] as const;

/** 把 map.json 从临时目录里去掉，用于测「缺表」 */
function validateMissingMap(): Issue[] {
  const tables = clone(loadTables(DATA_DIR));
  const dir = mkdtempSync(join(tmpdir(), 'goldvein-nomap-'));
  tempDirs.push(dir);
  for (const f of FILES) {
    if (f === 'map.json') continue;
    const key = f.replace(/\.json$/, '') as keyof Tables;
    writeFileSync(join(dir, f), JSON.stringify(tables[key], null, 2), 'utf8');
  }
  return validateAllData({ dataDir: dir }).issues;
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** 复制一份真实数据、注入一处人为错误，返回校验结果 */
function validateMutated(mutate: (t: Tables) => void): Issue[] {
  const tables = clone(loadTables(DATA_DIR));
  mutate(tables);
  const dir = mkdtempSync(join(tmpdir(), 'goldvein-validate-'));
  tempDirs.push(dir);
  for (const f of FILES) {
    const key = f.replace(/\.json$/, '') as keyof Tables;
    writeFileSync(join(dir, f), JSON.stringify(tables[key], null, 2), 'utf8');
  }
  return validateAllData({ dataDir: dir }).issues;
}

function issueAt(issues: Issue[], file: string, index: number | null, field: string): Issue | undefined {
  return issues.find((i) => i.file === file && i.index === index && i.field === field);
}

// ---------------------------------------------------------------------------
// ★ 契约 §14.2 / §13.5 / §14.11 新增门禁的反例
// ---------------------------------------------------------------------------

describe('★ 新门禁必须拦住以下错误', () => {
  it('§14.2：把「攻击强化」改回加法（effectMode=add）→ 被拦住', () => {
    const issues = validateMutated((t) => {
      t.tech.find((x: any) => x.id === 'attack').effectMode = 'add';
    });
    const hit = issues.find((i) => i.file === 'tech.json' && i.id === 'attack' && i.field === 'effectMode');
    expect(hit, JSON.stringify(issues, null, 1)).toBeDefined();
    expect(hit!.message).toContain('§14.2');
  });

  it('§14.2：乘法倍率改小（1.50 → 1.30）→ 5 级乘积对不上，被拦住', () => {
    const issues = validateMutated((t) => {
      t.tech.find((x: any) => x.id === 'attack').effectPerLevel = 1300;
    });
    const hit = issues.find((i) => i.file === 'tech.json' && i.id === 'attack' && i.field === 'effectPerLevel');
    expect(hit).toBeDefined();
    expect(hit!.message).toContain('7.59');
  });

  it('§14.2：把 4 条乘法线的倍率压到"线性水平"（攻速 1.08）→ 总验算不达标，被拦住', () => {
    const issues = validateMutated((t) => {
      t.tech.find((x: any) => x.id === 'attack').effectPerLevel = 1100;
      t.tech.find((x: any) => x.id === 'attack_speed').effectPerLevel = 1080;
    });
    const hit = issues.find((i) => i.file === 'tech.json' && i.field === 'effectPerLevel' && i.index === null);
    expect(hit, JSON.stringify(issues, null, 1)).toBeDefined();
    expect(hit!.message).toContain('1373');
  });

  it('§13.5：把飞升者的钱包系数退回 1.0 → BOSS 波经济断崖门禁被拦住', () => {
    const issues = validateMutated((t) => {
      t.enemies.find((e: any) => e.id === 'ascendant').baseWallet = t.constants.baseWallet;
    });
    const hit = issues.find((i) => i.file === 'waves.json' && i.id === 'wave 27');
    expect(hit, JSON.stringify(issues, null, 1)).toBeDefined();
    expect(hit!.message).toContain('§13.5');
  });

  it('§14.11：缺 map.json → 报缺表', () => {
    const issues = validateMissingMap();
    expect(issues.some((i) => i.file === 'map.json' && i.message.includes('新增第 10 张表'))).toBe(true);
  });

  it('§14.11：pathLengthCells 与 waypoints 不符 → 被拦住', () => {
    const issues = validateMutated((t) => {
      t.map.paths[0].pathLengthCells = 99000;
    });
    const hit = issues.find((i) => i.file === 'map.json' && i.field === 'pathLengthCells');
    expect(hit, JSON.stringify(issues, null, 1)).toBeDefined();
    expect(hit!.message).toContain('实测长度');
  });

  it('§14.11：路径 id 不等于下标 → 被拦住', () => {
    const issues = validateMutated((t) => {
      t.map.paths[2].id = 5;
    });
    expect(issues.some((i) => i.file === 'map.json' && i.field === 'id')).toBe(true);
  });

  it('§14.11：waypoint 写成斜线（dx 与 dy 都非 0）→ 被拦住', () => {
    const issues = validateMutated((t) => {
      t.map.paths[0].waypoints[1] = { x: 4000, y: 11000 };
    });
    expect(issues.some((i) => i.file === 'map.json' && i.message.includes('轴对齐'))).toBe(true);
  });

  it('§14.11：★停顿点落进宝库 → 被拦住', () => {
    const issues = validateMutated((t) => {
      // 把停顿点指到末点（宝库内）
      t.map.paths[0].haltIndex = t.map.paths[0].waypoints.length - 1;
    });
    expect(issues.some((i) => i.file === 'map.json' && i.field === 'haltIndex' && i.message.includes('宝库'))).toBe(true);
  });

  it('§14.11：openLanes 与 difficulty.openLanes 不一致 → 被拦住', () => {
    const issues = validateMutated((t) => {
      t.map.openLanes.N3 = [0, 1];
    });
    expect(issues.some((i) => i.file === 'map.json' && i.field === 'openLanes.N3')).toBe(true);
  });

  it('§14.11：波次引用了窄路难度下不存在的路径索引 → 被拦住（sim 会静默回绕）', () => {
    const issues = validateMutated((t) => {
      t.waves[4].groups[1].path = [2, 3];
    });
    const hit = issues.find((i) => i.file === 'waves.json' && i.field.startsWith('groups[1].path'));
    expect(hit, JSON.stringify(issues, null, 1)).toBeDefined();
    expect(hit!.message).toContain('回绕');
  });

  it('§14.11：buildDepth 与 constants.map 不一致 → 被拦住', () => {
    const issues = validateMutated((t) => {
      t.map.buildDepth = 3;
    });
    expect(issues.some((i) => i.file === 'map.json' && i.field === 'buildDepth')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ★ 契约 §15.13 / §14.20 / §14.12 / §15.4 新门禁的**负对照**
//    （铁律 8：若门禁是空的，下面这些用例会绿 —— 那就说明门禁没测到东西）
// ---------------------------------------------------------------------------

describe('★ §15.13/§14.20/§15.4 新门禁的负对照', () => {
  it('§15.13：把某级造价减 1 金 → 8 条总额对不上，被拦住', () => {
    const issues = validateMutated((t) => {
      t.tech[0].costPerLevel[0].gold -= 1000; // 定点：1 金
    });
    const hit = issues.find((i) => i.file === 'tech.json' && i.field === 'costPerLevel' && i.index === null);
    expect(hit, JSON.stringify(issues, null, 1)).toBeDefined();
    expect(hit!.message).toContain('576000');
  });

  it('§15.13：把总额整体退回旧的 313,200 → 被拦住（证明门禁锚在 576,000 而不是任意数）', () => {
    const issues = validateMutated((t) => {
      for (const line of t.tech) {
        for (const c of line.costPerLevel) c.gold = Math.round(c.gold * (313200 / 576000));
      }
    });
    expect(issues.some((i) => i.file === 'tech.json' && i.message.includes('576000'))).toBe(true);
  });

  it('§15.13：把总额抬到上一版误算的 677,000 → 同样被拦住（两个方向都锚得住）', () => {
    const issues = validateMutated((t) => {
      t.tech[0].costPerLevel[4].gold += 101000 * 1000; // +101,000 金
    });
    expect(issues.some((i) => i.file === 'tech.json' && i.message.includes('576000'))).toBe(true);
  });

  it('§14.20：把某条线的 target 改成别的槽位 → 被拦住', () => {
    const issues = validateMutated((t) => {
      t.tech.find((x: any) => x.id === 'steal_efficiency').target = 'attack';
    });
    const hit = issues.find((i) => i.file === 'tech.json' && i.id === 'steal_efficiency' && i.field === 'target');
    expect(hit, JSON.stringify(issues, null, 1)).toBeDefined();
    expect(hit!.message).toContain('§14.20');
  });

  it('§14.20：删掉 target 字段 → Schema 必填校验拦住', () => {
    const issues = validateMutated((t) => {
      delete t.tech[0].target;
    });
    const hit = issues.find(
      (i) => i.file === 'tech.json' && i.field === 'target' && i.message.includes('缺少必填字段'),
    );
    expect(hit, JSON.stringify(issues, null, 1)).toBeDefined();
  });

  it('§14.12：把科技支出目标改回 28% → 被拦住', () => {
    const issues = validateMutated((t) => {
      t.constants.economyTargets.spendRatios.tech = 280;
      t.constants.economyTargets.spendRatios.tower = 550; // 保持总和 1000，隔离出「必须 350」这一条
    });
    expect(issues.some((i) => i.file === 'constants.json' && i.field === 'economyTargets.spendRatios.tech')).toBe(true);
  });

  it('§15.4：把可通关性硬界改成 1200（1.2）→ 被拦住', () => {
    const issues = validateMutated((t) => {
      t.constants.acceptanceTargets.solvabilityMax = 1200;
    });
    expect(issues.some((i) => i.file === 'constants.json' && i.field === 'acceptanceTargets.solvabilityMax')).toBe(true);
  });

  it('§15.4：把舒适带设成 min > max → 被拦住', () => {
    const issues = validateMutated((t) => {
      t.constants.acceptanceTargets.solvabilityComfortMin = 700;
      t.constants.acceptanceTargets.solvabilityComfortMax = 600;
    });
    expect(issues.some((i) => i.file === 'constants.json' && i.field === 'acceptanceTargets')).toBe(true);
  });

  it('§15.4：把已删除的塔数目标加回来 → 被拦住', () => {
    const issues = validateMutated((t) => {
      t.constants.acceptanceTargets.towersAtWave10Min = 6;
    });
    const hit = issues.find((i) => i.file === 'constants.json' && i.field === 'acceptanceTargets.towersAtWave10Min');
    expect(hit, JSON.stringify(issues, null, 1)).toBeDefined();
    expect(hit!.message).toContain('§15.4');
  });
});

describe('校验器必须拦住并精确定位以下错误', () => {
  it('waves.json 引用不存在的敌人 id → 报出 文件+波次+字段+坏 id', () => {
    const issues = validateMutated((t) => {
      t.waves[3].groups[0].enemy = 'ghost_x';
    });
    const hit = issueAt(issues, 'waves.json', 3, 'groups[0].enemy');
    expect(hit, JSON.stringify(issues, null, 1)).toBeDefined();
    expect(hit!.id).toBe('wave 4');
    expect(hit!.message).toContain('ghost_x');
    expect(hit!.message).toContain('不存在');
  });

  it('units.json 缺少必填字段 attackInterval → 报出字段名', () => {
    const issues = validateMutated((t) => {
      delete t.units[2].attackInterval;
    });
    const hit = issueAt(issues, 'units.json', 2, 'attackInterval');
    expect(hit).toBeDefined();
    expect(hit!.message).toContain('attackInterval');
  });

  it('units.json 的 attackInterval 写成频率（1.2/s → 1200）时数值范围仍合法，但会被「唯一频率映射」测试拦住（此处只验证类型/范围门禁）', () => {
    const issues = validateMutated((t) => {
      t.units[0].attackInterval = 0;
    });
    const hit = issueAt(issues, 'units.json', 0, 'attackInterval');
    expect(hit).toBeDefined();
    expect(hit!.message).toContain('不得小于');
  });

  it('units.json 的 upgradesTo 指向不存在的 unit id', () => {
    const issues = validateMutated((t) => {
      t.units[4].upgradesTo = ['no_such_unit'];
    });
    const hit = issueAt(issues, 'units.json', 4, 'upgradesTo[0]');
    expect(hit).toBeDefined();
    expect(hit!.message).toContain('no_such_unit');
  });

  it('units.json 的 critRate 超过 1000 千分比上限', () => {
    const issues = validateMutated((t) => {
      t.units[0].critRate = 1500;
    });
    const hit = issueAt(issues, 'units.json', 0, 'critRate');
    expect(hit).toBeDefined();
    expect(hit!.message).toContain('不得大于 1000');
  });

  it('出现浮点数（违反铁律 3 定点数）→ 类型必须拦住', () => {
    const issues = validateMutated((t) => {
      t.units[0].attack = 8000.5;
    });
    const hit = issueAt(issues, 'units.json', 0, 'attack');
    expect(hit).toBeDefined();
    expect(hit!.message).toContain('integer');
  });

  it('attackType 取值不在 5 个枚举内', () => {
    const issues = validateMutated((t) => {
      t.units[9].attackType = 'holy';
    });
    const hit = issueAt(issues, 'units.json', 9, 'attackType');
    expect(hit).toBeDefined();
    expect(hit!.message).toContain('normal');
    expect(hit!.message).toContain('chaos');
  });

  it('constants.json 的 levelMul 不是 5 个元素', () => {
    const issues = validateMutated((t) => {
      t.constants.levelMul = [1000, 1350, 1850, 2600];
    });
    const hit = issueAt(issues, 'constants.json', null, 'levelMul');
    expect(hit).toBeDefined();
    expect(hit!.message).toContain('数组长度');
  });

  it('constants.json 的 counterMatrixStandard 不是 5×5', () => {
    const issues = validateMutated((t) => {
      t.constants.counterMatrixStandard[2] = [1250, 750, 1500, 350];
    });
    expect(issues.some((i) => i.file === 'constants.json' && i.field === 'counterMatrixStandard')).toBe(true);
  });

  it('waves.json 的 hint.recommendArmor 与本波敌人护甲不符', () => {
    const issues = validateMutated((t) => {
      t.waves[0].hint.recommendArmor = 'divine';
    });
    const hit = issueAt(issues, 'waves.json', 0, 'hint.recommendArmor');
    expect(hit).toBeDefined();
    expect(hit!.message).toContain('divine');
  });

  it('waves.json 缺少某波（波次号不连续）', () => {
    const issues = validateMutated((t) => {
      t.waves = t.waves.filter((w: { wave: number }) => w.wave !== 7);
    });
    expect(issues.some((i) => i.file === 'waves.json' && i.message.includes('缺少第 7 波'))).toBe(true);
  });

  it('★ 非 BOSS 波敌人总数倒挂（第 10 波比第 9 波少）→ 被拦住并指出前后两波', () => {
    const issues = validateMutated((t) => {
      const w10 = t.waves.find((w: { wave: number }) => w.wave === 10);
      w10.groups = [{ enemy: 'thug', count: 1, interval: 1000, delay: 0 }];
    });
    const hit = issues.find((i) => i.file === 'waves.json' && i.id === 'wave 10' && i.field === 'groups');
    expect(hit, JSON.stringify(issues, null, 1)).toBeDefined();
    expect(hit!.message).toContain('单调不减');
    expect(hit!.message).toContain('第 9 波');
    expect(hit!.message).toContain('第 10 波');
  });

  it('★ BOSS 波不参与数量序列：真实数据里第 27 波只有 1 只（远低于第 26 波）也不得报错', () => {
    const issues = validateMutated(() => {
      /* 不改任何东西 */
    });
    expect(issues.filter((i) => i.file === 'waves.json')).toEqual([]);
  });

  it('★ 把第 27 波的 BOSS 换成普通敌人后，它变成普通波 → 数量倒挂必须被拦住', () => {
    const issues = validateMutated((t) => {
      const w27 = t.waves.find((w: { wave: number }) => w.wave === 27);
      w27.groups = [{ enemy: 'thug', count: 1, interval: 1000, delay: 0 }];
    });
    expect(
      issues.some((i) => i.file === 'waves.json' && i.message.includes('单调不减')),
      JSON.stringify(issues, null, 1),
    ).toBe(true);
  });

  it('tech.json 的 costPerLevel 长度与 maxLevel 不一致', () => {
    const issues = validateMutated((t) => {
      t.tech[0].costPerLevel = t.tech[0].costPerLevel.slice(0, 4);
    });
    const hit = issueAt(issues, 'tech.json', 0, 'costPerLevel');
    expect(hit).toBeDefined();
    expect(hit!.message).toContain('maxLevel');
  });

  it('relics.json 的解锁圣物指向不存在的 unit', () => {
    const issues = validateMutated((t) => {
      t.relics[5].unlocksUnit = 'ghost_knight';
    });
    const hit = issueAt(issues, 'relics.json', 5, 'unlocksUnit');
    expect(hit).toBeDefined();
    expect(hit!.message).toContain('ghost_knight');
  });

  it('difficulty.json 的 crystalMul 与 constants 不一致', () => {
    const issues = validateMutated((t) => {
      t.difficulty[3].crystalMul = 999;
    });
    const hit = issueAt(issues, 'difficulty.json', 3, 'crystalMul');
    expect(hit).toBeDefined();
    expect(hit!.message).toContain('difficultyCrystalMul');
  });

  it('units.json 出现未知字段（Schema 为 additionalProperties:false）', () => {
    const issues = validateMutated((t) => {
      t.units[1].hp = 1000;
    });
    expect(issues.some((i) => i.file === 'units.json' && i.message.includes('不允许的字段'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Schema 文件自身健全性
// ---------------------------------------------------------------------------

describe('Schema 文件', () => {
  it('8 张表的 Schema 都存在且为合法 JSON，且钉死条目数靠契约核对', () => {
    for (const t of TABLES) {
      const raw = readFileSync(join(DATA_DIR, 'schema', t.schema), 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed['title'], t.schema).toBe(t.name);
      expect(parsed['additionalProperties'], t.schema).toBe(false);
    }
  });
});
