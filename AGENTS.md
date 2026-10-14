# AGENTS.md — 仓库协作规则

> **本文件是多个 agent 并行工作的唯一协作契约。开始任何工作前必须先读完本文件。**
> 最后更新：随策划案 v0.2 一并建立。

---

## 0. 项目一句话

《窃金者 TD》：以「窃取敌人钱包」取代「击杀赚钱」为核心经济引擎的单机离线网页塔防。TypeScript + Phaser 3 + Vite。

---

## 1. 权威文档（冲突时的优先级）

| 优先级 | 文档 | 作用 |
|---|---|---|
| 1 | [`docs/窃金者TD-开发策划案-v0.2.md`](docs/窃金者TD-开发策划案-v0.2.md) | **设计唯一真相**。所有数值、系统、波次、难度以此为准 |
| 2 | [`docs/接口契约-v0.1.md`](docs/接口契约-v0.1.md) | **接口唯一真相**。跨模块的类型、签名、字段名以此为准 |
| 3 | 本文件 | 协作规则与路径所有权 |

**若发现策划案与接口契约矛盾**：接口契约优先（它是冻结的），并在汇报中提出，不要自行改动任一文档——交给主策划裁决。

---

## 2. 目录所有权（最重要的一节）

**只允许写自己名下的独占路径。** 写别人的路径会直接覆盖其工作成果。

| 路径 | 所有者 | 其他 agent |
|---|---|---|
| `src/sim/**` | `engine-dev` | 只读 |
| `src/render/**` | `engine-dev` | 只读 |
| `src/main.ts`, `index.html`, `vite.config.ts`, `tsconfig.json`, `eslint.config.js` | `engine-dev` | 只读 |
| `tools/bench/**` | `engine-dev` | 只读 |
| `src/data/**` | `data-arch` | 只读 |
| `tools/validate-data.ts`, `tools/gen-types.ts` | `data-arch` | 只读 |
| `tests/data/**` | `data-arch` | 只读 |
| `public/assets/audio/**`, `docs/audio-credits.md` | `audio-curator` | 只读 |
| `src/balance/**`, `tools/balance-report.ts` | `balance-eng`（批次 2） | 只读 |
| `tests/sim/**` | `balance-eng`（批次 2） | 只读 |
| `src/ui/**` | `ui-dev`（批次 2） | 只读 |
| `src/art/**`, `tools/art/**`, `tests/art/**` | `art-proxy` | 只读 |
| `docs/art/**`（**除** `占位美术方案.md`） | `art-proxy` | 只读 |
| `docs/art/占位美术方案.md` | **主策划冻结**（设计规格，不得修改） | 只读 |
| `tests/e2e/**`, `docs/qa/**` | `qa-verifier`（批次 3） | 只读 |
| `package.json` | **主策划冻结** | **任何人不得修改** |
| `AGENTS.md`, `docs/*.md` | **主策划** | 只读 |

**未分配路径**：需要时先向主策划申请，不要自行创建新目录。

### 禁止事项（违反即视为交付失败）

1. ❌ 修改 `package.json`（脚本名与依赖清单已冻结；缺依赖请汇报，不要自己装）
2. ❌ 修改 `docs/` 下任何 `.md`（包括策划案与接口契约）
3. ❌ 写非自己独占路径的文件
4. ❌ 引入接口契约之外的第三方运行时依赖
5. ❌ 在 `src/sim/**` 中 `import` Phaser（模拟层必须能在 Node 里裸跑）
6. ❌ 使用浮点数参与模拟层数值计算（见第 5 节）
7. ❌ 使用 `Math.random()`（必须用可播种 RNG）
8. ❌ 把「全部通过」「没有问题」当作最终汇报结论——先说明你实际验证了什么、什么没验证

---

## 3. 运行环境

本机已装好 Node 与 pnpm，**不要另装 Node**：

```
node : C:\Users\danwei.zheng\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
pnpm : C:\Users\danwei.zheng\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs
```

