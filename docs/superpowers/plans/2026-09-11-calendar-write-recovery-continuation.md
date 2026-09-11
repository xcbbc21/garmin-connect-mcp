# Garmin Calendar 写入安全续修 Implementation Plan

> 给执行 Agent：从当前实现继续，按 C0–C10 逐项执行、记录测试证据。若环境提供 `superpowers:executing-plans`，使用该流程。先复现已知漏洞，再修复并完成剩余能力；不要只更新报告。本文是后续执行任务书，不是“已修复”的声明。

**Goal:** 修复已有持久化去重的漏洞，补齐完整批量记账、5 个写工具统一托管、日历读取、操作查询、核对与批准恢复，交付可审计的测试和实际能力说明。

**Architecture:** 保留现有客户端、认证、MCP 与操作日志模块，完善账号级互斥、历史操作索引及阶段状态机。所有 Garmin 写入先记账并确认；日历读取作为新的只读适配，用于预检和核对。

**Tech Stack:** TypeScript、Node >=20、Zod、Jest、MCP SDK、Axios；现有依赖版本由 package-lock.json 决定。

**Spec:** 本文自包含主要续修要求；完整原始规格见同目录 `2026-09-11-calendar-write-recovery.md`。执行前读取两份。本文对进度、优先级、状态迁移和验收的修订优先；原方案其余约束仍保留。若换机器交接，应附上这两份文件。

## 1. 基线、范围与约束

- 项目：`/Users/chuanxing/garmin-connect-mcp`，仓库 `xcbbc21/garmin-connect-mcp`。
- 本轮现场核对 HEAD：`bd4daef8121cb58bdd939a8057145bbe13d19a2d`；版本 `0.2.0`。
- 已有实现提交：`08ac0f3`（日志/锁）、`6268be7`（单日/批量协调器），其余近期提交主要是文档。
- 现场有未跟踪 `.workbuddy/`、`docs/superpowers/`。保留；不要删除、盲目提交或假定其中内容属于本次任务。
- 开始时重新检查 HEAD、工作区及 AGENTS.md；若其他 Agent 已推进，按代码重新判定，不重复覆盖。
- 所有 GitHub 相关动作走用户已授权接口。历史 push 授权不等于本轮任意发布、合并、清理分支授权；先完成可审查的本地代码和提交。
- 保持本地 stdio、`private:true`、现有登录命令和会话格式。禁止重引入 DSH/Cordis/React。
- 真实 Garmin 写入、删除需要明确的账号与操作授权。公共源码核验、隔离模拟测试、本地代码修复不依赖真实账号。
- 休息日省略，不创建 workout；workout 内部合法 rest 步骤保留。
- 不增加写请求自动重试、不删除 unknown 记录以解除阻断、不通过新增幂等键绕过业务约束。
- 用户请求是完整续修。接口证据暂缺时继续完成不依赖它的任务；最终真实能力受限时如实交付，不能将所有未完成项归因于接口。

## 2. 进度重新认定

`docs/calendar-write-delivery.md` 是被审查的交付声明，不作为已通过验收的权威依据。

| 项目 | 当前实际状态 | 后续处理 |
|---|---|---|
| 日志、锁、类型化结果 | 已有基础实现，但权限与内容校验不足 | 加固并增加迁移 |
| 单日/批量跨请求去重 | 已接入，存在历史记录遮蔽漏洞 | C1 优先修复 |
| 完整批量结果 | 丢弃不可写项，可能错误报告全成功 | C2 优先修复 |
| 预览/幂等键 | prepared 重预览和操作复用存在缺陷 | C3 修复 |
| 创建、组合创建、取消 | 仍直接调用客户端，未托管 | C5 全接入 |
| 日历查询/核对/恢复 | 未实现 | C6–C8 完成 |
| 本地操作查询 | 协调器有内部读取方法，无 MCP 工具 | C4 完成，不等待 Garmin 接口 |
| 验证 | 旧报告称 Node22 的 847 测试通过 | 新版本需重新验证，不把旧计数当目标 |

上轮审查现场只复跑了 4 套相关测试：协调器、存储、stdio 通过；锁子进程测试 3 条失败，直接运行 worker 显示缺少 `@esbuild/darwin-arm64`。当时 Node 为 25.2.1。此证据是依赖环境问题，**没有证明 Node25 本身不兼容**。不要据此擅自收窄 engines。

