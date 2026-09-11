# Garmin Calendar 写入安全与恢复 Implementation Plan

> **For agentic workers:** 按 `superpowers:executing-plans` 逐项执行（如执行环境提供该技能）。本任务书可独立阅读，不要求访问原聊天。步骤使用复选框跟踪；先写失败测试，再实现、验证和提交。用户指定其他 Agent 执行，本方案编写阶段不修改运行代码。

**Goal:** 修复 Garmin 写入超时后无法确定结果、跨请求重复排期、批量无法安全恢复的问题，保留服务端预览与明确确认，禁止不确定写入被自动重发。

**Architecture:** 在现有 Garmin 客户端与工具服务之间加入日期范围查询、持久化操作日志、账号级跨进程互斥和统一写入协调器。确认授权、操作身份、业务去重分别管理；所有写入通过统一状态机执行，恢复首先只读核对。

**Tech Stack:** 当前 Node.js >=20、TypeScript、Zod、MCP SDK、Axios、Jest；沿用现有 Garmin 登录、脱敏与平台权限实现。默认使用本地文件日志和文件锁，不引入数据库服务，不假定 Node 20 有内置 SQLite。

**Spec:** 本文第 1–9 节是实现规格，第 10–12 节是执行步骤、测试与交付约定。

## Global Constraints

- 项目：`/Users/chuanxing/garmin-connect-mcp`；公开仓库：`xcbbc21/garmin-connect-mcp`。
- 本文核对基线：`67f5ec92bfc680a9114c9184a70dbbfd1e973331`，包版本 `0.2.0`。执行时重新检查实际 HEAD 与用户改动，不重置工作区。
- 所有 GitHub 相关动作走用户已授权接口；不得查找、输出或另行索取已有凭证。本文不构成新的推送、合并、发布授权。
- 保持独立本地 stdio MCP；不恢复 DSH、Cordis、React 或客户端专用适配。
- 包继续 `private: true`，本轮不发布 npm。
- 保留已有工具名称、必填参数与正常成功字段。允许增加可选参数、状态字段和新工具；必须明确记录行为变更。
- 保留一次性确认、10 分钟有效期、内容绑定；确认凭证与幂等键不得混用。
- 禁止对 POST/DELETE 自动重试，包括 Axios 拦截器、认证刷新、SDK 内部、工具层、批量恢复层的隐式重放。
- 休息日不创建 workout；训练步骤里的合法 `rest` 必须保留。
- 不修改真实 Garmin 数据来完成自动化测试。真实账号写入验收需要用户单独明确授权，且清理删除也必须在授权范围内。
- 不承诺服务端 exactly-once。没有 Garmin 服务端幂等机制时，本方案只能提供明确边界内的防重复与保守恢复。
- 不能验证的接口返回明确能力错误；不伪造 URL、字段、成功结果或“已实测”的声明。

---

## 1. 已确认的问题与定位

执行前重读以下方法；行号会漂移，以方法名为准。

| 文件 / 符号 | 基线行为 | 修复要求 |
|---|---|---|
| `src/tool-service.ts` / `scheduleWorkout` | 预览只查训练库；确认后直接排期 | 查询目标日期，识别已存在项，进入日志与状态机 |
| 同文件 / `validateBatchScheduleRequest` | 只用当前数组内的 Set 去重 | 保留该校验，另加跨工具、跨请求与跨进程业务去重 |
| 同文件 / `batchScheduleWorkouts` | 逐条执行，所有异常都标记 `success:false` | 区分明确失败、不确定、未执行；按条恢复 |
| 同文件 / `createWorkout`、`createAndScheduleWorkout` | 缺少持久化创建阶段；可能重复创建模板 | 创建也必须记账，已知 workoutId 不重复创建 |
| 同文件 / `consumeCalendarConfirmation`、`consumeWorkoutConfirmation` | 进程内 Map；取出后删除 | 继续禁止凭证重放，但持久化操作不随 Map 消失 |
| `src/client.ts` / `calendarWrite`、`addWorkout` | 已禁止工具层自动写入重试；异常主要是文本 | 引入可判定的写入结果类型与证据分类 |
| 同文件 / `withRequestTimeout` | `Promise.race` 超时，不等于底层请求已终止 | 增加可用的取消与迟到结果处理；取消不等于远端回滚 |
| 同文件 / `installSafeResponseInterceptor`；`src/di-session.ts` | 只允许 GET/HEAD/OPTIONS 重放 | 保留并测试该边界，不因重构放宽 |
| `src/mcp.ts` | 单日工具描述声称相同 workout/date 会拒绝，但基线代码没有跨请求保证 | 修正文案，描述实际默认跳过/阻断规则 |

特别纠正：当前锁定的 `garmin-connect@1.6.2` 由本项目通过认证后的 Axios 适配排期端点，不能沿用早期讨论中“已直接调用 SDK 的 scheduleWorkout”的假设。执行 Agent 应核对实际安装包及锁文件；若新版 SDK 有对应方法，先评估行为兼容，不为本任务随意升级整个依赖树。

## 2. 完成后的用户行为

1. 查询某个日期范围内的 Garmin 训练排期，而不是下载账号全部历史。
2. 同一 workoutId 在不同日期可安排；同一账号、相同 workoutId、相同日期默认只保持一条目标排期。
3. 重复请求返回已有操作/已存在排期，不再发出相同写入。
4. 超时返回 `unknown` 和可持久查询的 `operationId`，而不是笼统“失败，请重试”。
5. 用户可查询操作状态、只读核对不确定结果；仅对有证据可安全执行的剩余步骤重新预览、确认。
6. 批量结果逐条列出成功、跳过、明确失败、未执行、不确定；不会整批重发。
7. 重启、关闭客户端或更换同一账号的登录别名后，已有写入记录不会因此失效。

### 明确不做

- 不新增后台定时器无限重试，不做远程服务或跨设备分布式锁。
- 不自动清理已有重复排期，不自动回滚已成功的批量项，不删除孤立训练模板。
- 不用“训练名称相同”判定同一模板，不用 HTTP 状态码猜测每一种远端错误都未写入。
- 第一版不提供 `force=true`、`allowDuplicate=true`、`forgetUnknown=true` 等绕过安全约束的快捷开关。
- 如果未知结果无法得到可靠证据，可以持续阻断该业务动作；可恢复性不能以重复写入风险为代价。

## 3. Garmin 查询适配与证据门槛

### 3.1 接口核验先行