调用方式（pnpm 是 .mjs，需要用 node 启动）：

```powershell
$node = "C:\Users\danwei.zheng\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "C:\Users\danwei.zheng\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"

& $node $pnpm install          # 安装依赖
& $node $pnpm run typecheck    # 类型检查
& $node $pnpm run test         # 单测
```

**首次使用前**先 `& $node $pnpm install`。仓库根目录：`E:\tower-defense`。

### 3.1 工具可用性（实测，省得你再踩一遍）

| 工具 | 状态 | 说明 |
|---|---|---|
| `web_search` | ❌ **不可用** | 报 `DEEPSEEK_API_KEY` 未配置。不要反复重试 |
| `web_fetch` 抓 `https://html.duckduckgo.com/html/?q=<urlencoded>` | ✅ **可用** | **站外检索走这条**。注意 `ddg lite` 会返回 anti-bot 页 |
| `web_fetch` 抓 Bing | ⚠️ 部分可用 | 返回内容常与查询无关（忽略引号），不可依赖 |
| `web_fetch` 抓 `baidu.com/s` | ⚠️ 内容被截断 | 结果页正文拿不到 |
| 百度知道 / 贴吧 / OGA / Kenney / KK 对战平台 | ✅ 直连可用 | 无需登录 |

> 另：Windows 控制台用 GBK 读 UTF-8 文件会显示乱码（如 `渚挎嵎`），**那只是控制台编码问题，文件本身是好的**。要确认内容请用 read 工具，不要用 `Get-Content` 看中文。

---

## 4. 脚本契约（已冻结，不得改名）

`package.json` 中已定义下列脚本。你只需让它们能跑通，不要改脚本名。

| 脚本 | 含义 | 所有者提供实现 |
|---|---|---|
| `dev` | Vite 开发服务器 | `engine-dev` |
| `build` | 生产构建 | `engine-dev` |
| `preview` | 预览构建产物 | `engine-dev` |
| `typecheck` | `tsc --noEmit` | `engine-dev`（tsconfig 配置） |
| `lint` | ESLint | `engine-dev` |
| `test` | Vitest 全量 | 各模块各自提供用例 |
| `validate-data` | 校验 `src/data/*.json` 符合 Schema | `data-arch` |
| `gen-types` | 由 Schema 生成 `src/data/types.generated.ts` | `data-arch` |
| `balance` | headless 平衡跑批 | `balance-eng`（批次 2） |
| `bench` | 性能基准 | `engine-dev` |

---

## 5. 工程铁律

| # | 铁律 | 原因 |
|---|---|---|
| 1 | **模拟层零渲染依赖**：`src/sim/**` 不得 `import` Phaser | 让 headless 模拟器能在 Node 中跑完一整局（这是 CI 平衡门禁的前提） |
| 2 | **固定步长**：逻辑 60Hz 定步长；渲染做插值 | 倍速、暂停、低帧率设备行为一致 |
| 3 | **定点数**：模拟层一切数值一律用 `× 1000` 的整数（**含金币、木材**）；仅纯计数（tick / id / 波次 / 阻挡名额）用普通整数 | 窃金是每次攻击结算的细粒度高频收入（一局数千次），逐次取整会系统性累积舍入误差。详见[接口契约 §2](docs/接口契约-v0.1.md) |
| 4 | **可播种 RNG**：所有随机走 `mulberry32(seed)`，种子存存档 | 可复现 bug、可回放、可自动化测试、可做挑战码分享 |
| 5 | **数据驱动**：所有数值在 `src/data/*.json`（`data-arch` 所有），代码不得内联魔法数字 | 策划独立调平衡，改数值零代码改动 |
| 6 | **Schema 门禁**：所有配置表必须通过 Schema 校验 | 配置写错在 CI 被拦，而不是运行时崩 |
| 7 | **可变状态 + 只读视图**：模拟层用可变 `WorldState`（性能），对外只暴露 `readonly` 视图 | 250 敌人 × 60fps 下，纯不可变会产生严重 GC 压力 |