旧报告同时写“标准 build 被守卫阻止”与“pack:smoke/test:distribution 通过”，而后二者都依赖 build。新报告必须区分直接调用底层脚本与完整 npm 命令通过，消除证据歧义。

## 3. 必须复现的漏洞与修复约束

### F1：最早历史记录遮蔽后来的 unknown / succeeded

位置：`src/write-operations/types.ts:131` 的 `findStepByBusinessKey`；`coordinator.ts` 的 `previewSchedule`、`executeSchedule`。

最小顺序：

1. 预览单日 A，暂不确认。
2. 预览批量 A+B，使旧 A 变为 not_attempted。
3. 确认批量，A 成功或 unknown。
4. 再预览/确认 A。

当前扫描首先命中旧 not_attempted，可能再次发出 A。必须分别用 succeeded 和 unknown 两种结果测试，确认 A 总写次数不超过一次。

修复不能只改为“取最新一条”。同一业务键要扫描所有历史步骤和 attempts：任何未决 in_flight/unknown 都优先阻断；明确完成的回执用于历史去重；prepared 由当前预览归属决定。只有已证明未应用的失败/未发步骤才可进入新预览。

建议替换接口：

```ts
type BusinessHistory = {
  unresolved: Array<{ operationId: string; stepId: string; attempt: number }>
  successful: Array<{ operationId: string; stepId: string }>
  prepared: Array<{ operationId: string; stepId: string }>
  retryable: Array<{ operationId: string; stepId: string }>
}
// OperationDocument 为迁移后的完整日志类型。
function collectBusinessHistory(document: OperationDocument, businessKey: string): BusinessHistory
```

历史成功不证明当前日历仍存在：旧幂等键返回历史回执；新业务意图要通过新鲜日历预检判断是否需要写入。查询未就绪时保守阻断/返回历史信息，不能报告当前 `desiredStateSatisfied:true`。

### F2：混合批量丢项并误报成功

位置：`coordinator.ts` 中 `operation.steps = writable.map(...)`；`tool-service.ts` 中确认后的 `execution.receipts.map(...)`。

最小顺序：先产生 unknown A，再预览并确认 A+B，B 成功。修复后必须：

```ts
expect(result.total).toBe(2)
expect(result.results.map(x => x.workoutId)).toEqual(['A', 'B'])
expect(result.success).toBe(false)
expect(result.unknownCount).toBe(1)
expect(result.successCount).toBe(1)
```

父操作保存完整原始条目顺序，包括 write、skip、blocked。推荐给不可写条目引用既有 operationId/stepId，**不要复制 unknown 为另一份可独立修改的尝试记录**。

所有响应路径都返回同一种 batch receipt：首次执行、全跳过、全阻断、部分混合、相同幂等键重放查询、恢复后查询。`results.length === total === 原请求条数`。

- `successCount` 为结果中 succeeded/skipped 数。
- `failureCount = total - successCount`，兼容旧“未确认完成数”，不代表全部可重试。
- `unknownCount`、`notAttemptedCount`、`definiteFailureCount` 分别计算，`skippedCount` 是 successCount 子集。
- 引用既有 unknown 的 blocked 行对外计为 unknown；权限/能力/确认阻断且没发包的行计为 not_attempted，并带阻断原因。
- 当前状态由历史引用解析，不修改原批次请求及历史证据。

### F3：prepared 幂等键无法重新预览

位置：`coordinator.ts:159` 起的幂等键分支。

同一 key 的第一次 preview 已记账，用户没有确认或凭证过期；再次 preview 当前一律返回 `requiresConfirmation:false/action:blocked`，导致合法任务卡住。

修复：同账号、同规范请求且没有 dispatch 的 prepared，可复用 operationId、递增 previewRevision、签发新确认。旧 revision 的确认不可执行；跨进程也要校验 revision，不能仅依赖进程内 Map。

相同 key 不同内容始终 conflict；已发操作返回回执/恢复指引；unknown 不可生成新的写权限。

### F4：复用操作会改写历史请求与幂等键关联

位置：`coordinator.ts` 的 `findReusableOperation` 与 `operation.kind/requestHash/request/steps` 赋值。

当前仅按 prepared 业务键集合复用，可能把旧 key 的操作改绑给新 key，同时遗留旧 idempotencyIndex；还可能用剩余 prepared 子集覆盖旧批次，丢失已执行项。