创建 `docs/calendar-api-verification.md`，记录核验日期、依赖版本、来源链接/提交、请求方法、路径、响应字段、分页终止条件、地区与认证类型的证据等级。

- 首先检查本地依赖源码及项目既有认证适配。
- 若缺少日历查询能力，使用已授权网络访问核对 Garmin 网页实际协议或开源维护者的一手实现。GitHub 内容只走已授权接口。
- 分别核实 global / cn；同样的路径不能自动推出两个地区都验证成功。
- 区分 Calendar 项 ID、workoutId、workoutScheduleId、已完成活动 ID；不把通用 `id` 无依据转换为取消排期 ID。
- 核实分页/月切片、月份编号、范围端点是否包含、训练计划项与独立 workout 的区别、重复响应、空响应和数据截断。
- 核实是否存在按排期 ID 查询的能力、是否可确认明确不存在；只有月查询时，不得宣称任意 ID 可直接查到。
- 对未支持地区返回 `CALENDAR_QUERY_UNSUPPORTED`。其新增排期默认安全拒绝，不能悄悄降级为盲写。
- 查询实现可由源码契约与模拟测试交付，但报告必须标注“未做真实账号验证”；真实数据样本必须脱敏。

### 3.2 归一化模型

新增 `src/calendar/types.ts`：

```ts
export interface CalendarRange {
  startDate: string
  endDate: string
  timezone: string
}

export interface CalendarEntry {
  date: string
  kind: 'workout' | 'other'
  workoutId: string | null
  workoutScheduleId: string | null
  title?: string
}

export interface CalendarSnapshot {
  range: CalendarRange
  entries: CalendarEntry[]
  fetchedAt: string
  complete: boolean
  missingRanges: Array<{ startDate: string; endDate: string }>
  warnings: string[]
}

export interface CalendarReader {
  getCalendarRange(range: CalendarRange): Promise<CalendarSnapshot>
}
```

规则：

- 入参严格真实公历 `YYYY-MM-DD`，起止包含；允许查询过去，不能复用“排期必须今天以后”的限制。
- 单次公开查询最多 366 天；先校验再访问网络。跨年、闰年与 DST 使用日历日期运算，不通过 `toISOString().slice(0,10)` 转换本地日期。
- 根据接口的真实能力完整遍历每个子范围/分页；设置总页数与响应大小上限。达到上限、游标循环、缺页、相关条目无法解析时 `complete:false`。
- 有界查询内也可能存在不支持的训练计划项。保留最少元数据及警告，不能把不确定的 workout 项丢弃后声称完整。
- 内部去重预检绕过活动/训练库缓存。公开工具同样默认新鲜读取，不提供由客户端传入 `complete:true` 的通道。
- 只有完整范围查询才可用于判定“未发现”；即使完整查询没有发现，也不证明超时请求从未执行。
- 存在一条明确匹配项可以证明该目标现在存在，即使其他页失败；不能据此宣称“没有其他重复项”或“本次请求执行成功”。
- 不向工具返回完整原始日历内容、定位信息、账号标识或网络响应对象。
- 批量稀疏日期按相关月份/连续范围查询，不因为两个日期相距一年而抓取所有中间日历。

## 4. 操作身份、账号范围与确认绑定

### 4.1 三种标识分工

| 标识 | 作用 | 规则 |
|---|---|---|
| `confirmationId` | 用户批准某份预览 | 一次性、10 分钟、绑定实际执行内容；不持久化成长期授权 |
| `operationId` | 服务器生成的 UUID | 持久化操作回执；用于查询、核对、恢复 |
| `idempotencyKey` | 调用方可选的稳定请求标识 | 同账号内唯一绑定一种操作及规范化参数；不是权限凭证 |

给 5 个现有写工具增加可选 `idempotencyKey`（单日、批量、创建、创建并排期、取消）。长度 1–128，仅允许 `[A-Za-z0-9._:-]`；非法值在访问 Garmin 前拒绝。不包含密码、邮箱或训练明文；日志中不输出原值。

调用方使用幂等键时，预览与确认必须传同一个值。相同键、不同参数返回 `IDEMPOTENCY_CONFLICT`，不生成新写入。省略幂等键的旧调用仍可用：服务器生成 operationId，业务键仍提供跨请求防重。

普通工作流不改变“确认凭证重放报错”语义。丢失结果的调用方使用查询工具；不要为了返回缓存结果而让旧确认凭证重新获得写权限。新的预览可以发现已存在操作并返回 `requiresConfirmation:false` 的安全 no-op。

同一请求只有 prepared、从未 dispatch 时，允许重新生成预览并签发新确认；继续使用原 operationId，更新预览 revision，并使旧预览不能新增写入。进程重启不恢复任何未消费确认凭证。

### 4.2 账号隔离

- 状态根目录独立于 session 文件路径和 `GARMIN_ACCOUNT` 登录别名。
- 新配置 `GARMIN_STATE_DIR` 为绝对、本地、私有路径；默认使用既有平台配置根解析规则下的 `garmin-connect-mcp/state`。
- 默认账号键为 `sha256(region + '\0' + username.trim().normalize('NFKC').toLowerCase())`，与现有会话用户名规范化规则一致；不另改会话格式。
- 认证后若可取得已核验的稳定 Garmin profile 标识，在日志账号头存哈希并校验一致性；不输出原 ID。不凭空假定任何 profile 字段稳定。
- 同地区、同规范用户名、不同登录别名/独立会话共享操作日志，但不共享或拷贝刷新 Token。
- 账号/地区不匹配时拒绝读取另一账号的记录或执行旧预览；身份变化必须使当前确认失效。
- 一个 Garmin 账号通过不同登录名被访问、不同操作系统用户、不同机器或不同 state 根目录，不在默认本地互斥保证内。文档必须明确，不能称“全客户端全局去重”。
- 不自动迁移/合并不同身份键；若将来用 stable profile ID 合并命名空间，须另做原子迁移与锁定设计。

### 4.3 业务键

```text
schedule:   accountKey + workoutId + localDate
unschedule: accountKey + workoutScheduleId
create:     accountKey + canonicalWorkoutDefinitionHash
```

