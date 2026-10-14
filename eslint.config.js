// ESLint 9 flat config（owner: engine-dev）
//
// ## 已知限制：本仓库当前无法对 TypeScript 做真正的 lint
//
// `package.json` 里没有任何 TypeScript parser（没有 typescript-eslint，
// 也没有 @typescript-eslint/parser），而 ESLint 9 默认的 espree 解析不了类型标注。
// 因此现在只能：
//   - 对 .js / .mjs / .cjs 施加 ESLint 核心规则（本文件自身会被检查）；
//   - 跳过 .ts（否则 espree 会整片报解析错误）。
//
// 这个文件写成「自动降级 + 自动升级」：一旦 devDependencies 里出现
// typescript-eslint，下面那段动态 import 就会成功，TS 文件立刻开始被同一套
// 规则检查，**不需要再改本文件**。已在汇报的阻塞段向主策划申请该依赖。
//
// 注意：本注释里刻意不写出含通配符斜杠的 glob 字面量 —— 那样的字符序列
// 会提前闭合块注释（这正是本文件此前 `node --check` 失败的原因）。
import { existsSync } from 'node:fs';

const TS_GLOB = ['**/*.ts'];

const IGNORES = [
  'dist/**',
  'node_modules/**',
  'coverage/**',
  'public/assets/**',
  // 由 pnpm gen-types 生成，任何人不得手改（契约 §3.4）
  'src/data/types.generated.ts',
  'tools/bench/out/**',
];

/** 全局铁律（对所有文件生效）。 */
const GLOBAL_IRON_LAWS = [
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message: '铁律 4：禁止 Math.random()，必须用可播种 RNG（src/sim/rng.ts 的 createRng）。',
  },
];

/**
 * 仅对 `src/sim/**` 生效的铁律。
 *
 * ⚠️ 2026-10-13 主策划修正：这两条原先混在全局 `IRON_LAW_SELECTORS` 里，
 * 导致 `src/render/**` 与 `tools/bench/**`（它们**本来就该** import Phaser 和 src/data）
 * 被误报为违反铁律 1 / 契约 §4.2。
 *
 * 这个假阳性在 `pnpm lint` 只覆盖 `.js` 时完全不可见——直到装上 TS parser 才暴露。
 * 教训：一条"不可见"的质量门禁等于没有门禁。
 */
const SIM_ONLY_IRON_LAWS = [
  {
    selector: "ImportDeclaration[source.value=/^phaser/]",
    message: '铁律 1：src/sim 不得 import Phaser（模拟层必须能在 Node 裸跑）。',
  },
  {
    selector: 'ImportDeclaration[source.value=/data\\//]',
    message: '契约 §4.2：M0 阶段 src/sim 不得 import src/data。',
  },
];

const CORE_RULES = {
  // 正确性
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-constant-condition': ['warn', { checkLoops: false }],
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-loss-of-precision': 'error',
  'no-misleading-character-class': 'error',
  'no-useless-backreference': 'error',
  'no-async-promise-executor': 'error',
  'no-template-curly-in-string': 'warn',
  'valid-typeof': ['error', { requireStringLiterals: true }],
  'use-isnan': 'error',
  'no-sparse-arrays': 'error',
  // 安全
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-with': 'error',
  'no-delete-var': 'error',
  'no-global-assign': 'error',
  'no-throw-literal': 'error',
  // 风格一致性
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-var': 'error',
  'prefer-const': 'warn',
  'no-console': 'off',
  // 项目铁律
  'no-restricted-syntax': ['error', ...GLOBAL_IRON_LAWS],
  // 交给 tsc（有类型信息时更准）
  'no-undef': 'off',
  'no-unused-vars': 'off',
};

/** 探测 TypeScript parser 是否安装（静态路径检查，避免无谓的 import 失败）。 */
function resolveTsParser() {
  for (const name of ['@typescript-eslint/parser', 'typescript-eslint']) {
    if (existsSync(new URL(`./node_modules/${name}/package.json`, import.meta.url))) return name;
  }
  return null;
}

const tsParserName = resolveTsParser();

if (tsParserName === null) {
  IGNORES.push(...TS_GLOB);
}

/** @type {import('eslint').Linter.Config[]} */
const configs = [
  { ignores: IGNORES },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { console: 'readonly', process: 'readonly' },
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: CORE_RULES,
  },
];

if (tsParserName !== null) {
  const mod = await import(tsParserName);
  const parser = mod.default ?? mod;
  configs.push({
    files: TS_GLOB,
    languageOptions: {
      parser,
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { project: false },
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: CORE_RULES,
  });
} else {
  console.warn(
    '[eslint] 未检测到 typescript-eslint / @typescript-eslint/parser：本次 lint 只覆盖 .js 文件。' +
      ' TypeScript 的类型与语法问题由 `pnpm typecheck`（tsc --noEmit）负责。',
  );
}

// 模拟层专属铁律。必须放在 TS 配置之后 push —— flat config 是"后者覆盖前者"，
// 若放进初始数组会被 TS 配置的 no-restricted-syntax 整条覆盖掉。
// 这里同时带上 GLOBAL_IRON_LAWS，因为覆盖是整条规则而非合并选择器。
configs.push({
  files: ['src/sim/**/*.ts'],
  rules: {
    'no-restricted-syntax': ['error', ...GLOBAL_IRON_LAWS, ...SIM_ONLY_IRON_LAWS],
  },
});

export default configs;