修复：只复用完整规范请求及身份一致、尚未发出的操作；原 request、kind、幂等键绑定和已执行历史不可变。不同请求建立新 operation，以引用/显式 supersession 处理 prepared 归属。恢复原批次必须沿原 operationId 追加 attempt，不能删除其他步骤。

### F5：幂等键明文与旧日志迁移

位置：`tool-service.ts` 的 canonicalRequest 包含 `idempotencyKey`，随后直接存进 `operation.request`。

修复为只存幂等键哈希。key 属调用方元数据，不能假定永远无敏感内容；但不要把它误称 Garmin 认证凭证。业务规范请求排除 confirmed/confirmationId/idempotencyKey；批准绑定单独包含幂等键哈希与 previewRevision。

必须迁移已有 schemaVersion=1，见 C3。不能只改新写入，导致旧 hash 全部冲突或遗忘 unknown。

### F6：私有存储与内容验证不够

位置：`store.ts` 的 `assertSafePath`、`parse`、best-effort chmod；`lock.ts` 的路径创建。

- 当前只检查末级 root/file 是否 symlink，没有完整父路径、owner/mode、macOS ACL、Windows DACL 校验。
- parse 只验证顶层，operations/steps/attempts/index 被直接类型断言；合法 JSON 的损坏状态可能被当可重试状态处理。
- 32 MiB 只限制 save，不限制读取前检查；目录 fsync 错误全部吞掉。
- 同一锁实例的 tail 排队发生在 5 秒 deadline 之前，因此同进程等待不是有界的。

复用既有 session-store 与平台权限 helper 的真实能力，必要时最小提取公共实现；禁止把 chmod 失败忽略后继续写。校验全部父链与打开后的文件身份，拒绝不安全文件；使用 Zod/等效完整 schema 校验步骤、枚举、索引引用、账号与 businessKey 一致性。损坏日志 fail closed，不“修复为空”。

## 4. 不得再借接口未实现而推迟的任务

以下均不需要真实 Garmin 查询：F1–F6、完整批量记账、本地操作查询、创建/取消日志托管、认证失败前后分类、确认 revision、停止批次、测试夹具、跨平台 CI、文案纠正。

日历查询确实需要协议证据，但“当前 SDK 没有方法”只证明 SDK 缺能力，不证明 Garmin 无接口。必须继续核验公开项目的一手源码或授权的网页只读请求；记录尝试和结论。不得把查看本仓库同一段 adapter 当作端点已被外部验证。

## 5. 统一写入与恢复语义

### 5.1 所有写工具

必须统一进入协调器：

- create_garmin_workout
- schedule_garmin_workout
- batch_schedule_garmin_workouts
- create_and_schedule_garmin_workout
- unschedule_garmin_workout

现存绕过点：`tool-service.ts` 的 `createWorkout`、`createAndScheduleWorkout` 两阶段、`unscheduleWorkout`。客户端保留底层 transport 能力，但 MCP 业务层不得直接绕过协调器调用。

5 个工具均接受可选 idempotencyKey；单日/批量接受 `duplicatePolicy:'skip'|'error'`，默认 skip。相同模板不同日期允许；同日重复不提供强行覆盖开关。

写入约束：

1. 输入及认证预检失败且明确尚未 dispatch，记 failed/not_applied，不把未发请求永久写成 unknown。
2. 在实际发包之前，in_flight 必须成功持久化。
3. 发出后断线、超时、5xx、身份变化或不能证明未应用的错误，记 unknown。
4. POST/DELETE 每次批准尝试最多发一次。SDK/拦截器/DI 刷新不允许重放。
5. 账号锁按实际步骤持有，不锁住整个 100 条批次；锁内做权属复核、in_flight、单次写入和结果提交。
6. 认证失效、调用取消、存储错误、身份变化、确认授权到期时停止后续条目并保留 not_attempted。每步检查授权，不能只在进入批次前检查一次。
7. AbortSignal 取消只代表本地取消，不能证明远端回滚；迟到结果按 operationId/stepId/attempt/身份更新，错误 promise 必须有处理。
8. 远端已成功、本地最终保存失败时仍保留持久的 in_flight 并输出 operationId 的不确定回执，不能让通用 MCP catch 丢掉恢复标识。