- 单日、批量子项、创建并排期的排期阶段使用同一个 schedule 键空间。
- 时区参与批准内容哈希和“今天”的判断，但不进入同一 workout/date 的业务去重键，否则换个时区就能绕过。
- 库模板指纹使用规范化训练定义，补齐真实默认值并保留步骤顺序；不能只哈希名字。`confirmed`、`confirmationId`、`idempotencyKey` 等控制字段不得混入训练定义。
- 批量父请求保留原始顺序参与授权内容哈希；每项另持有稳定业务键，不用数组下标作为跨请求去重依据。
- 新请求遇到该业务键的 `in_flight` / `unknown` 时，返回已有操作并阻断；换幂等键、换工具或重启不能绕过。
- 旧成功操作是历史回执，不是当前日历真相。同一个幂等键永远不重新写；全新的请求必须新鲜预检：若排期已被用户删除，且无未决写入，可重新预览后安排。
- 初版默认不重复创建完全相同模板：有已知 ID 时查详情并返回已有模板。不要用一页训练库查询缺失认定模板已被删除。创建未知、缺少 ID 时保持阻断，不能靠改幂等键再创建。

### 4.4 预览与执行

- 预览可执行只读查询并写本地 prepared 记录，但绝不写 Garmin。
- 预览返回 operationId、过期时间、时区、每项动作 `write` / `skip_existing` / `blocked` 及阻断原因。
- 默认 `duplicatePolicy:'skip'`；可选 `'error'`。新增于单日/批量工具，默认跳过已存在目标；禁止默默删除多余项。
- 发现同日同模板多条排期时返回 `DUPLICATE_EXISTING` 与已验证排期 ID，不新增；不要从多条中随便挑一条作为本次写入结果。
- 确认绑定 operationId、账号、规范化请求、预览执行动作和恢复候选集；可选策略也必须绑定。
- 确认时在锁内重新检查日志与新鲜日历。由 write 变 skip 是减少副作用，可以 no-op；由 skip/blocked 变 write、替换目标、增加条目，必须重新预览和确认。
- 批量已确认但尚未发出的条目不永久授权。恢复会重新确认；跨过有效日期/确认期/账号变化时，不继续发出剩余写入。

## 5. 持久化、锁与状态机

### 5.1 默认存储实现

新增 `src/write-operations/`，按账号一个有版本号的 JSON 日志。使用统一仓库实例，所有读改写通过账号锁；存储适配可注入测试，但生产不能静默退回内存。

- 文件格式带 `schemaVersion:1`、单调 revision、账号绑定、操作记录及幂等键映射。
- POSIX 新目录 0700、文件 0600；macOS ACL / Windows 私有 DACL 复用现有平台校验能力。确需抽公共 helper 时保留认证模块原行为与回归测试。
- 原子写入：同目录唯一临时文件 → 完整 JSON → `FileHandle.sync()` → 原子 rename → 平台支持时同步目录。Windows 覆盖语义必须实测，不用先删除原文件的非原子方案。
- 拒绝不安全路径、符号链接文件、权限错误、损坏 JSON、未知 schema 和账号不匹配。失败必须 fail closed，不能重建空日志后继续写 Garmin。
- 日志只存完成恢复所必需的规范化参数、ID、状态、证据和脱敏错误；不存 Cookie、Token、密码、原始响应。训练定义也是私人数据，不能进入提交、包和 CI 产物。
- 首版不自动删除记录、不设 unknown 自动过期。设置 32 MiB 文件上限，达到上限阻止新写并保留读取/导出诊断；报告清楚需要后续受控归档，不能因容量静默遗忘去重键。
- 初始化失败、落盘失败、锁失败时绝不向 Garmin 发新写入。远端已响应成功但本地提交失败时，利用已持久化 in_flight 记录阻止重发，报告持久化异常而不是让调用者重新提交。

### 5.2 跨进程互斥

- 账号级排他锁覆盖每个实际写步骤的“预检 → 持久化 in_flight → 发出一次请求 → 持久化结果”。批量按步骤获取锁，避免一次锁住全部 100 条。
- 文件锁采用原子独占创建，记录 owner UUID / PID / 进程启动时间信息；释放仅允许持有相同 owner token 的进程。
- 加锁等待有界（默认 5 秒），忙时返回 `OPERATION_BUSY`，不另发请求。
- **不使用按时间自动抢占的 lease。** 进程暂停后可能恢复，旧持有者仍可能发请求；没有服务端 fencing 时，TTL 过期不等于可安全接管。
- 首版残留锁保守拒绝自动清除。提供文档化离线恢复步骤：停止该账号的所有 MCP 进程 → 验证 owner 进程已退出 → 备份日志 → 仅把该账号确切锁文件/目录移到隔离备份 → 重启并只做 reconcile。不得删除 state 根目录。
- 进程崩溃遗留的 in_flight 转为 unknown，永远不当成未执行。仅 prepared 且从未进入 dispatch 的记录可在新确认后执行。
- 启动只加载/校验日志，不联网写 Garmin，不自动执行挂起批次。

### 5.3 类型与状态语义

新增 `src/write-operations/types.ts`，至少定义：

```ts
export type WriteKind = 'create' | 'schedule' | 'unschedule' | 'create-and-schedule' | 'batch-schedule'
export type StepStatus = 'prepared' | 'in_flight' | 'succeeded' | 'skipped' | 'failed' | 'unknown' | 'not_attempted'
export type WriteEvidence = 'response' | 'observed_present' | 'observed_absent' | 'none'

export interface WriteAttempt {
  attempt: number
  outcome: 'in_flight' | 'succeeded' | 'failed' | 'unknown'
  startedAt: string
  finishedAt?: string
  errorCode?: string
}

export interface WriteStep {
  stepId: string
  businessKey: string
  kind: 'create' | 'schedule' | 'unschedule'
  status: StepStatus
  attempt: number
  dispatchedAt?: string
  workoutId?: string
  workoutScheduleId?: string
  date?: string
  evidence: WriteEvidence
  errorCode?: string
  desiredStateSatisfied?: boolean
  observedAt?: string
  attempts: WriteAttempt[]
}

export interface WriteOperation {
  schemaVersion: 1
  operationId: string
  kind: WriteKind
  accountKey: string
  requestHash: string
  idempotencyKeyHash?: string
  request: Record<string, unknown>
  createdAt: string
  updatedAt: string
  steps: WriteStep[]
}
```

状态转换原则：

```text
prepared --批准且写前落盘--> in_flight --明确成功回执--> succeeded
                                   --已证明未应用--> failed
                                   --超时/崩溃/断线--> unknown
prepared --发现目标已存在且无需写入------------------> skipped
unknown  --发现目标存在/缺席的有效证据--------------> 记录观察结果
failed / not_attempted --新预览+确认----------------> 新 attempt
unknown  --只因等待变久或查到空数组-----------------> 禁止重发
```

