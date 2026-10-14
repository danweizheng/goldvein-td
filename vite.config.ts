import { defineConfig } from 'vitest/config';

/**
 * Vite + Vitest 配置（owner: engine-dev）
 *
 * - `build.target: es2020`（策划案 §8.7）
 * - `base: './'`：纯静态托管（GitHub Pages 子路径 / 自建 nginx 都能用）
 * - `test.include` 必须同时覆盖 **各 agent 自己的用例目录**：
 *     src/**  （engine-dev）
 *     tests/data/**（data-arch）
 *     tests/sim/**（balance-eng）
 *     tests/e2e/**（qa-verifier）
 *   不要收窄成只匹配 src/**，否则会静默跳过别人的用例。
 *
 * ## ⚠️ 为什么 `server.watch.ignored` 里必须有 `tools/bench/out/**`
 *
 * 这条是踩出来的（可玩路径排查，2026-10-14）：自动化冒烟把 **Chrome 的
 * `--user-data-dir` 放进了仓库目录**，Chrome 往里写几百个文件 → vite 的 watcher
 * 监听整个项目根 → 触发 HMR / **full page reload** → 正在加载的资源被打成
 * `ERR_CONNECTION_REFUSED`、页面甚至整屏空白。
 *
 * 它伪装成了"dev server 坏了"，而真相是**工具污染了被测环境**。
 * 现已双保险：① 浏览器 profile 一律写到系统临时目录；② 本配置永不监听该输出目录。
 */
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    // 像素风资源很少，首包 ~1.1MB gzip（策划案 §8.1）
    chunkSizeWarningLimit: 1600,
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    watch: {
      // 工具输出目录不该触发页面重载（报告 JSON / 截图 / 浏览器 profile）
      ignored: ['**/tools/bench/out/**', '**/dist/**'],
    },
    // 首次打开就把入口与场景预转换好，避免"浏览器先到、优化器后到"的竞态
    warmup: {
      clientFiles: [
        './src/main.ts',
        './src/render/scenes/BootScene.ts',
        './src/render/scenes/GameScene.ts',
      ],
    },
  },
  // phaser 很大（~6.7MB 预打包），显式声明可让 dev server **启动时**就把它优化好，
  // 而不是等浏览器第一次请求时才发现新依赖 → 中途重启 → 页面重载 / 白屏。
  optimizeDeps: {
    include: ['phaser'],
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts', 'tests/**/*.{test,spec}.ts'],
    exclude: ['node_modules/**', 'dist/**', 'tools/bench/out/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // 基准用例（250 敌人 + 500 投射物）耗时长且吃 CPU，串行跑更稳
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