创建阶段返回 ID 后先落盘，再排期；后续恢复复用 ID。创建未知 ID 时不按名称猜、不再次创建、不自动删除模板。

取消只针对精确 workoutScheduleId。未知外部 ID 无法核实身份和范围时返回 `SCHEDULE_LOOKUP_UNSUPPORTED`；日志中可靠 ID 和经验证查询可作为定位来源。取消成功后的历史排期回执不删除，但当前状态应重新查询。

### 5.2 查询与证据

CalendarSnapshot 至少包含 range、entries、fetchedAt、complete、missingRanges、warnings；entries 中明确区分 workoutId 与 workoutScheduleId。

- 起止日期包含，最多 366 天；只读查询允许过去。跨月跨年/DST 采用日期运算。
- 验证真实分页/月切片结束条件；缺页、未知 relevant item、截断、游标循环 => complete:false。
- 查询预检不走过期缓存；无受支持查询能力时首次新增排期安全阻断，不盲写。
- 完整空查询可说明“本次完整查询没有看到该目标”，但不能证明一个 unknown POST 从未执行。不要把 complete 定义成“绝对实时与因果确定”。
- 唯一匹配项可报告 observed_present/desiredStateSatisfied:true，但原 unknown attempt 继续保留；除非有可靠回执，不伪称该请求已证实成功。
- 缺席、多个候选、只有同名、未知 ID 或不完整查询都不能自动重发。
- 精确删除 ID 的可靠缺席证据可记录 observed_absent；只在某一天没查到不证明整个账号已不存在该 ID。
- 核对最多 3 次 GET、总预算 20 秒；读取重试受总预算约束，写入永不跟随核对自动重试。

### 5.3 4 个新增 MCP 工具

沿用原规格，最终 14 → 18 个工具：

| 工具 | 参数与行为 | Garmin 写入 |
|---|---|---|
| get_garmin_calendar | startDate/endDate 必填，timezone 可选；返回完整性及排期 | 无 |
| get_garmin_write_operation | operationId 或 idempotencyKey 二选一查详情；都省略时 limit/cursor 分页列本账号操作 | 无，不需要登录 |
| reconcile_garmin_write_operation | operationId；只读查询并保存本地观察，输出下一步 | 无 |
| resume_garmin_write_operation | operationId、confirmed?、confirmationId?；预览安全剩余项，再批准执行 | 有，需要新确认 |

本地查询可立即交付，不能等待日历查询。reconcile 因更新本地日志声明 readOnlyHint:false、destructiveHint:false、idempotentHint:true，描述明确不修改 Garmin。

恢复只包含已证明未应用且原因已修正的 failed、从未发出的 not_attempted、以及创建已成功后尚未开始的排期阶段。unknown 不可恢复写入，变更日期或模板不得隐藏在 resume 中。

工具未完成之前，响应不得指向不存在的工具；阶段版本给可执行的手动检查说明。最终保留 nextAction 为实际存在的工具名或明确 manual_review。

## 6. 逐项执行清单

每项独立提交；遵循“新增失败场景 → 确认在旧代码失败 → 实现 → 回归通过”。代码位置以符号为准，行号仅基线定位。

### C0 — 环境与复现基线

**Files:** package.json、package-lock.json、tests/write-operation-lock.test.ts、tests/fixtures/write-lock-worker.ts、scripts/clean.mjs。

- [ ] 记录当前 HEAD、工作区、node/npm 路径版本、实际依赖状态，不读个人 Token。
- [ ] 优先使用已有 Node22 环境并正常安装锁定依赖，确认 optional 平台 esbuild 包；不要手工乱补版本或把缺依赖误报为代码失败。
- [ ] worker 对任何非预期退出都打印捕获的脱敏 stderr；处理 error/close、信号和超时。锁竞争测试用 ready 握手，不以固定 250ms 猜 worker 已启动。
- [ ] 当前环境如拦截标准 clean，按明确目标、安全批准机制解决；不能改脚本绕过守卫或将直接 tsc 标为完整 build 通过。
- [ ] 跑现有相关测试，保存基线；不要求重新跑 npm ci 多次。

### C1 — 消除历史遮蔽，建立真实回归

**Files:** src/write-operations/types.ts、coordinator.ts；新增 tests/write-history-regression.test.ts。