`failed` 专指有证据未应用该步骤；其余保守归 unknown。`skipped` 表示目标已满足但本次没发写入，不冒充本请求执行成功。

对于“提交后未知、后来只看到一条匹配排期”，记录 `observed_present` / `desiredStateSatisfied:true`，但该尝试仍保留 unknown，不伪造本次服务器执行证据；界面解释为“目标已存在，本次请求是否造成它仍不确定，无需补发”。单纯观察不会增加 successCount，只有可靠回执才把原尝试转为 succeeded。查询结果没有完整性、存在多个候选或条目缺 ID 时，不标记可靠的排期回执。任何仍 unknown 的尝试继续占用业务键，即使远端目标后来被手动删除，也不能自动再发。

### 5.4 统一错误契约

新增 `src/write-operations/errors.ts`，使用有类型的错误而非解析中文/英文 message：

```ts
export type WriteOutcome = 'not_applied' | 'unknown'
export class GarminWriteError extends Error {
  constructor(
    public readonly code: string,
    public readonly outcome: WriteOutcome,
    message: string,
  ) { super(message) }
}
```

- 本地输入校验失败、连接/认证预检失败且尚未 dispatch：not_applied。
- 确认后的请求发出之前，先持久化 in_flight；该记录与实际发包之间崩溃也保守 unknown。
- 超时、连接重置、响应损坏、已发请求期间认证变化、一般 5xx：unknown。
- HTTP 4xx/429 是否 not_applied 取决于该端点已验证语义；没有证据时保守 unknown。尤其不能把所有 401/403 转成“写入之前已过期”。
- 拦截器只保留安全的状态码、超时标志与已验证证据，不重新暴露原始 Axios error/request/response。
- 支持 AbortSignal 的 transport 在超时/退出时取消本地等待与请求；即使取消成功也不认定 Garmin 撤销了写入。
- 原 `Promise.race` 的迟到 promise 必须有错误处理，避免 unhandled rejection。迟到回执只能通过 operationId + stepId + attempt + 账号/身份校验更新日志，不能覆写新 attempt；无法安全处理则保留 unknown 并查询核对。
- 有界关闭，不因底层悬挂请求永久卡住；退出前尽力保存 unknown。不能把关闭清理解释为远端回滚。

## 6. 核对与安全恢复规则

### 6.1 单日排期

首次写入前：新鲜查询覆盖该日；若完整且未发现冲突、也无本地未决业务键，允许已确认的 POST 一次。任何预检不完整则不发出新写。

超时后：最多进行 3 次只读查询（立即、约 1 秒、约 3 秒，测试注入时钟，不硬等待）；总核对时间上限 20 秒，尊重 429 和取消。不允许每次 GET 自带无限重试叠加预算。预算耗尽返回 unknown，用户之后可再次只读核对。

- 已有已知排期 ID：优先准确查询/匹配该 ID。
- 无已知 ID：匹配账号、日期、workoutId，并与写前候选集对照。只有目标唯一且有可靠 ID，才记录观察到的目标满足；不宣称因果归属。
- 没查到、只查到同名模板、查询失败、候选多条：不重写。
- 原请求仍可能在远端迟到执行时，即使用户已手动安排一个匹配项，也不能解除对相同业务键的后续盲写限制；保留原尝试的不确定证据与风险说明。

### 6.2 取消排期

- 取消只针对精确 workoutScheduleId，不以训练名/日期批量删除。
- 预览优先从可信日历查询或日志解析出该 ID 对应日期与训练；查不到对应范围时，可新增可选 `date` / `timezone` 帮助定位，但不能猜 ID 的含义。
- 若适配支持可信的按 ID 查询并确认不存在，返回 `already_absent`，不再 DELETE。
- 只有日期查询时，“该日未发现”不证明此 ID 在其他日期不存在或未被移动；需接口证据足以确定，才可报告目标缺席。
- DELETE 超时同样 unknown。后续若精确 ID 查询证明缺席，可以记录 `observed_absent`，但不能断言一定是本次删除造成。
- 不能核验任意外部排期 ID 时，返回 `SCHEDULE_LOOKUP_UNSUPPORTED`；旧工具输入仍可解析，但安全行为收紧必须写入迁移说明。

### 6.3 创建与创建并排期

- `create_garmin_workout` 与组合工具共用创建阶段协调器，不能留下独立创建的超时重试漏洞。
- 创建回执有有效 ID：先持久化该 ID，再进入排期阶段；即使排期失败、重启，恢复只复用此 ID。
- 创建返回 2xx 但无可靠 ID：记录“收到创建响应、ID 未知”，不可排期，不得再次创建。
- 创建超时且不知道 ID：保持创建阶段 unknown；除非后续有可信关联证据，不自动匹配训练库。不能用名称或一页搜索结果解决。
- 训练定义中加入自定义关联标记只有在 Garmin 支持且用户预览明确可见时才可另行设计；本轮默认不改用户训练名称/描述来偷偷注入标记。
- 已创建模板仍保留；不把批量补偿删除作为隐式“修复”。

### 6.4 批量

- 保留 1–100 条、批内重复拒绝、原请求顺序和省略休息日。
- 父记录包含所有子项；每项在发包前单独落盘。逐项提交结果，MCP 响应丢失也可查询父记录。
- 独立业务键上的一条 unknown 可继续处理其他已批准项；同业务键不继续。
- 遇到账号变化、认证失效、存储不可写、锁丢失、调用取消或确认授权过期，停止发出后续写入，剩余标记 not_attempted。
- 汇总新增 `unknownCount`、`skippedCount`、`notAttemptedCount`、`definiteFailureCount`。
- 兼容旧字段：`successCount` 为目标已满足的 succeeded + skipped；`failureCount = total - successCount` 为旧客户端的“未确认完成数”，并非确定失败数。`success` 仅在每项目标均已满足时为 true。文档要求新客户端依据逐项 status / definiteFailureCount 判断，不能拿 failureCount 重试。
- 恢复只选择 failed 中已证明未应用且条件已修正的项，以及 not_attempted 项；已成功、已跳过、仍 unknown 项不会发写入。重新预览显示准确候选集，用户再次确认。
- 全部操作的原始请求不可变；恢复是相同 operationId 下追加 attempt 与证据，保留审计历史，不清空原记录。

## 7. MCP 工具契约

保留 14 个现有工具，新增下列 4 个，目标工具总数为 18。不要机械替换历史所有“14”文字；当前功能清单与基线更新，历史报告保持适用版本。

