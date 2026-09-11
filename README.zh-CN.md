# garmin-connect-mcp

面向智能体的独立 Garmin Connect MCP 服务。任何支持本地 MCP stdio 的客户端，都可以通过它读取运动数据、创建结构化训练，并把训练安排到 Garmin 日历。

[English](README.md) · [完整中文说明书](docs/manual.zh-CN.md) · [客户端配置](docs/client-setup.md) · [迁移说明](docs/migration.md) · [验证报告](docs/verification.md) · [写入安全与恢复](docs/calendar-write-recovery.md)

服务自身不需要模型 API Key 或智能体框架。访问佳明使用你自己的账号。随包技能是可选的使用说明，连接 MCP 不需要先安装技能。

## 从源码安装

开发推荐 Node.js 22（运行要求 Node.js 20+）、npm 和 GitHub CLI：

```bash
gh repo clone xcbbc21/garmin-connect-mcp
cd garmin-connect-mcp
npm ci
```

安装会构建 `lib/`。更新源码后重新运行 `npm ci`；单独运行 `npm run build` 会先清理本项目的生成目录，再编译。

**本分支只从 GitHub 分发。** npm 上无作用域的同名包属于其他项目，不能通过安装它获得这里的代码。当前包设置了 `private: true`，没有发布 npm 版本。

## 首次登录

进入源码目录，在终端设置邮箱并选择佳明区域：

```bash
export GARMIN_USERNAME='你的佳明邮箱'
node lib/auth-cli.js serve --account personal-codex --region cn --open
```

国际区改用 `--region global`。登录命令要求明确提供账号别名和区域；MCP 配置使用同一别名、邮箱和区域。

系统浏览器会打开短时有效的本地登录页。只在其中的 Garmin 登录表单输入密码和验证码，随后确认返回的账号身份。外层页面属于本地服务，嵌入 Garmin 表单；地址栏显示回环地址，不能仅凭外层地址栏判断内嵌页面来源。表单未出现时不要输入凭据。

macOS 没有设置配置根目录覆盖时，默认会话位置是：
`~/.config/garmin-connect-mcp/accounts/personal-codex.session.json`。
`XDG_CONFIG_HOME`、`LOCALAPPDATA`、`APPDATA` 可覆盖根目录；有自定义配置时，以登录命令实际选定的目标为准。

另一客户端若同时运行，应独立登录，例如使用 `personal-claude`。会话令牌可能轮换，不能复制或并发共用同一个会话文件。

认证命令仍叫 `garmin-connect-auth`，源码安装直接使用 `node lib/auth-cli.js`，无需全局安装。保留 `login`、`login --browser` 和 `canary` 诊断入口；日常 `serve` 不需要 Playwright，旧浏览器诊断使用可选驱动。

## 连接智能体

所有客户端启动相同程序：

- 命令：Node 可执行文件的绝对路径，可用 `command -v node` 查询。
- 参数：本项目 `lib/mcp.js` 的绝对路径。
- 环境：邮箱、区域、账号别名，以及会话文件路径。

[客户端配置](docs/client-setup.md) 提供 Codex、Claude Desktop、Claude Code、Cursor、Windsurf、WorkBuddy 和 ZCode 示例。这些是配置示例，协议测试通过不等于每个桌面客户端都完成了实测。

支持 MCP URL 登录提示的客户端，可在会话缺失或过期时进入上述浏览器流程。不支持时，先运行独立登录命令再重试。登录完成不会自动重放写入请求。

## 工具与用法

| 能力 | MCP 工具 |
| --- | --- |
| 运动和健康数据 | `get_garmin_activities`、`get_garmin_sleep`、`get_garmin_steps`、`get_garmin_heart_rate`、`get_garmin_weight` |
| 账号和训练库 | `get_garmin_profile`、`get_garmin_workouts` |
| 跑步训练知识 | `get_running_skill_advice` |
| 创建训练模板 | `create_garmin_workout` |
| 训练日历 | `schedule_garmin_workout`、`batch_schedule_garmin_workouts`、`create_and_schedule_garmin_workout`、`unschedule_garmin_workout` |
| 导出活动文件 | `download_garmin_activity_fit` |
| 读取训练日历 | `get_garmin_calendar` |
| 写入巡检与恢复 | `get_garmin_write_operation`、`reconcile_garmin_write_operation`、`resume_garmin_write_operation` |

共 18 个工具。训练库记录“练什么”，训练日历记录“哪天练”。知识工具提供训练方法说明和个性化训练前的信息收集，不会自行生成并执行完整计划。

创建训练和日历写入均采用两次调用：第一次返回预览，用户确认后，用完全相同的请求，加上 `confirmed: true` 和返回的 `confirmationId` 再次调用。确认 ID 十分钟内有效、只能使用一次；其形式为 `<operationId>:<预览版本号>`，版本号与截止时间随操作一起持久化，因此未过期的确认句柄在重启后仍可解析，而重新预览会让此前所有句柄失效。**写入日志是持久的**：日历结果记录在本地磁盘上，重启后仍然有效。详见[写入安全与恢复](docs/calendar-write-recovery.md)。