- [ ] 实现 F1 的 A → A+B → A 复现，分别模拟成功、unknown。改变操作插入顺序也必须得到同样安全结果。
- [ ] 覆盖旧 failed 在前、新 unknown 在后；旧 prepared 在前、新 succeeded 在后；步骤汇总状态与某个历史 attempt 不一致时保守阻断。
- [ ] 以全历史聚合替换 first-match；不能仅倒序扫描。
- [ ] 将 preview 和 execute 的判断复用同一函数，不维护两套优先级。
- [ ] 命令：`npm test -- --runInBand tests/write-history-regression.test.ts tests/write-coordinator.test.ts`。
- [ ] 提交：`fix: prevent historical steps from hiding unresolved writes`。

### C2 — 完整父批次、引用与结果统计

**Files:** types.ts、coordinator.ts、tool-service.ts；新增 tests/write-batch-accounting.test.ts。

- [ ] 测试 unknown A + 新 B、成功 A + 新 B、全 blocked、全 skipped、5 条混合和相同批次 key 再查询。
- [ ] 测试同批请求中输入顺序不丢、父操作记录可在重启后还原全部结果。
- [ ] 完整保存父请求条目与历史引用；统一 aggregateBatchReceipt，所有返回分支调用它。
- [ ] 断言 results 数量、total、各计数与 success，不能只看实际 writer 调用数量。
- [ ] 测试被旧预览 supersede 的步骤仍保留，不能从原批次日志消失。
- [ ] 命令：`npm test -- --runInBand tests/write-batch-accounting.test.ts tests/calendar-regression.test.ts`。
- [ ] 提交：`fix: retain every requested item in batch receipts`。

### C3 — 不可变请求、确认 revision 与旧日志迁移

**Files:** identity.ts、types.ts、store.ts、coordinator.ts、tool-service.ts；新增 src/write-operations/migration.ts、tests/write-operation-migration.test.ts、tests/write-confirmation-lifecycle.test.ts。

- [ ] 测试 key 第一次预览未确认 → 过期 → 同 key 重预览 → 新确认成功，旧确认无效；跨服务实例同样成立。
- [ ] 测试新 key/不同批次不能改写旧 key 的请求、步骤和关联；同 key 不同 payload 返回冲突。
- [ ] 采用新 schemaVersion=2，完整 Zod 校验；增加 previewRevision、完整 batch items/引用及必要身份字段。
- [ ] 在账号锁内做 v1 → v2 原子迁移。保留全部 operationId、stepId、attempt、未知占用、排期 ID 与原批次顺序；记录迁移版本，不自动执行操作。
- [ ] v1 request 的原始 idempotencyKey 只在内存计算验证：校验其哈希/索引，移除明文，重算业务规范 hash。迁移结束 active journal 不含原 key。
- [ ] 旧文件若已因操作复用导致一个 operation 被不一致的多个 key 引用，或批次缺少无法还原的步骤证据，隔离为 manual_review/unknown，保留占用；不根据猜测制造成功。
- [ ] 对尚无 dispatch 的 prepared 重建新预览；有发出可能的记录不能据新字段默认值变成 prepared。
- [ ] 默认不复制含明文的 v1 做长期自动备份；原子替换保证迁移前故障保留旧文件。用户要求备份时按私人数据明确保护和说明，不提交备份。
- [ ] 注入迁移写入/rename 失败验证原文件可用或明确阻断；不创建空日志替代。
- [ ] 命令：`npm test -- --runInBand tests/write-operation-migration.test.ts tests/write-confirmation-lifecycle.test.ts tests/write-operation-identity.test.ts`。
- [ ] 提交：`fix: migrate write journals and bind immutable confirmations`。

### C4 — 存储加固与本地查询工具

**Files:** store.ts、lock.ts、src/session-store.ts/平台权限 helper、src/mcp.ts、src/tool-service.ts、src/index.ts；新增 tests/write-state-security.test.ts、tests/write-operation-query.test.ts。