### 7.1 `get_garmin_calendar`

```json
{
  "startDate": "2026-09-14",
  "endDate": "2026-09-27",
  "timezone": "Asia/Shanghai"
}
```

- startDate / endDate 必填，timezone 可选，默认主机时区；范围最多 366 天。
- 返回 CalendarSnapshot；范围失败可以给 partial snapshot，但必须 `complete:false`。完全不可用返回能力或认证错误。
- `readOnlyHint:true`、`destructiveHint:false`、`idempotentHint:true`。

### 7.2 `get_garmin_write_operation`

```ts
type GetWriteOperationArgs = {
  operationId?: string
  idempotencyKey?: string
  limit?: number
  cursor?: string
}
```

- operationId 与 idempotencyKey 二选一查询详情；不能同时传。详情模式拒绝 limit/cursor。
- 两者均省略时分页列出当前账号本地操作摘要，默认 20，最大 100；用于响应丢失且未记录 operationId 的情况。
- 游标为有界、可校验的本地分页标识，不接受路径；记录变化导致游标过期时要求重新列出。
- 只读本地日志，不联网、不修改 Garmin、不自动启动登录。账号作用域来自配置，不让调用方传任意 accountKey。
- 返回状态、阶段、结果 ID、证据、下一步与 `canResume`，不返回确认 Token、私有路径、幂等键原值或账号哈希。
- 读取其他账号/不存在记录统一 `OPERATION_NOT_FOUND`，避免泄露。
- 只读 annotations 同上。

### 7.3 `reconcile_garmin_write_operation`

```json
{ "operationId": "<服务器返回的 UUID>" }
```

- 仅从 Garmin GET 查询，绝不 POST/DELETE；将可信观察结果写入本地日志。
- 已完成操作重复核对也不发写；历史回执与当前观察状态分开表达，不因远端手动删除覆写历史成功。
- 创建阶段没有可关联 ID 时返回 `manualReviewRequired:true`，不能伪装成恢复成功。
- 因修改本地日志，annotations 使用 `readOnlyHint:false`、`destructiveHint:false`、`idempotentHint:true`；description 明确“不修改 Garmin，只查询并更新本地恢复记录”。

### 7.4 `resume_garmin_write_operation`

```ts
type ResumeWriteOperationArgs = {
  operationId: string
  confirmed?: boolean
  confirmationId?: string
}
```

- 初次调用生成恢复预览，返回将执行的 stepId、复用的 workoutId、跳过/阻断项和新的 confirmationId。
- 确认绑定候选集及记录 revision；候选集改变或新增副作用需要重预览。
- 不能恢复未知步骤，不能把新 confirmationId 当作解除 unknown 的手段。
- 原日期已过期时阻断，不悄悄改为今天；修改日期是新的用户请求，且不得顺便重建未知模板。
- 写 annotations 保持 `idempotentHint:false`；虽然本地防重，不能向客户端宣称无条件可安全自动重试。

### 7.5 现有写入结果扩展

统一增加以下字段，保留原来的 workoutId、date、timezone、workoutScheduleId 等成功字段：

```json
{
  "success": false,
  "operationId": "<UUID>",
  "status": "unknown",
  "desiredStateSatisfied": false,
  "evidence": "none",
  "canResume": false,
  "manualReviewRequired": false,
  "errorCode": "WRITE_OUTCOME_UNKNOWN",
  "nextAction": "reconcile_garmin_write_operation"
}
```

- 状态结果采用正常结构化工具响应（沿用现有 JSON text content，支持时同步 structuredContent），不要让 MCP 通用 catch 吞掉 operationId。
- 入参、确认凭证错误继续 `isError:true`；已进入写流程的失败/未知必须保留可恢复回执。认证提示可并存，但不能登录后自动重放原写入。
- 定义稳定 errorCode 枚举，至少包含本文提到的代码和 `STATE_UNAVAILABLE`、`STATE_CORRUPT`、`CALENDAR_INCOMPLETE`、`CONFIRMATION_INVALID`、`CONFIRMATION_STALE`、`WRITE_NOT_APPLIED`。

## 8. 文件边界与公共接口

新增文件：

| 文件 | 单一职责 |
|---|---|
| `src/calendar/types.ts` | 日期范围与查询结果类型 |
| `src/calendar/adapter.ts` | 已核验的 Garmin 端点、分页、数据映射；不负责确认 |
| `src/write-operations/types.ts` | 操作、步骤、结果类型 |
| `src/write-operations/identity.ts` | 规范化、请求哈希、账号键和业务键 |
| `src/write-operations/errors.ts` | 安全错误分类 |
| `src/write-operations/store.ts` | 日志校验、原子持久化和查询 |
| `src/write-operations/lock.ts` | 跨进程锁；不自动抢占 |
| `src/write-operations/coordinator.ts` | 统一写前保护、阶段执行和回执 |
| `src/write-operations/reconcile.ts` | 只读证据核对，不接收写 transport |
| `docs/calendar-api-verification.md` | 接口证据与地区边界 |
| `docs/calendar-write-recovery.md` | 架构、恢复操作与限制 |

修改文件：`src/client.ts`、`src/tool-service.ts`、`src/mcp.ts`、`src/config.ts`、`src/index.ts`、`.env.example`；必要时最小修改 `src/utils/errors.ts`、`src/session-store.ts` 的共享 helper、`src/mcp-shutdown.ts`。认证会话文件格式不变。

公共边界要求：

```ts
// identity.ts
export function canonicalJson(value: unknown): string
export function requestHash(value: unknown): string
export function accountKey(username: string, region: 'global' | 'cn'): string
export function scheduleBusinessKey(account: string, workoutId: string, date: string): string

// store.ts：事务 callback 内禁止联网；长网络步骤由外层账号锁持有。
export interface OperationDocument {
  schemaVersion: 1
  revision: number
  accountKey: string
  operations: Record<string, WriteOperation>
  idempotencyIndex: Record<string, string> // idempotencyKeyHash -> operationId
}
export interface OperationStore {
  read(): Promise<OperationDocument>
  save(document: OperationDocument): Promise<void>
}

// lock.ts
export interface AccountLock {
  runExclusive<T>(task: () => Promise<T>): Promise<T>
}
```