> 铁律 7 是对策划案 8.2 图中「WorldState 不可变快照」的**修正**。策划案文字已同步更新。

---

## 5.1 ⚠️ 铁律 8：门禁必须能证明它**没测到**什么（本项目已犯三次）

**任何断言、门禁、测试，如果只报告"通过"，就无法区分以下两种状态：**

```
(a) 被测对象确实正确
(b) 断言根本没测到被测对象
```

**本项目已经犯了三次，全部是靠"换一个独立视角"才发现的：**

| 时间 | 门禁 | 报告状态 | 实际守住了什么 | 怎么发现的 |
|---|---|---|---|---|
| M0 | `pnpm lint` | exit=0 | **对 `.ts` 是空操作**（无 parser，espree 解析不了类型标注） | 装上 `@typescript-eslint/parser` 后立刻暴露 8 个假阳性 |
| M2 | `validate-data` 49 项结构检查 | 全部通过 | **没有任何检查在守"数据能否通关"** | `balance-eng` 用 headless 模拟跑出 0% 通关率 |
| M2 | `validate-data` + 全部用例 | 全绿 | **出怪总数被放大 7%**（心魔分身无界递归分裂）而无人发现 | `balance-eng` 做分裂开关对照实验 |
| M2 | `tests/art/**` 82 用例 | 全绿 | 「非颜色通道有效性」断言测的是**整只精灵像素差**（219–375px **全部来自本体形状**），**没有把被测通道隔离出来** | `art-proxy` 自查后**主动删掉**该断言，换成只测环带的 16 条新用例 |
| M2 | **主策划的「环带复验」** | 判定「护甲通道未实现」 | **测量区域是空的** —— 帧外圈 2px 在 32×32 帧里只有 **0 个实体像素**，所以差异恒为 0，被误读成"通道不存在" | `art-proxy` 给出**区域敏感对照**：**同一对**精灵在该区域差 0、在正确环带差 **184** |

> **最后一行是主策划自己犯的错**，而且犯在写下本条规则之后。它值得单独记住，因为它揭示了一个更细的陷阱：
>
> **一个空的测量区域会返回 0，而 0 看起来就像"决定性的否定结果"。**
>
> 当时我还打印了一行 `y=0: ################` 当作"边框没有虚线断口"的证据 —— 那一行其实是**帧的黑色背景**（被 `sum(c)<60` 误判为实心）。**我拿一行空白，推出了一个结论。**

### 强制要求

**1. 每条门禁必须配一条负对照（negative control）。**

构造一个**已知错误**的输入，断言门禁**必须报红**。若负对照也通过，说明门禁失效。

参考实现：`engine-dev` 的像素校验里，`integer-8x / LINEAR` 组就是负对照 —— 它证明"混色检测器"本身是有效的（混色像素 5564），而不是一个恒返回 0 的空测试。

**2. 断言的作用域必须窄到只覆盖被测属性。**

反例（真实发生）：断言「不同护甲可区分」时计算**整只精灵**的像素差 → 本体形状的差异淹没了边框通道的差异 → 测试通过而通道从未被验证。

正例：只取**环带区域**计算像素差，断言 `ring_diff(a, b) > 阈值`。

**3. 不能靠"整体差异大"证明"某个通道有效"。**

整体差异永远可以被无关信号主导。**必须把被测通道隔离出来测。**

**4. ★ 正对照必须在**同一个区域**内成立（`art-proxy` 的教训，主策划踩的坑）。**

做**差异类测量**之前，必须先证明**该区域里有信号**：

```
取一对「已知必然不同」的样本，在【同一区域】测量 → 必须显著非零
若这一对在该区域也返回 0，说明区域是空的，任何 0 都无意义
```

`art-proxy` 的「区域敏感对照」是标准做法：**同一对** `thug vs heavy_brute` 在错误区域差 **0**、在正确环带差 **184** —— 这一个数字同时证明了「我的区域是空的」和「正确区域有信号」。

