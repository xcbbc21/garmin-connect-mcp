# Garmin Calendar 写入安全与恢复：任务完成情况对照报告

对照文档：`docs/superpowers/plans/2026-09-11-calendar-write-recovery.md`（下称"方案"）
基线：`67f5ec9`（包版本 `0.2.0`） · 报告日期：2026-09-11

本地提交：`08ac0f3`、`6268be7`、`2934d5f`、`a527c7e`，**已推送**至 `origin/main`，远端 HEAD = `a527c7e`。

> ## ⚠ 续修更新（2026-09-12，截至 `ff128b6`）
>
> **本文件 §0–§8 是第一轮（`a527c7e`）的历史快照，其中多行已被续修推翻。** 保留原文以便追溯，
> 但**不得**把下面的判断当作当前状态：
>
> | 本文原判断 | 续修后的实际状态 |
> |---|---|
> | "创建 / 创建并排期 / 取消的日志托管：未完成" | **已完成**——5 个写工具全部经协调器下发，`src/tool-service.ts` 中 4 处直连底层写入的点已消除 |
> | "日历查询 / 核对 / 恢复 与 4 个新工具：未完成" | **已完成**——`get_garmin_calendar`、`get_garmin_write_operation`、`reconcile_garmin_write_operation`、`resume_garmin_write_operation` 均已交付，工具总数 18 |
> | "4 个新工具未实现，公共类型未从根入口导出" | 工具已实现；公共类型导出情况见 `docs/calendar-write-recovery.md` |
> | **§1 末："这 3 个工具也不接受 `idempotencyKey`，实际只有 2 个支持"** | **续修后又发现一层缺口并已修复**：服务层签名接受并不等于 MCP 客户端可达。补齐 `create_and_schedule_garmin_workout` 与 `unschedule_garmin_workout` 的输入 schema 后，5 个写工具**全部**可经真实 MCP 参数层传入 `idempotencyKey`（提交 `ede191f`，`src/mcp.ts:455`、`:472`） |
> | **§0/§2 "安全底座（持久日志 + 跨进程锁 + 类型化结果）：完成"** | 基础设施本身确已完成，但其中**"提交证明"这一条在 Linux 上不成立**：`assertLandedFile` 只比对 `(dev, ino)`，而 POSIX 在 unlink 后会**回收刚释放的 inode 号**，因此 `rm` + 同长度重写可冒充已提交日志，store 静默接受一个自己从未写过的文件。macOS/APFS 分配新 inode，所以本机一直是绿的——**是平台矩阵（C10）把它挖出来的**。已改为**回读落地字节**与 payload 比对（提交 `ff128b6`），并把 inode 对与 size 降为廉价前置信号；新增用例**主动屏蔽 inode 信号**，使断言在任何平台都钉住字节校验 |
> | "`npm run build` 本机不可运行：`clean` 被批量删除守卫拦截" | **判断有误**：那是当时所用 shell 的行为，不是项目问题。`npm run build` / `pack:smoke` / `test:distribution` 本轮全部 exit 0 |
> | "日志无归档，32 MiB 上限后拒写" | 仍成立（限制条款未改） |
> | "文档：完成" | **当时即不成立**——文档同时存在"已完成"与"未实现"两种口径；续修已按实际状态统一 |
> | **§8 "下一批"第 1、2 条** | 均**已完成**：CI 平台作业已接入 journal/lock/migration/private-state/stdio 恢复用例；3 个工具的协调器托管与 5 工具 `idempotencyKey` 已落地（后者含参数层修复） |
> | "三平台验证：仅 macOS；Linux/Windows 未跑，CI 也未接入新用例" | CI 平台作业**已接入**并覆盖上述恢复用例。**实测结果：** macOS 本机 12 套件 / 189 用例（两批：6/55 + 6/134）exit 0；Linux `arm64v8/ubuntu:22.04` 容器上 Node 20 与 Node 22 各自跑完整 7 条命令全部 exit 0（该电池正是发现 inode 回收缺陷的通道）；**Windows 本机无执行能力，仍未实测**。逐项数字与通道差异见 `docs/verification.md` 的 "Platform results, continuation round" 一节 |
>
> 续修逐项状态、真实命令结果与证据边界以 `docs/calendar-write-recovery.md` 与
> `docs/verification.md` 的 "continuation round" 一节为准。
>
> 另外，`a527c7e`（本文所称基线之一）的 `tests/fixtures/mcp-tools-baseline.json` 与当时的
> `src/mcp.ts` **不一致**：源码已含 `duplicatePolicy`，夹具未同步，因此该修订上
> `tests/mcp.test.ts` 实际是失败的。该缺陷已在续修 C8b 修复。
>
> **§1 的四处直连写入点已消除**（`:566` / `:791` / `:804` / `:836` 的行号属第一轮快照，
> 不再对应当前源码）；§1 中"未托管日志的写入路径"一节只作为第一轮的缺陷记录阅读。

## 0. 总判

**安全基础设施与模拟验收已完成；目标地区的日历查询与自动恢复受能力限制。**