- `save` 只能由持锁的协调器调用；文件 revision 与原子替换检查必须测试。不要单独加一个可随意调用的无锁写日志入口给 MCP。
- 新的恢复 attempt 追加到 attempts，旧记录不覆盖；同一 attempt 的终态推进也保留必要观察时间。日志中的请求、已发出步骤和历史结果不能被调用方替换。
- 给 GarminDataClient 增加 `getCalendarRange`，由 GarminClient 实现。查询适配只接收现有经过认证/脱敏的 transport，不重新实现登录。
- GarminToolServiceOptions 增加可选 stateDirectory 和测试依赖注入；生产未指定时解析默认持久目录，绝不能默认 in-memory。
- 现有测试的内存模拟要显式注入临时目录/测试 store；不要让单测污染用户默认状态目录。
- 在 GarminToolService 上新增 `getCalendar`、`getWriteOperation`、`reconcileWriteOperation`、`resumeWriteOperation`，MCP 注册只是参数/schema 和调用转发，不再复制业务逻辑。
- 如执行时调整文件拆分，保持以上职责和安全约束，并在交付说明列出实际映射，不进行无关全仓重构。

## 9. 参考执行算法

以下是顺序约束伪代码，不是可直接粘贴的完整函数；具体函数放入上述协调器。

```text
preview(request):
  校验参数并构造不可变规范请求；解析账号
  加账号锁，读取日志并检查 key 冲突及未决业务键
  读取所需的新鲜日历/训练详情，计算每项 write/skip/blocked
  原子保存 prepared 操作及动作集；签发短期一次性确认
  返回完整预览（不调用 Garmin 写接口）

confirm(request, confirmationId):
  校验并消费凭证；不允许凭证重放
  逐项加账号锁：
    读取最新日志，复核账号、幂等键、业务键、授权和新鲜目标状态
    若新状态需要增加批准之外的写入：返回需要新预览
    若已满足：保存 skipped；若未知冲突：不发包
    原子保存 in_flight + attempt（必须成功后才能下一步）
    发出一次 Garmin 写请求
    以类型化结果保存 succeeded / failed / unknown
  返回持久化回执；MCP 断开不改变已发生的写入

reconcile(operationId):
  验证当前账号及日志；仅查询必要范围/精确 ID
  在预算内收集证据，不调用任何写方法
  加锁校验 revision/attempt，保存观察或明确结果
  无证据则保持 unknown，不因空数组解除业务键占用

resume(operationId):
  从记录派生可恢复项，不接收调用方提供的替换训练定义
  对失败原因已修正且已证明未应用的项/从未执行的项生成新预览
  新确认通过后沿 confirm 路径执行；跳过成功项，阻断 unknown
```

请求间竞态不能靠预览锁消除；真正执行前的复核、in_flight 落盘与写入必须在同一互斥范围。只读查询可以重试，写入不可以。

## 10. 逐项实施任务

每个任务按“失败测试 → 单项运行确认失败 → 最小实现 → 同一测试转绿 → 检查差异 → 独立提交”执行。下面命令在项目根目录运行；实际基线有变化时先记录差异。

### Task 0：冻结兼容基线与接口证据

**Files:** 读取第 1 节文件、`tests/fixtures/mcp-tools-baseline.json`、`package-lock.json`、`scripts/integration-test.ts`；新增 `docs/calendar-api-verification.md`。

- [ ] 记录 HEAD、工作区改动、Node/npm 版本、当前工具列表与输入 schema。
- [ ] 执行 `npm ci`、`npm run lint`、`npm test -- --runInBand`、`npm run test:coverage`，记录当前真实结果，不能沿用旧测试计数。
- [ ] 完成第 3.1 节证据表，固定测试 fixture 的来源；未验证能力明确标为未验证，不编造响应。
- [ ] 新建 query fixture 时只保留必要字段，替换个人训练名称和全部标识。
- [ ] 证据不足时仍可实现日志、状态机和模拟查询，但对应生产地区保持能力阻断；不得以模拟通过宣称端到端 Garmin 通过。

### Task 1：查询模型与适配

**Files:** 创建 `src/calendar/types.ts`、`src/calendar/adapter.ts`、`tests/calendar-query.test.ts`、`tests/fixtures/calendar/`；修改 GarminClient / GarminDataClient。

- [ ] 在查询测试中建立可注入的分页 transport；覆盖跨月、第二页失败、重复游标及空页。
- [ ] 核心断言应包含：

```ts
expect(snapshot.range).toEqual({ startDate: '2026-09-30', endDate: '2026-10-02', timezone: 'Asia/Shanghai' })
expect(snapshot.complete).toBe(false) // 当 10 月读取失败
expect(snapshot.missingRanges).toContainEqual({ startDate: '2026-10-01', endDate: '2026-10-02' })
expect(writeTransport).not.toHaveBeenCalled()
```

- [ ] 运行 `npm test -- --runInBand tests/calendar-query.test.ts` 确认新行为先失败。
- [ ] 实现验证过的查询路径、分页、日期切片、完整性标志和最小数据映射；无能力时抛明确错误。
- [ ] 运行同一测试以及 `tests/client.test.ts`、`tests/client-interceptor.test.ts`；验证 GET 不污染 stdout 且认证不跨账号。
- [ ] 单独提交：`feat: add verified calendar range queries`。

### Task 2：身份、持久日志与跨进程锁

**Files:** 创建 identity/store/lock/types 模块；创建 `tests/write-operation-store.test.ts`、`tests/write-operation-lock.test.ts`、`tests/fixtures/write-lock-worker.cjs`；修改 config 及 `.env.example`。

- [ ] 编写相同用户名大小写/别名共享、跨地区隔离、同键不同内容冲突、日期跨时区仍同业务键的测试。

```ts
expect(accountKey(' Runner@Example.test ', 'cn')).toBe(accountKey('runner@example.test', 'cn'))
expect(accountKey('runner@example.test', 'cn')).not.toBe(accountKey('runner@example.test', 'global'))
expect(scheduleBusinessKey('account-a', '42', '2026-09-15'))
  .not.toBe(scheduleBusinessKey('account-a', '42', '2026-09-16'))
```

- [ ] 对存储写入每个故障点注入异常：打开临时文件、写入、sync、rename、最终提交失败。断言旧日志仍可读或安全拒绝，绝不变成空日志。
- [ ] 用两个真实 Node 子进程竞争同一私有临时目录；断言只有一个获得执行权，另一个忙/等待后读取结果。
- [ ] 测试进程暂停超过等待时限不被抢占、残留锁不因时间被删除、非 owner 不可释放锁。
- [ ] 运行 `npm test -- --runInBand tests/write-operation-store.test.ts tests/write-operation-lock.test.ts tests/config.test.ts`，确认红后实现，重复运行至绿。
- [ ] 提交：`feat: persist account-scoped write operations safely`。