**没有这一步，`diff == 0` 无法区分「两者相同」与「什么都没测到」。**

**5. 汇报时必须主动回答两个问题：**

- 「如果我的断言是空的，它会报红吗？」（→ 需要第 1 条）
- 「我的测量区域里有多少信号？一对已知不同的样本在这里差多少？」（→ 需要第 4 条）

若答不出，说明它可能是空的。

> **一句话**：**一个绿着的测试，如果不测它名字声称的东西，比没有测试更危险——因为它会让人停止怀疑。**
> **一个空的测量区域，比一个绿着的测试更危险——因为它会给出"决定性的否定结论"。**

---

## 6. 汇报规范

每次交付必须包含下面四段，缺一即视为未完成：

```
## 交付
（产出物清单：文件路径 + 一句话说明）

## 验证
（你实际跑了什么命令、输出是什么。贴关键输出，不要只说"通过"。
 明确区分：已验证 / 未验证 / 无法验证）

## 未验证与已知缺口
（你没能验证的部分、你猜测的部分、你认为有风险的部分）

## 阻塞与需要主策划裁决
（需要别人先完成的事、需要改契约的事、拿不准的设计问题）
```

**禁止**：用「已全部完成」「一切正常」这类无信息量的结论收尾。主策划需要的是你**没做到**的部分。

---

## 7. 批次状态

### 批次 1（M0 技术预研）—— ✅ **全部完成，M0 门禁已开放**

结论见 [`docs/M0-验收结论.md`](docs/M0-验收结论.md)。三项标准：② 1x/2x/4x 哈希一致 ✅、③ NEAREST 无糊边 ✅、① 250 敌人 + 500 投射物 —— 逻辑侧 ✅（仅占 4.2% 帧预算）、**渲染侧 ⚠️ 未在目标硬件（i5-8250U 核显）验证**。

| Agent | 状态 |
|---|---|
| `engine-dev` | ✅ 完成（已停）。引擎、确定性内核、渲染管线、bench 全部交付 |
| `data-arch` | ✅ 完成（已停）。9 张表 / 139 条目 / 49 项结构检查 / 296 用例 |
| `audio-curator` | ✅ 完成（已停）。40 个 CC0 音频 + 台账。⚠️ AcoustID 撞车自查未完成（需 API key），听感验收未做 |

**M0 后的仓库健康度**：`pnpm typecheck` / `lint` / `test`（325 用例）**全部 exit=0**。

> ⚠️ `pnpm lint` 在 M0 期间曾对 `.ts` 是**空操作**（无 TS parser），直到装上 `@typescript-eslint/parser` 才真正生效 —— 并立刻暴露一个被掩盖的假阳性：铁律选择器未限定作用域，误伤了本来就该 import Phaser 的 `src/render/**` 与 `tools/bench/**`。已修正并做反向验证。**教训：一条不可见的质量门禁等于没有门禁。**

### 批次 2 —— **两线均空闲，等发起人试玩读数**

| Agent | 状态 | 说明 |
|---|---|---|
| `engine-dev` | ✅ **完成并停** | 可玩路径接线完成；试玩说明已交（`tools/bench/试玩启动说明.md`）|
| `balance-eng` | ✅ **完成并停** | AI 平衡线**冻结**（契约 §28.3），存档在 `src/balance/README.md`。**只保留「AI 当门禁」的维护职责** |
| `ui-dev` | ⏸ 按住 | 等 G1 通过 |

> **★ 当前唯一未决项：发起人在 N1 的试玩读数**（`pnpm dev` → 默认 N1，打到第 14 波）。
> 它决定 M2 门禁，也决定一件更重要的事：**若发起人轻松过 14 波，则这十几轮 AI 的失败全是 AI 的局限而非游戏的局限** —— 那会把整件事的结论翻转。

**AI 平衡线的冻结范围（重要，勿擅自解冻）**：