五个写工具——`create_garmin_workout`、`schedule_garmin_workout`、`batch_schedule_garmin_workouts`、`create_and_schedule_garmin_workout`、`unschedule_garmin_workout`——都接受可选 `idempotencyKey`（1–128 个字符，只允许 `A-Z a-z 0-9 . _ : -`）。它是请求标签，不是权限凭证：同键同请求会直接返回已有回执而不再写入，换一个键也不能绕过进行中或结果不确定的写入。`confirmationId` 与 `idempotencyKey` 不能互相替代。

日历写入记录在账号级本地目录 `GARMIN_STATE_DIR`（绝对、本地、私有路径；默认 `<平台配置根>/garmin-connect-mcp/state`）。它与登录别名解耦：同一账号的不同别名共用一个恢复记录，而会话文件仍然互相隔离。请备份该目录；删除它会丢掉防止重复排期的记录。

### 一次安排下周五次跑步

可以直接对智能体说：

> 找到我训练库中的轻松跑、门槛跑和长跑模板。按 Asia/Shanghai 时区预览下周一、二、四、六、日五次训练，先展示日期和内容给我确认，其余日子留空。

智能体先查出真实 workoutId，再换算为明确日期。下面是批量预览参数示例，ID 和日期需要替换：

```json
{
  "schedules": [
    { "workoutId": "123", "date": "2026-09-14" },
    { "workoutId": "456", "date": "2026-09-15" },
    { "workoutId": "123", "date": "2026-09-17" },
    { "workoutId": "123", "date": "2026-09-19" },
    { "workoutId": "789", "date": "2026-09-20" }
  ],
  "timezone": "Asia/Shanghai"
}
```

用户确认后，向 `batch_schedule_garmin_workouts` 发送原请求，并补充确认字段。单批接受 1–100 条，可以跨多天、多周。

- 日期是当地日历日期 `YYYY-MM-DD`；省略时区时使用服务所在电脑的时区。过去日期、不存在的日期和无效 IANA 时区会被拒绝。
- 同一训练可安排在不同日期；同一批中的相同训练与日期组合在预览阶段就会被拒绝，不会发出任何写入。
- 在同一份共享写入日志范围内，同一个训练与日期组合不会被写入两次：重复请求要么因为日历读取显示该条目已存在而跳过，要么因为该组合存在结果不确定的历史写入而阻断。换新预览、换 `idempotencyKey`、重启服务、并发调用都不能绕过。该保证是本地的，只覆盖共用同一 `GARMIN_STATE_DIR` 的机器；Garmin 没有服务端幂等机制，因此换一个状态目录、换一台设备或手工改动日历都不在覆盖范围内，而 `skipped` 只反映读取返回的结果，不等于证明不存在其他条目。
- 休息日留空，不创建 workout；一节训练内部的休息、恢复步骤仍可使用。
- 预览时核对训练库 ID；批量确认后每条独立提交并各自报告 `status`。某条失败不影响后续条目：`successCount` 统计 `succeeded` 与 `skipped`，旧字段 `failureCount` 表示“未确认完成”而非“确定失败”——新调用方应依据逐条 `status` 与 `definiteFailureCount` 判断，不要用 `failureCount` 触发重试。
- 超时返回 `status: "unknown"` 和可持久查询的 `operationId`，而不是笼统失败。该写入不会被重发：先核对 Garmin 日历，然后改用其他日期或模板。创建成功但排期失败时，会尽可能报告已创建的训练 ID。
- 取消排期需要返回的 `workoutScheduleId`，不能拿训练库 ID 代替；未返回排期 ID 时不得编造。
- `create_garmin_workout`、`create_and_schedule_garmin_workout`、`unschedule_garmin_workout` 同样接入写入日志，并接受相同的可选 `idempotencyKey`。组合创建会分别记录创建与排期两个阶段：模板已创建但进程中断时，可以在不重复创建模板的前提下恢复；取消操作也会入日志，不会被重复执行。用 `get_garmin_calendar` 读取当前日历，用 `get_garmin_write_operation`、`reconcile_garmin_write_operation`、`resume_garmin_write_operation` 巡检与恢复。详见[写入安全与恢复](docs/calendar-write-recovery.md)。

锁定的 `garmin-connect@1.6.2` 没有导出排期与取消方法。现有适配通过已认证请求调用 `POST /workout-service/schedule/{workoutId}` 和 `DELETE /workout-service/schedule/{workoutScheduleId}`。它们是非官方接口；模拟测试通过不等于已经验证当前真实 Garmin 接口或手表同步。

### 结果不确定时如何恢复

上面的批量示例停在逐条回执。若某条返回 `unknown`，后续链路是：