这正是方案第 12 节在"生产查询端点尚无法可靠核实"时规定的交付状态。核心安全不变量已成立并有测试证明；但方案要求的 4 个新工具、日历范围查询、只读核对与恢复**未实现**，创建与取消两个阶段**未纳入日志托管**。

| 维度 | 完成度 |
|---|---|
| 安全底座（持久日志 + 跨进程锁 + 类型化结果） | 完成 |
| 排期去重与"不确定写入不被重发" | 完成（单日 + 批量） |
| 创建 / 创建并排期 / 取消的日志托管 | 未完成 |
| 日历查询 / 核对 / 恢复 与 4 个新工具 | 未完成 |
| 文档 | 完成 |
| 三平台验证 | 仅 macOS；Linux/Windows 未跑，CI 也未接入新用例 |

## 1. 方案 Task 0–9 逐项对照

| Task | 方案要求 | 状态 | 证据 / 缺口 |
|---|---|---|---|
| 0 | 冻结基线、记录环境与工具表、完成接口证据表 | **完成** | `docs/calendar-api-verification.md`；确认 HEAD 即基线 `67f5ec9` |
| 1 | 查询模型与适配（日期范围、分页、完整性标志） | **未完成** | SDK 与本仓库均无可核验的日历读接口，未实现适配，也未做真实探测 |
| 2 | 身份、持久日志、跨进程锁 | **完成** | `src/write-operations/{identity,store,lock,types,errors}.ts`；store 在每个写入故障点注入异常，锁用两个真实子进程竞争 |
| 3 | 类型化写入结果与迟到请求 | **部分** | 分类与"永不自动重试"完成；**迟到 promise 按 operationId+stepId+attempt 回写、AbortSignal 取消、有界关闭未做** |
| 4 | 单日排期统一协调器 | **完成** | `coordinator.ts`；四条绕过路径均有测试 |
| 5 | 只读核对与批准恢复 | **未完成** | 依赖 Task 1 |
| 6 | 批量、创建与取消覆盖 | **部分** | 批量完成（逐条状态 + 5 个计数）；**创建 / 创建并排期 / 取消未托管** |
| 7 | MCP 契约与子进程链路 | **部分** | 幂等键与文案修正完成，stdio 子进程去重有测试；**4 个新工具未实现，公共类型未从根入口导出** |
| 8 | 文档、技能与交付物 | **完成** | README(en/zh)、CHANGELOG、manual.zh-CN、migration、verification、SKILL 全部更新；新增 3 篇文档；链接 33 条 0 断链 |
| 9 | 全量验收与证据交付 | **部分** | 本机 lint / 测试 / 覆盖率 / 打包审计 / 分发校验全绿；**CI 平台作业未接入新用例，Linux/Windows 未实测** |

### 仍未托管日志的写入路径（已逐行核实）

`src/tool-service.ts` 中仍有 4 处直接调用底层写入、绕过协调器：

| 位置 | 调用 | 影响 |
|---|---|---|
| `:566` `createWorkout` | `client.addWorkout` | 创建超时无记账，可能重复创建模板 |
| `:791` `createAndScheduleWorkout` | `client.addWorkout` | 同上 |
| `:804` `createAndScheduleWorkout` | `client.scheduleWorkout` | 排期阶段未走去重 |
| `:836` `unscheduleWorkout` | `client.unscheduleWorkout` | 取消超时无记账 |

（`:274` 是协调器内部的 writer 适配，属正常路径。）

后果：这 3 个工具也**不接受 `idempotencyKey`**——方案要求 5 个写工具都支持，实际只有 `schedule_garmin_workout` 与 `batch_schedule_garmin_workouts` 2 个。

## 2. 方案第 2 节"完成后的用户行为"对照

| # | 预期行为 | 状态 |
|---|---|---|
| 1 | 查询某日期范围内的排期（而非下载全部历史） | **未实现** |
| 2 | 同一 workout 可安排在不同日期；同账号同 workout 同日期保持一条 | 完成（默认跳过已存在项；不自动清理历史重复，符合方案"明确不做"） |
| 3 | 重复请求返回已有操作 / 已存在排期，不再发出相同写入 | **完成**，四条绕过路径均被阻断 |
| 4 | 超时返回 `unknown` 与可持久查询的 `operationId` | **部分**：`unknown` + `operationId` 已返回且已持久化，但**没有查询工具**，只能读本地日志 |
| 5 | 用户可查询状态、只读核对、仅恢复有证据的安全项 | **未实现** |
| 6 | 批量逐条列出成功 / 跳过 / 明确失败 / 未执行 / 不确定，不整批重发 | **完成** |
| 7 | 重启、关闭客户端或更换登录别名后写入记录不失效 | **完成**（重启与别名共享均有测试） |

## 3. 方案第 11 节测试矩阵覆盖

| 类别 | 状态 |
|---|---|
| 日期、ID、预览、去重、账号、状态、并发、超时、批量（部分）、认证、MCP、打包 | 已覆盖 |
| **日历查询**、**核对**、**创建**、**取消** | 未覆盖（功能未实现） |
| 崩溃（发出后被杀、批量中途被杀） | 部分：重启与发包前失败已覆盖，进程被杀的中间态未覆盖 |
| 批量（认证失效中断） | 未覆盖 |