- [ ] 复用会话存储的私有目录、owner/ACL 校验；完整路径链防符号链接/重解析点问题；不能仅 chmod 后假定安全。
- [ ] 测试错误 owner/mode、macOS 授权 ACL、Windows 非私有 DACL、父目录 symlink、普通文件替代目录、日志文件类型及 schema 内部损坏。
- [ ] 对大小在读取前设界限，32 MiB 以上报明确错误；不无界 readFile。达到上限的已有合法记录不得被删除。
- [ ] 只忽略平台确实不支持的目录 fsync 情况；EIO 等真实持久化失败不能当成功。
- [ ] 同进程队列与跨进程锁共用总等待预算；取消和退出可以中止等待；保留无 TTL 抢占规则。
- [ ] 崩溃后仅在确认没有活跃执行者、获得锁后把遗留 in_flight 标为 unknown；不能在另一个活进程写入时由普通读取改状态。残留锁沿受控离线恢复，禁止自动抢占。
- [ ] 实现 get_garmin_write_operation，详情/分页本地读取不用登录，返回脱敏摘要与可执行 nextAction；不暴露路径、账号哈希、key 原值。
- [ ] 命令：`npm test -- --runInBand tests/write-state-security.test.ts tests/write-operation-query.test.ts tests/write-operation-store.test.ts tests/write-operation-lock.test.ts`。
- [ ] 提交：`feat: harden private state and expose local operation receipts`。

### C5 — 统一 5 条写路径与批次停止

**Files:** coordinator.ts、tool-service.ts、client.ts、errors.ts、mcp-shutdown.ts；新增 tests/write-create-recovery.test.ts、tests/write-unschedule-recovery.test.ts、tests/write-batch-stop.test.ts、tests/write-transport.test.ts。

- [ ] 先证明当前 create-and-schedule 可以绕过排期日志，再将组合工具拆为同一 operation 的 create/schedule 两个阶段。
- [ ] 创建成功后排期 unknown，重启再操作：addWorkout 总数仍 1；创建未知 ID 时换 key 也不重新创建同定义。
- [ ] 独立 create 与组合 create 共用指纹/业务占用；合理定义规范化，保留步骤顺序与默认运动类型，不能只比训练名。
- [ ] 取消进入日志，精确 ID、确认、unknown 占用完整；未核验任意 ID 的能力可以阻断，但不得直接绕过记账 DELETE。
- [ ] 测试未 dispatch 的认证失败记 not_applied；已 dispatch 后认证变化记 unknown；批次随后停止，剩余 not_attempted。
- [ ] 测试确认到期、用户取消、保存失败、进程关闭不继续发下一项；锁覆盖每一写步骤，等待有界。
- [ ] 测试迟到 resolve/reject、AbortSignal、最终落盘失败，确保没有未处理 rejection、重复写入或丢失 operationId。
- [ ] 命令：`npm test -- --runInBand tests/write-create-recovery.test.ts tests/write-unschedule-recovery.test.ts tests/write-batch-stop.test.ts tests/write-transport.test.ts tests/client-interceptor.test.ts tests/di-session.test.ts`。
- [ ] 提交：`fix: coordinate all Garmin writes and stop unsafe batch continuation`。

### C6 — 核验并实现日期范围查询

**Files:** 新建 src/calendar/types.ts、adapter.ts、tests/calendar-query.test.ts、tests/fixtures/calendar/；修改 client.ts、docs/calendar-api-verification.md。

- [ ] 核验锁定 SDK 的实际代码；随后查公开 Garmin 集成维护者的一手实现，记录 URL/提交、方法、字段、分页证据。GitHub 用已授权接口。
- [ ] 分别记录 global/cn 与当前项目认证方式的证据，不能只替换 hostname 就标双地区已通过。
- [ ] 实现已核验范围切片/分页与 CalendarSnapshot；未经证据支持地区返回能力错误。
- [ ] 完整测试跨月跨年、闰日、DST、366/367 天、空响应、缺页、分页循环、错误 ID 类型/大整数精度及计划项。
- [ ] 区分“完整读取时未发现”与“unknown 写一定没发生”，不要按旧报告错误表述永远把空查询设 complete:false。
- [ ] 只因接口证据不足时阻断对应生产适配，继续交付查询模型、模拟和其余任务；若完成公开核验后确需用户会话才可继续，再一次性说明需要的最小只读范围。
- [ ] 命令：`npm test -- --runInBand tests/calendar-query.test.ts tests/client.test.ts`。
- [ ] 提交：`feat: add evidence-backed calendar range inspection`。

### C7 — 新鲜预检、核对与批准恢复