### Task 3：类型化写入结果与迟到请求

**Files:** 新增 errors 模块与 `tests/write-transport.test.ts`；修改 `src/client.ts`，必要时最小修改现有错误脱敏与关闭代码。

- [ ] 模拟请求服务端已落库但永不响应；工具超时后断言实际写调用次数为 1。
- [ ] 模拟 timeout 后迟到成功/迟到异常、认证 epoch 变化、取消信号与日志保存失败。

```ts
expect(result.status).toBe('unknown')
expect(result.operationId).toEqual(expect.any(String))
expect(postCalls).toBe(1)
expect(unhandledRejections).toEqual([])
```

- [ ] 对 401/403/429/500、无响应与畸形 2xx 建立证据分类测试，明确每种为何属于 not_applied 或 unknown。
- [ ] 运行 `npm test -- --runInBand tests/write-transport.test.ts tests/client-interceptor.test.ts tests/di-session.test.ts tests/mcp-shutdown.test.ts`。
- [ ] 保证标准 OAuth 与 DI 两条认证路径都不会重放 POST/DELETE；取消/超时不产生“肯定未写入”的断言。
- [ ] 提交：`fix: preserve uncertain write outcomes without replay`。

### Task 4：单日排期统一协调器

**Files:** 创建 coordinator 模块、`tests/write-coordinator.test.ts`；修改 `scheduleWorkout` 及对应参数类型。

- [ ] 先覆盖“同样输入，新 preview、新确认”的两个请求，断言只产生一次 POST；用不同幂等键也不得绕过已存在/未知目标。
- [ ] 覆盖预览后外部排期出现、预览后 skip 项被外部删除；后者必须重预览而不是扩大写入集合。
- [ ] 覆盖没有传幂等键的旧调用仍有业务去重、旧 confirmation 重放报错、不同日期仍允许。
- [ ] 每个测试显式注入私有临时日志目录和 fake clock；不能使用默认个人 state 路径。
- [ ] 运行 `npm test -- --runInBand tests/write-coordinator.test.ts tests/calendar-regression.test.ts tests/tool-service.test.ts`；迁移与设计冲突的旧断言，保留安全回归含义。
- [ ] 实现 write/skip/blocked、写前二次复核、in_flight 先落盘、跨请求业务占用及可靠回执。
- [ ] 提交：`fix: deduplicate confirmed calendar scheduling across requests`。

### Task 5：只读核对与批准恢复

**Files:** 创建 reconcile 模块、`tests/write-recovery.test.ts`；新增工具服务中的查询/核对/恢复方法。

- [ ] 测试超时后先查空、随后出现一条匹配、出现两条匹配、查询不完整四种分支。
- [ ] 重建 service/store 实例，读取同一日志后核对，断言 POST 次数不增加。
- [ ] 通过依赖边界让 reconcile 只拿 CalendarReader/详情读取与日志能力，不注入 POST/DELETE 方法。
- [ ] 测试 unknown 无法 resume；not_attempted 需要新 preview/confirmation；恢复 revision 变化必须重新核对动作集。
- [ ] 运行 `npm test -- --runInBand tests/write-recovery.test.ts tests/write-coordinator.test.ts`，实现后转绿。
- [ ] 提交：`feat: reconcile and safely resume persisted write operations`。

### Task 6：批量、创建与取消覆盖

**Files:** 修改全部剩余写方法；创建 `tests/write-batch-recovery.test.ts`、`tests/write-create-recovery.test.ts`、`tests/write-unschedule-recovery.test.ts`。

- [ ] 批量测试固定 5 条：3 成功、1 明确未应用、1 unknown；恢复预览只包含那条明确未应用，不重发成功/unknown。
- [ ] 批量还需测试写前日志失败、途中认证失效与客户端取消：后续项 not_attempted。
- [ ] 创建成功排期失败后重启：addWorkout 总计 1 次；恢复复用原 workoutId。独立 create 与组合 create 使用同一业务占用。
- [ ] 创建超时未知 ID、成功响应缺 ID、同名不同定义、相同定义新幂等键均有对应安全断言。
- [ ] 取消测试必须使用真实语义 fixture 区分“在该日没查到”和“精确 ID 已不存在”；不可静默视作同一种证据。
- [ ] 运行 `npm test -- --runInBand tests/write-batch-recovery.test.ts tests/write-create-recovery.test.ts tests/write-unschedule-recovery.test.ts tests/calendar-regression.test.ts`。
- [ ] 提交：`fix: recover batch create and removal operations by stage`。

### Task 7：MCP 契约与子进程链路

**Files:** 修改 `src/mcp.ts`、`src/index.ts`、`tests/mcp.test.ts`、`tests/stdio.test.ts`、`tests/fixtures/stdio-server.cjs`、`tests/fixtures/mcp-tools-baseline.json`；新增 `tests/write-stdio-recovery.test.ts`。

- [ ] 注册 4 个新工具、5 个写工具可选幂等键及前述安全策略；校验严格 schema，拒绝调用方注入状态/业务键/账号键。
- [ ] 导出新增公共类型，根入口仍无启动副作用。
- [ ] 用实际 stdio 子进程链路：初始化 → 预览 → 确认 → 模拟远端写成功但响应丢失 → 关闭并重启 → 查询记录 → reconcile → 新请求，断言远端 POST 总次数仍为 1。
- [ ] 模拟服务端独立于被杀死的 MCP 进程，保留写入计数与日历数据；否则重启测试没有意义。
- [ ] 同时启动两个 MCP 客户端，使用独立模拟登录会话、同一账号 state 根，断言冲突写只发一次。
- [ ] 运行 `npm test -- --runInBand tests/mcp.test.ts tests/stdio.test.ts tests/write-stdio-recovery.test.ts tests/index.test.ts`。
- [ ] 审阅 tools/list 的逐字段差异后才更新 snapshot；不要先覆盖基线让测试自动变绿。
- [ ] 提交：`feat: expose calendar inspection and write recovery over MCP`。

### Task 8：文档、技能与交付物

**Files:** 修改 `README.md`、`README.zh-CN.md`、`docs/manual.zh-CN.md`、`docs/client-setup.md`、`docs/migration.md`、`docs/verification.md`、`CHANGELOG.md`、`skills/garmin-connect-mcp/SKILL.md` 及相关引用；更新 package files/audit。