## 4. 方案第 12 节交付清单对照

| # | 要求 | 状态 |
|---|---|---|
| 1 | 变更文件、提交列表、接口与行为变化说明 | 完成（本文件 + `git log`） |
| 2 | 新增工具 schema / 示例 / 状态 / 错误码，旧工具兼容测试结果 | 部分（**无新增工具**；新字段与错误码已述；旧工具兼容测试全绿） |
| 3 | 测试命令与结果、覆盖率、三平台状态、产物审计、干净安装 | 部分（本机全绿；运行时分发安装通过；**三平台未达**） |
| 4 | 查询 / 取消接口证据表，分源码核验 / 模拟 / 真实、国内 / 国际 | 完成（`docs/calendar-api-verification.md` §2、§6） |
| 5 | 至少 3 段可复现演示 | 完成（本文件 §7） |
| 6 | 仍无法解决的边界 | 完成（本文件 §8） |

方案第 12 节末尾的禁止条款已遵守：**没有**以"加了查询工具 / 延长超时 / 只加了 idempotencyKey 字段 / 内存 Set 通过测试"充当完成标准；幂等键与业务键均经持久化、跨工具 / 跨请求检查、发包前生效、重启与真实双进程并发验证。

## 5. Global Constraints 对照

| 约束 | 状态 |
|---|---|
| 保持独立本地 stdio MCP，不恢复 DSH / Cordis / React | 遵守（未触碰） |
| 包继续 `private: true`，本轮不发布 npm | 遵守（审计脚本亦校验） |
| 保留已有工具名称、必填参数与正常成功字段 | 遵守（14 个工具名不变；`workoutId` / `date` / `timezone` / `workoutScheduleId` 保留） |
| 一次性确认、10 分钟、内容绑定；凭证与幂等键不混用 | 遵守 |
| 禁止 POST / DELETE 自动重试（含拦截器、认证刷新、批量恢复） | 遵守（拦截器仅重放 GET / HEAD / OPTIONS） |
| 休息日不创建 workout；训练内合法 `rest` 保留 | 遵守 |
| 不修改真实 Garmin 数据 | 遵守（全程未接触真实账号） |
| 不承诺服务端 exactly-once | 遵守（文档明示） |
| GitHub 动作走已授权接口，不索取凭证 | 遵守（同步前仅用 MCP 只读核验；推送经一次性明确授权） |

## 6. 验证结果（本机 macOS arm64 / Node v22.22.2）

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit` | 干净 |
| `eslint src tests scripts --max-warnings 0` | 干净，0 warning |
| `NODE_OPTIONS="" npx jest --runInBand` | **41 套件 / 847 用例全过** |
| `npx jest --coverage --runInBand` | 全文件 87.03 / 78.81 / 87.16 / 89.83（门槛 75 / 70 / 65 / 78）；`src/write-operations` 88.22 / 71.25 / 87.27 / 89.44 |
| `npm run pack:smoke`（审计） | 通过：179 文件、270,729 B，无 `src` / `tests` / `node_modules` / 会话 / 日志泄漏 |
| `npm run test:distribution` | 通过：`runtimeOnlyInstall:true`，14 工具 |
| `npm run test:integration` | **未运行**（需真实账号授权） |
| `npm run build` | **本机不可运行**：`clean` 被环境批量删除守卫拦截；改用 `npx tsc`。打包产物以 CI 为准 |

## 7. 三段可复现演示

```bash
# 1. 换新预览也无法绕过
npx jest --runInBand tests/write-coordinator.test.ts \
  -t "a brand-new preview cannot bypass an existing unknown write"
# 2. 重启后仍拒绝重发
npx jest --runInBand tests/write-coordinator.test.ts \
  -t "a restarted process cannot bypass an existing unknown write"
# 3. 两方并发确认只发出一次 POST
npx jest --runInBand tests/write-coordinator.test.ts \
  -t "concurrent confirmations cannot double-write the same workout and date"
```

## 8. 剩余限制与下一批

**能力边界（不是漏做）**：无服务端 exactly-once；外部设备 / 网页端可并发修改；无可用日历读接口，故**永远无法证明"不存在"**；`unknown` 永久占据该 workout + date；不同 state 根互不锁定；日志无归档，32 MiB 上限后拒写。

**下一批（按性价比排序）**

1. `src/index.ts` 导出新增公共类型；`.github/workflows/ci.yml` 平台作业接入 `write-operation-store/lock` 测试（消除"验证充分性"短板，不依赖外部接口）。
2. 把 create / create-and-schedule / unschedule 接入协调器，一次性消掉 §1 的 4 处绕过，并让 5 个写工具统一支持 `idempotencyKey`。
3. 日历范围查询：需先决定——授权一次真实账号**只读**探测，或明确"永久不做"并为核对 / 恢复设计人工替代方案。
4. Task 3 收尾：迟到结果回写、AbortSignal 取消、有界关闭。