**Files:** 新建 src/write-operations/reconcile.ts；修改 coordinator.ts、tool-service.ts；新增 tests/write-recovery.test.ts、tests/write-preflight.test.ts。

- [ ] 给新排期/恢复步骤接入新鲜日期查询：现有相同条目默认 skip，多条相同目标报 duplicate_existing，不删除。
- [ ] 预览后外部新增变 skip 可减少副作用；预览后 skip 条目被删除变 write 必须新批准，不可扩大旧授权。
- [ ] 历史成功排期后来被手动删除：同 key 返回历史回执，新 key 在完整预检且无未知占用时可新预览；不永远卡在旧 succeeded。
- [ ] reconcile 只注入读取客户端和日志能力，不注入 writer；以接口结构防止隐藏补发。
- [ ] 测试超时后空 → 稍后出现一条、两条候选、仅同名、部分查询失败；均不自动增加 POST。
- [ ] resume 派生候选而不接受替换 payload；失败/未执行安全项新确认，unknown 永不入选。
- [ ] 创建已知 ID 复用；未知 ID 标 manualReviewRequired；取消只用精确缺席证据。
- [ ] 命令：`npm test -- --runInBand tests/write-recovery.test.ts tests/write-preflight.test.ts tests/write-create-recovery.test.ts tests/write-unschedule-recovery.test.ts`。
- [ ] 提交：`feat: reconcile uncertain writes and confirm safe remaining steps`。

### C8 — MCP 公共契约与真实进程故障测试

**Files:** src/mcp.ts、src/index.ts、tests/mcp.test.ts、tests/stdio.test.ts、tests/fixtures/mcp-tools-baseline.json、scripts/verify-distribution.mjs；新增 tests/write-stdio-recovery.test.ts 与隔离 fake Garmin fixture。

- [ ] 完成 18 工具注册，全部 schema 严格，新增公共类型导出，根导入无启动/登录/写盘副作用。
- [ ] 保留原必填参数；5 个工具 idempotencyKey、previewRevision 内部绑定、恢复确认都经过实际 MCP 参数层。
- [ ] fake Garmin 独立于 MCP 子进程持有计数和日历；杀死 MCP 后它仍保留写入结果，才能验证真正重启恢复。
- [ ] 子进程链路覆盖：初始化 → 预览 → 确认 → fake 已写响应丢失 → 重启 → 查本地记录 → GET 核对 → 不重发。
- [ ] 独立进程 A/B 使用不同登录 fixture、共享 state 根和同账号业务键，验证累计 POST，而不只测锁临界区互斥。
- [ ] 在发包前、发包后、成功回执后保存前、批次中途强制退出，断言日志状态与剩余条目。残留锁阻断也算安全分支，必须验证离线处理后仍不会误发。
- [ ] 验证 stdout 仅 MCP 协议、stderr 脱敏、断开/取消/关闭有界。
- [ ] 命令：`npm test -- --runInBand tests/mcp.test.ts tests/stdio.test.ts tests/write-stdio-recovery.test.ts tests/index.test.ts`。
- [ ] 审核 tools/list 字段差异后再更新快照；不得只改预期数量掩盖未实现工具。
- [ ] 提交：`test: verify write recovery across MCP processes and crashes`。

### C9 — 文档与迁移使用说明

**Files:** README.md、README.zh-CN.md、docs/manual.zh-CN.md、docs/migration.md、docs/calendar-write-recovery.md、docs/calendar-api-verification.md、docs/calendar-write-delivery.md、docs/verification.md、CHANGELOG.md、skills/garmin-connect-mcp/SKILL.md、.env.example、package.json、scripts/audit-package.mjs。

- [ ] 清除“同一日期绝不重复”“Garmin 已存在”这类超出作用域的绝对声明；明确本地共享 state 的范围以及当前查询证据。
- [ ] 说明新日志版本如何自动迁移，损坏/歧义如何阻断，用户不能通过删 state 或改 key 解决 unknown。
- [ ] 写出 5 次跑步完整示例：查询 → 预览 → 确认 → 逐项回执 → 查询操作 → 核对 → 仅恢复安全项；周三/周五休息省略。
- [ ] 文案/nextAction 只引用存在的工具；写清 unknown、observed_present、历史 succeeded 的差别。
- [ ] 旧报告保留日期与适用提交，新增本轮结果，不把旧 847 测试结论搬来充数。修正文档自身“完成”的错误判断。
- [ ] 打包包括必要使用/迁移说明；排除真实状态、临时文件、旧私密备份和测试凭证。
- [ ] 提交：`docs: document verified write recovery and migration boundaries`。