- [ ] 详细写明跨请求去重范围、18 工具、unknown 处理、幂等键与 confirmation 的区别、独立会话共享日志但不共享 Token。
- [ ] 移除“单日同 workout/date 自动拒绝”等与实际实现不符的旧描述，解释 skip 默认策略。
- [ ] 手册增加 5 次跑步完整流程：周一/二/四/六/日，周三/五休息不生成训练；预览、确认、查看结果、超时核对、只恢复安全项。
- [ ] 写出状态文件备份、残留锁离线恢复与跨设备边界；强调删除状态目录会丢失安全记录，不是修复方法。
- [ ] 迁移说明列出旧工具安全行为收紧、failureCount 兼容语义、新增 optional 字段及读取日志的隐私边界。
- [ ] 必要新文档加入 package.json files 与 `scripts/audit-package.mjs`。禁止操作日志、锁、模拟个人数据进入打包内容。
- [ ] 运行 `npm run pack:smoke` 和文档链接/JSON示例/schema 检查；审阅技能只是解释安全流程，未以文案替代代码校验。
- [ ] 提交：`docs: explain calendar deduplication and uncertain-write recovery`。

### Task 9：全量验收与证据交付

**Files:** 修改 `.github/workflows/ci.yml`、`scripts/verify-distribution.mjs`、必要测试 fixture；更新验证报告。

- [ ] Linux Node20/22 完整 lint、覆盖率、打包与干净安装；macOS/Windows 添加新日志/锁/恢复关键测试，不能只在 Linux 测文件锁。
- [ ] Windows 实际验证原子替换、私有 ACL、子进程退出与锁释放；macOS 保留 ACL 校验，不能为过测试放宽权限。
- [ ] 执行第 11 节完整命令，记录真实结果；出现失败先定位原因，不降低门槛、不无理由 skip。
- [ ] 新增文件进入既有 coverage glob，不通过 exclude 状态机降低分母。
- [ ] 验证所有外部写调用都从统一协调器经过；查找直接调用 `addWorkout`、`scheduleWorkout`、`unscheduleWorkout` 的遗漏路径及测试脚本。
- [ ] 形成逐项验收表与剩余限制，按第 12 节交付。

## 11. 必须通过的测试矩阵

| 类别 | 必测场景 | 核心断言 |
|---|---|---|
| 日期 | 闰日、非法月日、DST、时区边界、跨月跨年、366/367 天 | 日期不偏移；越界未访问网络 |
| 日历查询 | 缺页、重复页、游标循环、超响应上限、未知条目、cn/global | 不错误报告 complete；地区能力准确 |
| ID | 空/超长 ID、数字精度、错误 ID 类型 | 不把活动 ID 当排期 ID；不猜大整数 |
| 预览 | 未确认、过期、重放、改参、换操作、换账号 | 零新增写入 |
| 去重 | 新 preview、新确认、新幂等键、无幂等键、单日与批量交叉 | 同业务目标只写一次或明确阻断 |
| 账号 | 大小写、Unicode 规范化、不同别名、跨地区、切换身份 | 作用域正确，不能跨账号复用结果 |
| 状态 | prepared/in_flight 落盘前后各故障点 | 不丢失未知记录，不盲写 |
| 并发 | 两进程抢锁、持锁暂停、非 owner 释放、锁等待超时 | 不发生双写，不按 TTL 抢锁 |
| 崩溃 | 写前、发出后、回执后提交前、批量中途被杀 | 重启无自动写；必要时残留锁阻断 |
| 超时 | 已写响应丢、未到服务端但不能证明、迟到成功/失败 | POST 一次；unknown 不变成可盲重试 |
| 核对 | 一条匹配、多条匹配、仅同名、空查询、稍后出现 | 不伪造因果；不因查空重写 |
| 创建 | 创建成功后排期失败、未知 ID、相同模板跨工具 | 复用 ID；不得重复创建 |
| 取消 | 已存在、精确不存在、只在某日缺席、DELETE 超时 | 不扩大删除范围，不推定查询能力 |
| 批量 | 部分未知、认证失效、存储失败、取消、中断恢复 | 状态计数一致；只恢复授权安全项 |
| 认证 | 缺失/过期/取消、URL elicitation 支持与不支持 | 登录流程兼容，登录后不自动重放写 |
| MCP | 真 stdio 子进程、重启、双客户端、结果丢失 | 回执可检索；stdout 无日志污染 |
| 打包 | runtime-only 安装、源码入口无副作用、包内容 | 新功能可启动，无私密日志/旧适配 |

验证命令：

```bash
npm ci
npm run lint
npm test -- --runInBand
npm run test:coverage
npm run build
npm run pack:smoke
npm run test:distribution
```

保持既有全局门槛：statements >=75%、branches >=70%、functions >=65%、lines >=78%。新增状态机的核心安全分支还需按上表逐项覆盖，不能只依赖全局百分比。

`npm run test:integration` 是既有真实集成脚本，执行前读代码与配置。无明确账号读取/写入授权时不运行真实请求，不能将它列作“已通过”。自动化使用隔离 fake Garmin 服务，禁止悄悄改用真实个人会话。

## 12. 验收边界与最终交付格式

执行 Agent 最终必须交付：

1. 实际变更文件、提交列表、接口与行为变化说明；是否推送/合并据实描述。
2. 全部新增工具的 schema、示例、状态与错误码说明，旧工具兼容测试结果。
3. 测试命令与退出结果、覆盖率、三个平台验证状态、产物审计与干净安装结果。
4. 查询/取消接口的证据表：源码核验、模拟验证、真实账号验证分别列出，国内/国际分别列出。
5. 至少 3 段可复现演示：
   - 同一请求换新预览仍不重复排期；
   - 超时后重启，核对发现已安排而不重发；
   - 5 条批量部分失败，仅恢复有证据未执行的子项。
6. 仍无法解决的边界：Garmin 服务端无幂等时不能绝对 exactly-once；外部客户端/其他设备可并发修改；创建未知 ID 可能无法自动恢复；不同 state 根互不锁定；接口最终一致性可能使 unknown 长期保留。

**禁止以“加了一个查询工具”“延长超时”“加了 idempotencyKey 字段”“内存 Set 通过测试”作为完成标准。** 必须证明该键确实持久化、参与跨工具/跨请求检查、在发包前生效，并经重启和真实子进程并发测试验证。

若生产查询端点尚无法可靠核实，交付状态必须是“安全基础设施与模拟验收完成，目标地区查询/自动恢复受能力限制”，不能声称完整修复已真实验证。该情况下继续禁止不确定操作的盲目重发。