1. **读取逐条回执**：批量结果按条给出 `status`、`action`、`evidence`。`succeeded` 带有写入回执；`skipped` 表示日历读取已显示该条目存在。
2. **查询操作**：`get_garmin_write_operation` 只接受 `operationId` 或 `idempotencyKey` 之一；两者都不传则列出最近的写入记录（`limit` 默认 20，最大 100）。返回持久记录：哪些步骤是 `succeeded`、`unknown`、`prepared`、`not_attempted`，以及 `canResume`、`manualReviewRequired`、`nextAction`。
3. **核对**：`reconcile_garmin_write_operation` 在固定预算内（最多 3 次读取、20 秒）重读 Garmin 并报告观测结果。它**不会改写 `status`**：`observed_present` 表示目标状态已满足，但原步骤仍保持 `unknown`，因为观测无法证明该条目是本次请求造成的。空的日历读取不能证明任何事情，因此永远不会授权自动重发。
4. **只恢复安全条目**：`resume_garmin_write_operation` 同样先预览。它只为从未下发过的步骤装载写入；结果未知的条目会列为 `blocked`，绝不重发。确认预览后提交剩余步骤。

不要删除状态目录，也不要为了“清掉” unknown 而重发同一写入：两者都不会移除记录，而第二次写入可能造成重复条目。

### 其他典型请求

- “查看我最近五次跑步。”
- “比较过去七个完整自然日的睡眠和静息心率。”
- “预览一个 3×8 分钟门槛跑，我确认后再创建。”
- “下载 activityId 为 123456789 的 FIT 文件。”需先配置 `GARMIN_FIT_DOWNLOAD_DIR`。

## 配置与排错

完整变量见 [.env.example](.env.example)。MCP 启动时读取工作目录的 `.env`；桌面客户端建议显式配置 `env`。上面的登录示例使用终端环境变量。

| 问题 | 处理 |
| --- | --- |
| Node 或程序找不到 | 使用 Node 与 `lib/mcp.js` 的绝对路径，桌面程序未必继承终端 PATH。 |
| 缺少邮箱 | 在启动 MCP 的客户端环境中配置 `GARMIN_USERNAME`。 |
| 会话缺失或过期 | 用同一别名、区域和目标路径重新登录。 |
| 会话权限不符合要求 | 使用本地私有目录，保留运行时要求的仅所有者权限。 |
| 预览过期或内容变化 | 重新预览，重新确认。 |
| 排期被阻断、`status: "unknown"` | 该训练与日期存在未决写入。不要重发写入：用 `get_garmin_calendar` 读取 Garmin 日历，用 `reconcile_garmin_write_operation` 核对未决步骤，之后只对 `resume_garmin_write_operation` 判定为安全的条目执行恢复。核对即使观察到该条目存在，也不等于得到写入回执——原步骤仍保持 `unknown`。 |
| 查询不到写入记录 | `get_garmin_write_operation` 对“不存在的 ID”和“属于其他账号的 ID”都返回 `OPERATION_NOT_FOUND`，这是有意设计。请确认当前账号就是执行写入的账号，且 `GARMIN_STATE_DIR` 指向同一目录。 |
| 新写入被拒绝 / 状态不可用 | 确认 `GARMIN_STATE_DIR` 是绝对可写路径，且日志未超过 32 MiB。不要删除状态目录，见[恢复步骤](docs/calendar-write-recovery.md)。 |
| FIT 无法导出 | 指定可信的绝对父目录；程序不覆盖已有文件。 |

活动数据默认简略模式。完整模式可能包含精确路线和位置。健康估算不能作为医学诊断。密码、会话和个人数据不要提交 Git。

## 可选技能与代码接口

`skills/garmin-connect-mcp/SKILL.md` 是通用使用指导；支持技能的客户端可按自己的机制加载。不加载技能也可以使用所有 MCP 工具。

包根目录导出 `createMcpServer`、`GarminClient`、`GarminToolService`、`resolveConfig`、`resolveAccountAlias`、日志接口和公共类型。导入不会加载 dotenv 或启动服务。构造方式为 `new GarminClient(config, { logger })`，日志器实现 `debug/info/warn/error(message: string)`。

## 开发验证

```bash
npm ci
npm run lint
npm test -- --runInBand
npm run test:coverage
npm run pack:smoke
npm run test:distribution
```

测试前自动构建；lint 只检查，不改写文件。打包审计核对文件和旧依赖。CI 覆盖 Linux Node 20/22，以及 macOS、Windows 平台行为。

`npm run test:integration` 是主动执行的真实只读检查，使用项目统一客户端和会话流程。需要先配置已认证账号，CI 不运行；显式设置 `GARMIN_INTEGRATION_VERBOSE=true` 会打印规范化后的个人数据。

本次改造的实际结果与验证边界见[验证报告](docs/verification.md)。原始许可和来源信息保留在 [LICENSE](LICENSE) 与 [NOTICE](NOTICE.md)。
