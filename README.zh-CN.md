# garmin-connect-mcp

面向智能体的独立 Garmin Connect MCP 服务。任何支持本地 MCP stdio 的客户端，都可以通过它读取运动数据、创建结构化训练，并把训练安排到 Garmin 日历。

[English](README.md) · [客户端配置](docs/client-setup.md) · [迁移说明](docs/migration.md) · [验证报告](docs/verification.md)

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

共 14 个工具。训练库记录“练什么”，训练日历记录“哪天练”。知识工具提供训练方法说明和个性化训练前的信息收集，不会自行生成并执行完整计划。

创建训练和日历写入均采用两次调用：第一次返回预览，用户确认后，用完全相同的请求，加上 `confirmed: true` 和返回的 `confirmationId` 再次调用。确认 ID 十分钟内有效、只能使用一次；重启服务后待确认预览失效。

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
- 同一训练可安排在不同日期；同一批中的相同训练与日期组合会被拒绝。目前没有完整日历读取与跨请求全局去重，不应认为再次预览确认后会自动识别已有排期。
- 休息日留空，不创建 workout；一节训练内部的休息、恢复步骤仍可使用。
- 预览时核对训练库 ID；批量确认后某条失败仍继续后续条目，逐条报告结果。
- 超时可能发生在 Garmin 已接收写入之后，应先检查日历再重试。创建成功但排期失败会尽可能报告已创建的训练 ID。
- 取消排期需要返回的 `workoutScheduleId`，不能拿训练库 ID 代替；未返回排期 ID 时不得编造。

锁定的 `garmin-connect@1.6.2` 没有导出排期与取消方法。现有适配通过已认证请求调用 `POST /workout-service/schedule/{workoutId}` 和 `DELETE /workout-service/schedule/{workoutScheduleId}`。它们是非官方接口；模拟测试通过不等于已经验证当前真实 Garmin 接口或手表同步。

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