| 冻结 | 保留 |
|---|---|
| 控制器升级、继续扫大脑权重、改 `SAFETY_WEIGHT` 默认值、修 `heuristic` | 11 条权威门禁的维护（`solvability` / 覆盖率定义性边界 / 变异覆盖 / 出怪守恒 / 实验后门 / 键登记…）|

**解冻时的两件事**（契约 §29.4）：① `SAFETY_WEIGHT` 6→1；② 分配从 binary 硬分支改为数据目标驱动的控制器。

**读平衡报告前必看**：契约 §29.2 的**已知无效读数清单**（`heuristic` 覆盖率是假 0、`noop@74.1%` 是 6 波窗口、N4/N5 高覆盖是假象、`goldWorldPixels` 绝对值被污染…）。

> **★ 可玩路径的意义**：AI 已在"能不能赢"上连撞三墙（解析预测 / 标定门槛 / 纯反馈闩锁，见契约 §25.7），而策划案 M2 的验收标准是「**15 分钟连续试玩**」—— **那个试玩者应该是人**。发起人将亲自试玩 N1。

**接线的一条架构约束（防债扩散）**：

> **`src/balance/data-adapter.ts` 的 import 只允许出现在 `src/main.ts`（组合根）一处。**
> 场景接收 `SimContent` 作为参数，`src/render/**` 不得 import `src/balance/**`。
> 理由：适配层最终要迁到 `src/data/adapter.ts`（那笔债已登记）。**把它限在一行，迁移时只改一行。**

### 遗留待办（已裁决、未实现）

| 项 | 归属 | 出处 |
|---|---|---|
| **适配层迁移**到 `src/data/adapter.ts` | `balance-eng` → `data-arch` | **迁移面 = 23 个文件**（不是 1 处，也不是主策划一度报的 4 处）：生产组合根 **1**（`src/main.ts`）+ `balance-eng` 的 `src/balance/**` **8**（`simulate`/`report`/`gap-report`/`aging-scan`/`coverage-scan`/`halt-scan`/`halt-instrument-check`/`survival-threshold`）+ `balance-eng` 的 `tests/sim/**` **12** + `engine-dev` 的 `tests` **2**（`src/sim/__tests__/solvability-tech.spec.ts`、`spawn-count.spec.ts`） |
| **投射物渲染的规格偏差**（§8.5 要求池 500，实际为 Graphics 批量画方块） | **发起人裁决**（接受偏差 / 让 `art-proxy` 补投射物帧） | art 图集 109 帧已用尽，无投射物帧 |
| `map.json` 定稿 | `data-arch`（M1 前） | 契约 §14.11 |

**已关闭的遗留项**（勿重新派发）：BOSS 钱包系数与不变量（`data-arch`）｜`SimEvent` 补 `undo`/`skillActivated`/`waveStats` 与 `gameOver('ascended')`（`engine-dev`）｜`stealWoodRatio = 3`｜科技树改乘法 + `TechDef.target`｜`gap.maxThiefTier()` 死接口｜适配层「按下标取难度」的静默错位。

### 两条线的边界（并行时尤其重要）

| Agent | 独占 |
|---|---|
| `balance-eng` | `src/balance/**`、`tests/sim/**`、`tools/balance-report.ts` |
| `engine-dev` | `src/sim/**`、`src/render/**`、`src/main.ts`、`tools/bench/**` |

> ⚠️ **`tools/bench/**` 属 `engine-dev`**，`balance-eng` 不得往那里写。
> ⚠️ **并行结论必须附被依赖文件的 mtime** —— 已发生过一次：读到了对方改动的中间态（28 文件里 9 个加载失败）。

### 批次 3

`qa-verifier`（M3 启动）。**它的 KPI 是「找到问题」而不是「通过」** —— 这一点来自 M0 的教训：主策划用**同一张错表**做「反推验证」，等于自己验自己，§5.2 与 §5.5 的错误互相掩护、全部通过。**独立审查不是冗余。**