### C10 — 干净安装、平台与最终审查

**Files:** .github/workflows/ci.yml、scripts/verify-distribution.mjs、docs/verification.md。

- [ ] Linux Node20/22 全量测试、lint、coverage、pack/runtime-only 安装；macOS/Windows 增加新日志/权限/锁/迁移/stdio恢复用例。
- [ ] Windows 验证真实 DACL、原子 rename、锁 worker 解析和退出；macOS 验证 ACL。不得因平台失败 skip 新核心测试。
- [ ] 以下命令按真实执行结果记录，不能绕过 pre 脚本后标原命令通过：

```bash
npm ci
npm run lint
npm test -- --runInBand
npm run test:coverage
npm run build
npm run pack:smoke
npm run test:distribution
```

- [ ] 阈值不降：statements 75%、branches 70%、functions 65%、lines 78%。核心安全矩阵逐项验收，全局百分比不能代替场景验证。
- [ ] 扫描所有 addWorkout/scheduleWorkout/unscheduleWorkout 调用：MCP 写业务不能漏过协调器；测试/集成脚本的直接调用明确用途和授权边界。
- [ ] 新代码完成后检查差异与测试证据，再做独立审查；不得只审报告。
- [ ] 更新真实交付状态、提交清单、已跑平台和缺失外部证据。按有效授权处理提交/远端；未推送就明确未推送。

## 7. 不能省略的验收矩阵

| 场景 | 通过条件 |
|---|---|
| 单日 A → 扩批 A+B → A 再请求 | 旧 not_attempted 不遮蔽新 succeeded/unknown，A 最多一次写入 |
| 旧失败在前，新 unknown 在后 | 任意插入顺序仍阻断 |
| unknown A + 新 B | total=2、逐条完整、success=false、unknownCount=1 |
| prepared 同 key 确认过期 | 可以新预览；新确认有效，旧 revision 无效 |
| 不同 key / 剩余子集复用 | 不修改旧请求、不丢历史、不错误改绑索引 |
| v1 私密 key、unknown 迁移 | active v2 无明文，未知占用保留，失败不重置日志 |
| JSON 内部损坏/账号错配/非法状态 | 明确 STATE_CORRUPT，不发包 |
| 路径、owner、ACL、跨进程/同进程等待 | 不安全拒绝，等待有界，锁无 TTL 抢占 |
| 创建并排期重启恢复 | 已知模板不重建，未知模板不盲重建 |
| 取消超时 | 持久 unknown，只读核对，不自动 DELETE |
| 批次认证失效/取消/授权到期 | 后续 not_attempted，计数完整 |
| 初次/确认时预检不完整 | 对新增写入 fail closed，不假定空日历 |
| GET 空后迟到出现 | 不因空结果再次 POST |
| 两个真实 MCP 进程 | fake Garmin 实际同业务写入数受控 |
| 进程强杀四个时点 | 重启不自动执行，证据和原条目可恢复 |
| 全量与产物 | 标准命令真实通过、18 工具、无私密文件、三平台证据明确 |

## 8. 交付判定与执行边界

只有 F1–F6、完整批量、所有写工具托管、本地查询、模拟恢复/进程故障验收完成，才能称“本地写入安全与模拟恢复完成”。即使日历接口未核验，缺少这些也只能交付“部分完成”。

“完整功能完成”还要求：已核验地区的日历适配、实际 MCP 核对/恢复入口、文档、干净安装与平台验证；真实 Garmin 验证是独立证据等级，未跑就明确说明。没有服务端幂等机制时不承诺跨设备 exactly-once。

若外部接口确实是唯一剩余阻碍，最终说明查过哪些一手实现、哪项契约不确定、需要何种最小只读授权；不要再把本地查询、CI、创建托管等独立工作列入“需真实接口才可做”。

最终交付必须给出：代码与提交、逐项 C0–C10 状态、上述矩阵结果、标准命令/平台结果、日志迁移说明、18 工具示例、接口证据表、剩余限制，以及至少三段可重现演示（历史遮蔽修复、unknown 混合批量、跨进程核对且不重发）。
