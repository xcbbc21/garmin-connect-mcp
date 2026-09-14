# garmin-connect-mcp 完整使用说明书

版本：0.2.0  
适用项目：[xcbbc21/garmin-connect-mcp](https://github.com/xcbbc21/garmin-connect-mcp)

这是一款独立运行的 Garmin Connect MCP 服务。它通过标准 MCP stdio 协议，让 Codex、Claude Desktop、Claude Code、Cursor、Windsurf、WorkBuddy、ZCode 等支持本地 MCP 的客户端访问你自己的 Garmin Connect 账号。

本说明书按“第一次安装 → 登录 → 接入客户端 → 使用每个工具 → 排查问题”的顺序编写。

## 1. 项目能做什么

服务提供 14 个 MCP 工具：

| 类型 | 工具 |
| --- | --- |
| 运动记录 | `get_garmin_activities` |
| 睡眠、步数、心率、体重 | `get_garmin_sleep`、`get_garmin_steps`、`get_garmin_heart_rate`、`get_garmin_weight` |
| 账号与训练库 | `get_garmin_profile`、`get_garmin_workouts` |
| 跑步知识与个性化训练前信息收集 | `get_running_skill_advice` |
| 创建训练模板 | `create_garmin_workout` |
| Garmin 日历 | `schedule_garmin_workout`、`batch_schedule_garmin_workouts`、`create_and_schedule_garmin_workout`、`unschedule_garmin_workout` |
| FIT 文件 | `download_garmin_activity_fit` |

可以把它理解成两层：

- 训练库回答“训练是什么”，例如“3×8 分钟阈值跑”。
- 训练日历回答“哪一天做什么”，例如“2026-09-15 做 3×8 分钟阈值跑”。

项目不包含模型，不需要 OpenAI、Claude 或其他模型 API Key。模型由 MCP 客户端提供，项目只负责 Garmin 连接、数据处理和工具执行。

## 2. 工作原理

```text
Codex / Claude / 其他 MCP 客户端
              │ 本地 stdio
              ▼
      garmin-connect-mcp
              │
      Garmin Connect 会话
              │
      读取数据 / 创建训练 / 日历排期
              ▼
          Garmin Connect
```

首次登录时，浏览器在本机打开一个短时有效的本地登录页面。登录完成后，项目把会话写入本地账号文件。MCP 服务以后优先使用这个会话，不需要每次重新输入密码。

所有创建、排期和取消操作都先返回预览。只有用户明确批准，并用同一份请求附带一次性 `confirmationId`，服务才会真正写入 Garmin。

## 3. 环境要求

- Node.js 20 或更高版本，推荐 Node.js 22。
- npm。
- 一个 Garmin Connect 账号。
- 一个支持本地 MCP stdio 的客户端。
- 访问 Garmin 登录页面和 Garmin Connect 接口的网络连接。

项目只从 GitHub 源码安装，当前 `package.json` 设置了 `private: true`，不会发布到 npm。

## 4. 安装项目

### 4.1 克隆源码

```bash
gh repo clone xcbbc21/garmin-connect-mcp
cd garmin-connect-mcp
```

如果没有 GitHub CLI，也可以用 Git：

```bash
git clone https://github.com/xcbbc21/garmin-connect-mcp.git
cd garmin-connect-mcp
```

### 4.2 安装依赖并构建

```bash
npm ci
```

`npm ci` 会安装锁定版本并构建 `lib/`。也可以手动运行：

```bash
npm run build
```

构建前会清理本项目自己的 `lib/` 生成目录，不会删除其他目录。

### 4.3 确认入口文件

构建成功后，主要入口是：

```text
lib/mcp.js       MCP 服务
lib/auth-cli.js  独立认证命令
lib/index.js     程序化 API
```

命令行名称约定为：

```text
garmin-connect-mcp
garmin-connect-auth
```

源码安装时不需要全局安装命令，直接用 `node lib/...` 即可。

## 5. 首次登录

### 5.1 设置邮箱

在项目目录打开终端：

```bash
export GARMIN_USERNAME='你的Garmin邮箱'
```

Windows PowerShell：

```powershell
$env:GARMIN_USERNAME = '你的Garmin邮箱'
```

### 5.2 选择 Garmin 区域

本分支固定使用 Garmin 中国区：

```bash
node lib/auth-cli.js serve --account personal-codex --open
```

参数说明：

| 参数 | 含义 |
| --- | --- |
| `serve` | 启动本地浏览器认证服务 |
| `--account personal-codex` | 本地账号别名，只用于区分会话文件 |
| `--open` | 自动打开系统浏览器 |

### 5.3 在浏览器中登录

1. 等待系统浏览器打开本地登录页。
2. 只在页面中显示的 Garmin 登录表单里输入邮箱、密码和验证码。
3. 按 Garmin 页面完成双因素验证。
4. 确认页面显示的是你自己的账号。
5. 等待页面显示登录完成，再关闭浏览器窗口。

不要把密码、验证码或会话令牌粘贴到聊天窗口，也不要把它们写入 Git 仓库。

### 5.4 会话文件位置

默认会话目录位于平台配置目录下，例如 macOS 通常是：

```text
~/.config/garmin-connect-mcp/accounts/personal-codex.session.json
```

Windows 和 Linux 的根目录会根据系统配置目录规则变化。可以通过 `XDG_CONFIG_HOME`、`LOCALAPPDATA` 或 `APPDATA` 改变配置根目录。

如果使用自定义路径，登录命令和 MCP 客户端必须使用同一个路径：

```bash
node lib/auth-cli.js serve \
  --account personal-codex \
  --output /Users/你的用户名/.config/garmin-connect-mcp/accounts/personal-codex.session.json \
  --open
```

会话文件包含敏感认证信息。不要复制给其他人，不要放入云盘公开目录，不要让两个账号别名共用同一个文件。

### 5.5 多客户端登录

如果同时使用 Codex 和 Claude Desktop，建议分别建立会话：

```bash
node lib/auth-cli.js serve --account personal-codex --open
node lib/auth-cli.js serve --account personal-claude --open
```

两个客户端的配置分别使用：

```text
personal-codex.session.json
personal-claude.session.json
```

这样可以避免会话刷新时相互覆盖。

## 6. 配置环境变量

可以在启动目录放置 `.env`，也可以直接在客户端配置 `env`。完整模板见项目根目录的 `.env.example`。

| 变量 | 是否必须 | 说明 |
| --- | --- | --- |
| `GARMIN_USERNAME` | 是 | Garmin 登录邮箱 |
| `GARMIN_ACCOUNT` | 否 | 会话别名，默认 `default` |
| `GARMIN_SESSION_TOKEN_FILE` | 否 | 自定义会话文件绝对路径 |
| `GARMIN_PASSWORD` | 否 | 兼容旧式登录，不推荐日常使用 |
| `GARMIN_SESSION_TOKEN` | 否 | 兼容预认证会话，不推荐直接写入配置 |
| `GARMIN_FIT_DOWNLOAD_DIR` | 下载 FIT 时必须 | FIT 文件保存的可信绝对父目录 |
| `GARMIN_CACHE_TTL` | 否 | 缓存秒数，默认 300，设为 0 关闭 |
| `GARMIN_REQUEST_TIMEOUT_MS` | 否 | 请求超时毫秒数，默认 15000 |
| `GARMIN_LOG_LEVEL` | 否 | `debug`、`info`、`warn`、`error` |
| `GARMIN_ACTIVITY_DETAIL` | 否 | `compact` 或 `full`，默认 `compact` |
| `GARMIN_STATE_DIR` | 否 | 写入日志与写入锁的绝对本地私有目录，默认 `<平台配置根>/garmin-connect-mcp/state`；相对路径会被拒绝 |

`GARMIN_STATE_DIR` 保存的是排期写入记录，用来防止重复写入同一条排期。它与登录别名解耦（同一账号的不同别名共用一个记录），与会话文件无关。请定期备份；**删除该目录会丢掉防止重复排期的依据**，不是修复手段。

注意：MCP 的 stdout 专门用于 JSON-RPC 协议。日志写入 stderr，不要把调试输出重定向到 stdout。

## 7. 接入 MCP 客户端

所有客户端都启动同一个程序：

```text
Node 绝对路径 + lib/mcp.js 绝对路径 + GARMIN_* 环境变量
```

先查询 Node 路径：

```bash
command -v node
```

macOS 常见结果类似：

```text
/opt/homebrew/bin/node
```

不要在桌面客户端的 JSON 或 TOML 配置里写 `~`、`$HOME` 或 `$PATH`，使用绝对路径。

### 7.1 Codex

编辑 `~/.codex/config.toml`，保留原有设置：

```toml
[mcp_servers.garmin-connect-mcp]
command = "/opt/homebrew/bin/node"
args = ["/Users/你的用户名/garmin-connect-mcp/lib/mcp.js"]

[mcp_servers.garmin-connect-mcp.env]
GARMIN_USERNAME = "your@email.com"
GARMIN_ACCOUNT = "personal-codex"
GARMIN_SESSION_TOKEN_FILE = "/Users/你的用户名/.config/garmin-connect-mcp/accounts/personal-codex.session.json"
```

重启 Codex 后，在聊天中测试：“查看我最近 5 次跑步”。

### 7.2 Claude Desktop

macOS 配置文件：

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

添加：

```json
{
  "mcpServers": {
    "garmin-connect-mcp": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/你的用户名/garmin-connect-mcp/lib/mcp.js"],
      "env": {
        "GARMIN_USERNAME": "your@email.com",
        "GARMIN_ACCOUNT": "personal-claude",
        "GARMIN_SESSION_TOKEN_FILE": "/Users/你的用户名/.config/garmin-connect-mcp/accounts/personal-claude.session.json"
      }
    }
  }
}
```

保存后完全退出并重新打开 Claude Desktop。

### 7.3 其他客户端

Claude Code、Cursor、Windsurf、WorkBuddy 和 ZCode 都使用同一组 `command`、`args` 和 `env`。客户端界面名称可能不同，但选择“本地 stdio MCP”即可。

每个同时运行的客户端建议使用独立 `GARMIN_ACCOUNT` 和会话文件。

## 8. MCP 工具通用规则

### 8.1 只读工具

读取活动、睡眠、步数、心率、体重、训练库、个人资料和跑步知识的工具不会主动修改 Garmin 数据。

### 8.2 写入工具

以下工具一定先预览：

- `create_garmin_workout`
- `schedule_garmin_workout`
- `batch_schedule_garmin_workouts`
- `create_and_schedule_garmin_workout`
- `unschedule_garmin_workout`

标准流程：

1. 第一次调用不传 `confirmed`，或传 `confirmed: false`。
2. 检查返回的 `preview`、日期、训练名称、训练步骤和账号。
3. 让用户明确同意。
4. 用完全相同的原始请求再次调用。
5. 添加 `confirmed: true`。
6. 添加第一次返回的 `confirmationId`。
7. 保存返回的 `workoutId` 或 `workoutScheduleId`。

确认 ID：

- 形式为 `<operationId>:<预览版本号>`。
- 有效期 10 分钟；版本号与截止时间随操作一起持久化，因此**未过期的句柄在服务重启后仍可解析**。
- 只能成功使用一次；写入结果会落盘，重复提交同一个句柄会返回已有回执而不是再次下发。
- 请求内容有变化时不能使用。
- 重新预览会让此前所有句柄失效（报 `CONFIRMATION_STALE`）；过期或重放时必须重新预览。

幂等键（`idempotencyKey`）：

- 上述 5 个写工具**都**接受这个可选参数，可经 MCP 参数层直接传入。
- 它是「请求标签」，不是授权令牌：同一个 key 配同一个请求会返回已有回执而不重复写入；同一个 key 配不同请求会被拒绝（`IDEMPOTENCY_CONFLICT`）。
- 换一个新的 key **不能**绕过待处理或结果不确定的写入。

## 9. 工具逐项说明

以下每节都给出“什么时候用、怎么调用、如何确认结果、常见问题”。实际使用时可以直接把示例意图告诉智能体，不必手写 JSON。

### 9.1 `get_garmin_activities`：读取活动记录

用途：读取最近的跑步、骑行、游泳或其他 Garmin 活动。

参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `limit` | 整数 1–100 | 返回数量，默认 5 |
| `offset` | 非负整数 | 跳过前面的记录，默认 0 |
| `detail` | `compact` / `full` | 详细程度，默认使用配置值 |

步骤：

1. 直接告诉智能体要查看的数量，例如“查看最近 10 次跑步”。
2. 如果只需要日期、距离和配速，使用 `compact`。
3. 只有确实需要路线、心率分布等字段时才使用 `full`。
4. 让智能体按日期、运动类型或距离整理结果。

手写调用示例：

```json
{
  "limit": 10,
  "offset": 0,
  "detail": "compact"
}
```

注意：`full` 可能包含精确路线或位置相关信息，不要在不必要时使用或转发。

### 9.2 `get_garmin_sleep`：读取睡眠

用途：读取某一天或连续日期的睡眠数据。

参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `startDate` | `YYYY-MM-DD` | 起始日期，省略时使用今天 |
| `endDate` | `YYYY-MM-DD` | 包含在内的结束日期，省略时等于起始日期 |

步骤：

1. 单日查询：“查看昨天的睡眠”。
2. 多日查询：“查看 2026-09-01 到 2026-09-07 的睡眠”。
3. 让智能体比较总睡眠、阶段和恢复趋势。

示例：

```json
{
  "startDate": "2026-09-01",
  "endDate": "2026-09-07"
}
```

日期范围不能超过工具允许的最大范围。若 Garmin 没有某一天数据，结果可能是空值或上游返回的缺失状态。

### 9.3 `get_garmin_steps`：读取步数

用途：读取每日步数总量，以及 Garmin 能提供的目标和距离字段。

步骤与 `get_garmin_sleep` 相同：可以省略参数查今天，也可以提供起止日期查一段时间。

```json
{
  "startDate": "2026-09-01",
  "endDate": "2026-09-07"
}
```

注意：目标和距离字段在 Garmin 端可能不可用，不能把缺失解释成零。

### 9.4 `get_garmin_heart_rate`：读取心率

用途：读取单日或日期范围的心率数据，用于观察静息心率、日间心率或恢复变化。

步骤：

1. 指定最近几天或完整自然周。
2. 让智能体先报告原始可用字段和缺失字段。
3. 再让智能体结合睡眠和训练量进行趋势比较。

```json
{
  "startDate": "2026-09-01",
  "endDate": "2026-09-07"
}
```

该工具提供数据，不构成医学诊断。胸部不适、晕厥、异常气短或异常心悸等情况应优先寻求专业医疗意见。

### 9.5 `get_garmin_weight`：读取体重和体成分

用途：读取单日或一段时间的体重、体脂或 Garmin 可提供的其他体成分数据。

步骤：

1. 用日期范围查询，不要只根据单次测量判断趋势。
2. 让智能体标明测量日期和缺失字段。
3. 结合训练量和饮食信息时，明确哪些是数据、哪些是推断。

### 9.6 `get_garmin_profile`：读取账号资料

用途：读取经过白名单过滤的 Garmin 个人资料摘要。

调用不需要参数：

```json
{}
```

步骤：

1. 直接请求“读取我的 Garmin 资料摘要”。
2. 检查返回的账号身份是否与当前配置一致。
3. 不要把个人资料摘要当成训练计划输入的全部信息。

如果账号会话失效，工具会返回认证错误或触发客户端支持的 URL 登录流程。

### 9.7 `get_garmin_workouts`：读取训练库

用途：读取 Garmin Workout Library 中已经存在的训练模板。

参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `limit` | 整数 1–100 | 返回模板数量，默认 10 |
| `offset` | 非负整数 | 分页偏移，默认 0 |

步骤：

1. 先调用此工具查找训练名称和真实 `workoutId`。
2. 需要更多结果时增加 `offset`。
3. 在排期前核对训练名称、运动类型和步骤。
4. 把返回的 `workoutId` 传给排期工具。

```json
{
  "limit": 50,
  "offset": 0
}
```

不要自行猜测 `workoutId`。训练库 ID 和日历排期返回的 `workoutScheduleId` 不是同一个概念。

### 9.8 `get_running_skill_advice`：跑步知识和个性化训练前信息

用途：解释训练方法，或在生成个性化建议前收集必要信息。

#### 解释模式

只想了解训练方法时使用：

```json
{
  "mode": "explain",
  "query": "threshold",
  "language": "zh-CN"
}
```

可以解释 8 类训练，以及 Hansons、Jack Daniels、挪威阈值和极化训练理念。解释模式不会生成个人逐日计划。

#### 个性化模式

只要涉及“给我安排训练”“按我的比赛制定计划”等个人建议，就必须使用：

```json
{
  "mode": "personalized",
  "language": "zh-CN",
  "goal": "2026-12-06 完成全程马拉松，目标 4 小时 30 分，最低目标安全完赛",
  "currentPerformance": "2026-08-20 完成 10 公里 58 分钟，主观用力 8/10，平路、天气 24°C",
  "performanceBasis": "recent_race",
  "trainingBackground": "过去 3 个月每周跑 4 次，周均 35 公里，最长 18 公里，每周 1 次间歇，没有双阈值训练",
  "availability": "周一、周三、周五和周日可跑；周日可安排长跑；周二力量训练；每天最多 90 分钟",
  "healthConstraints": "目前无伤病，过去一年右小腿有轻微拉伤，睡眠通常 7 小时",
  "hasWarningSymptoms": false,
  "trainingPreference": "hard_easy",
  "maxQualitySessionsPerWeek": 2,
  "intensityGuidancePreference": "mixed",
  "includeRecentActivities": true
}
```

必填信息不完整时，工具会返回 `requiresUserInput: true` 和缺失字段问题。回答前不要让智能体猜测训练量或生成逐日计划。

如果 `hasWarningSymptoms` 为 `true`，工具会停止训练计划建议，不会自行诊断，也不会生成高强度计划。

`performanceBasis` 可选：

- `recent_race`：近期比赛。
- `time_trial`：近期测试跑。
- `no_recent_benchmark`：没有可信近期成绩。

没有近期基准时，不应要求工具给出精确阈值配速；应先进行低风险基础训练或基准测试。

### 9.9 `create_garmin_workout`：创建训练模板

用途：把一节结构化训练写入 Garmin Workout Library。

它不会自动生成完整训练计划。个性化训练应先使用 `get_running_skill_advice`，然后再由用户明确指定要创建的训练。

#### 训练结构

```json
{
  "name": "阈值跑 3x8 分钟",
  "description": "控制强度，组间慢跑恢复",
  "sport": "running",
  "steps": [
    {
      "type": "warmup",
      "endCondition": "distance",
      "endValue": 2000,
      "target": "open"
    },
    {
      "type": "repeat",
      "iterations": 3,
      "steps": [
        {
          "type": "interval",
          "endCondition": "time",
          "endValue": 480,
          "target": "pace",
          "paceFrom": "5:00",
          "paceTo": "5:10"
        },
        {
          "type": "recovery",
          "endCondition": "time",
          "endValue": 120,
          "target": "open"
        }
      ]
    },
    {
      "type": "cooldown",
      "endCondition": "distance",
      "endValue": 2000,
      "target": "open"
    }
  ]
}
```

字段说明：

| 字段 | 可用值或限制 |
| --- | --- |
| `name` | 1–80 个字符 |
| `description` | 最多 1024 个字符 |
| `sport` | `running`、`cycling`、`swimming`、`strength`，默认跑步 |
| `steps` | 1–100 个步骤 |
| 步骤 `type` | `warmup`、`interval`、`recovery`、`cooldown`、`rest`、`repeat` |
| `endCondition` | `distance`、`time`、`lapButton` |
| `target` | `open`、`pace`、`heartRate` |
| `paceFrom/paceTo` | `分钟:秒`，例如 `5:00` |
| `hrFrom/hrTo` | 30–250 |
| `repeat.iterations` | 1–99 |

执行步骤：

1. 第一次发送上述训练定义，不加确认字段。
2. 检查返回的训练名称、运动类型和步骤。
3. 用户明确确认。
4. 原样重发，并补充：

```json
{
  "confirmed": true,
  "confirmationId": "第一次返回的 UUID"
}
```

5. 保存返回的 `workoutId`，以后排期时使用它。

如果创建成功但没有返回 `workoutId`，不要立即重复创建。先到 Garmin 训练库检查是否已经生成。

### 9.10 `schedule_garmin_workout`：安排一条日历训练

用途：把训练库中已有的一个 Workout 放到指定日期。

参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `workoutId` | 字符串 | `get_garmin_workouts` 返回的训练库 ID |
| `date` | `YYYY-MM-DD` | Garmin 日历当地日期，今天或未来日期 |
| `timezone` | IANA 时区 | 例如 `Asia/Shanghai`，省略时使用服务电脑时区 |

步骤：

1. 先用 `get_garmin_workouts` 查真实 ID。
2. 提供日期和时区：

```json
{
  "workoutId": "123456",
  "date": "2026-09-15",
  "timezone": "Asia/Shanghai"
}
```

3. 检查预览中的训练名称、日期和时区。
4. 用户确认后，使用相同请求加 `confirmed` 和 `confirmationId`。
5. 保存返回的 `workoutScheduleId`，取消时使用这个 ID。

同一个训练可以安排到不同日期；在共用同一份写入日志的范围内，同一个 `workoutId + date` 组合不会被写入两次。重复请求要么因为日历读取显示该条目已存在而跳过（`action: "skip_existing"`），要么因为该组合存在结果不确定的历史写入而阻断（`action: "blocked"`）。换新预览、换 `idempotencyKey`、重启服务或并发调用都不能绕过。Garmin 没有服务端幂等机制，所以换状态目录、换设备或手工改动日历都不在覆盖范围内。

超时不会返回笼统失败，而是返回 `status: "unknown"` 与可持久查询的 `operationId`。该写入不会被自动重发：先用 `get_garmin_calendar` 读取日历，再用 `reconcile_garmin_write_operation` 记录观测结果，之后只对 `resume_garmin_write_operation` 判定为安全的条目执行恢复，或改用其他日期/模板。核对观测到条目存在不等同于写入回执，原步骤仍保持 `unknown`。

### 9.11 `batch_schedule_garmin_workouts`：批量安排多天或多周

用途：一次预览并安排 1–100 条未来训练。

示例：

```json
{
  "timezone": "Asia/Shanghai",
  "schedules": [
    { "workoutId": "easy-001", "date": "2026-09-14" },
    { "workoutId": "tempo-002", "date": "2026-09-16" },
    { "workoutId": "easy-001", "date": "2026-09-18" },
    { "workoutId": "long-003", "date": "2026-09-20" }
  ]
}
```

步骤：

1. 先读取训练库，获得每个模板的真实 ID。
2. 只把训练日放进 `schedules`。
3. 休息日不要创建空训练，也不要伪造 `rest` Workout。
4. 第一次调用只生成批量预览。
5. 逐条检查日期、训练名称和时区。
6. 用户确认后，原样提交并补充确认字段。
7. 查看 `successCount`、`skippedCount`、`unknownCount`、`notAttemptedCount`、`definiteFailureCount` 和每条 `results`。

批量操作遇到某一条失败时会继续处理其他条目。因此：

- 不能把部分成功说成全部成功。
- 不能默认自动撤销已经成功的条目。
- 超时返回 `status: "unknown"`，该条**不会重发**。先用 `operationId` 核对 Garmin 日历，再决定是否改用其他日期或模板。
- `successCount` 统计 `succeeded` 与 `skipped`；旧字段 `failureCount` 等于 `总数 − successCount`，表示“未确认完成”，**不是**确定失败数。新调用方应依据逐条 `status` 与 `definiteFailureCount` 判断，绝不能拿 `failureCount` 触发重试。
- 同一批中相同训练和相同日期会在预览阶段被拒绝，不会发出任何写入。
- 已确认但尚未发出的条目不会获得永久授权；账号变化、存储不可写、锁丢失或确认过期都会停止后续写入，剩余条目标记为 `not_attempted`。

### 9.11.1 完整流程示例：下周五次跑步（周一、二、四、六、日）

周三和周五是休息日，**不生成任何训练**，而是直接从 `schedules` 中省略。下面是一条完整链路：查询 → 预览 → 确认 → 逐项回执 → 查询操作 → 核对 → 仅恢复安全项。

1. **查模板**：调用 `get_garmin_workouts`，拿到轻松跑、门槛跑、长跑的真实 `workoutId`。
2. **查日历**：调用 `get_garmin_calendar`，传入目标周（例如 `startDate: "2026-09-14"`、`endDate: "2026-09-20"`）和 `timezone`，确认这 5 天已经有了什么。
   - 返回的 `entries` 是观测到的条目，`complete` 才说明这段范围被完整读取。读取失败或能力不支持时返回 `CALENDAR_QUERY_UNSUPPORTED`，**不会**退化成“空日历”。
   - 空结果不能证明没有条目，也**不会**被当作授权写入的依据；它只用于帮助用户判断日期选择。
3. **预览**：调用 `batch_schedule_garmin_workouts`，只带 5 条 `schedules` 和 `timezone`。返回 `requiresConfirmation: true`、`confirmationId` 和 `operationId`，此时**没有发出任何写入**。
   - 若返回 `requiresConfirmation: false`，说明这 5 条都已存在或被阻断，**不会**签发确认 ID，也不会写入。
4. **展示并确认**：把 5 条日期 + 训练名 + 时区展示给用户；批准后原样重发，补 `confirmed: true` 和该 `confirmationId`。确认句柄是 `<operationId>:<预览版本号>`，十分钟内有效、只能用一次；重新预览会使其失效，但未过期的句柄在服务重启后仍可解析。
5. **查看逐项回执**：逐条读取 `status` 与 `evidence`。
   - `succeeded`：已写入，`evidence` 来自 Garmin 的响应。
   - `skipped`：日历读取已显示该条目存在，本次没有写入（目标状态已满足）。
   - `not_attempted`：被阻断或未发出。若是因为认证失效、调用取消、存储错误、身份变化、确认授权到期或锁丢失而停止，它**不会**被自动重发，可安全重新预览。
   - `failed`：有证据证明未生效，可重新预览后重试。
   - `unknown`：**不要重试**。记下 `operationId`。
6. **查询操作记录**：用 `get_garmin_write_operation` 读取该 `operationId`（`operationId` 与 `idempotencyKey` 二选一，两者都不传则列出最近记录，`limit` 默认 20、最大 100）。返回每条步骤的真实状态，以及 `canResume`、`manualReviewRequired`、`nextAction`。
   - 返回 `OPERATION_NOT_FOUND` 时，「不存在的 ID」和「属于其他账号的 ID」是同一个响应：确认账号与 `GARMIN_STATE_DIR` 是否与写入时一致，不要靠换 `idempotencyKey` 重试。
7. **核对**：用 `reconcile_garmin_write_operation` 在固定预算内（最多 3 次读取、20 秒）重读 Garmin。
   - `observed_present` 表示目标状态已满足，但原步骤**保持** `unknown` —— 观测无法证明该条目是本次请求造成的；核对只记录证据，从不改写 `status`。
   - 因此 reconcile 之后 `canResume` 仍可能为 `false`。空的读取结果不能证明任何事情，也永远不会授权自动重发。
   - 未出现且请求早已结束 → 只有两种安全做法：把**同一训练**改到别的日期，或把**别的训练**放到同一日期。
8. **只恢复安全项**：`resume_garmin_write_operation` 先返回预览（`previewRevision` 递增）。它只为**从未下发过**的步骤装载写入（`prepared`、`failed`、`not_attempted`）；`succeeded` 列为 `skip_existing`，`unknown` 列为 `blocked`，两者都不会被再次发出。确认该预览后提交剩余步骤，结果按条返回 `evidence` 与 `desiredStateSatisfied`。
   - resume 不是迁移替代，也不能覆盖原有历史：它只追加本次下发的步骤记录。
   - 逐个分支都可复现：参见 `tests/write-coordinator.test.ts`、`tests/write-recovery.test.ts` 与 `tests/write-create-recovery.test.ts`。

无论走到哪一步：不要删除状态目录，不要用重发同一写入“清掉” unknown，也不要为了绕过阻断而改 `idempotencyKey`——这些做法都不会移除记录，反而可能产生重复条目。

### 9.12 `create_and_schedule_garmin_workout`：创建并安排一条训练

用途：在一次确认流程中，创建一个新 Workout，并把它安排到指定日期。

示例：

```json
{
  "workout": {
    "name": "周日长跑 18 公里",
    "sport": "running",
    "steps": [
      {
        "type": "interval",
        "endCondition": "distance",
        "endValue": 18000,
        "target": "open"
      }
    ]
  },
  "date": "2026-09-20",
  "timezone": "Asia/Shanghai"
}
```

步骤：

1. 提交训练定义和日期，获得预览。
2. 确认训练步骤和日期。
3. 用户明确批准后，使用相同请求附加确认字段。
4. 检查返回的 `workoutId`、`workoutScheduleId` 和 `success`。

可能出现部分结果：训练已经创建，但 Garmin 没有返回 ID，或排期请求失败。此时不要重新创建同名训练；先检查训练库和日历，再按返回的 ID 继续处理。

### 9.13 `unschedule_garmin_workout`：取消日历排期

用途：从 Garmin Calendar 移除一条已排期记录。

它需要的是排期结果中的 `workoutScheduleId`，不是训练库的 `workoutId`。

示例：

```json
{
  "workoutScheduleId": "schedule-987654"
}
```

步骤：

1. 找到此前排期操作返回的 `workoutScheduleId`。
2. 第一次调用，检查要移除的 ID 预览。
3. 用户明确确认。
4. 用相同 ID 加 `confirmed: true` 和 `confirmationId` 再次调用。
5. 检查 `success: true`。

取消排期只移除日历记录，不删除训练库中的可复用模板。如果没有真实返回的排期 ID，不能自行猜测或编造。

### 9.14 `download_garmin_activity_fit`：下载活动 FIT 文件

用途：把一条 Garmin 活动导出成 `.fit` 文件保存到本机。

#### 先配置保存目录

在 MCP 环境变量中设置可信的绝对父目录：

```bash
export GARMIN_FIT_DOWNLOAD_DIR='/Users/你的用户名/Documents/garmin-fit'
```

客户端配置示例：

```json
{
  "GARMIN_FIT_DOWNLOAD_DIR": "/Users/你的用户名/Documents/garmin-fit"
}
```

#### 下载步骤

1. 先调用 `get_garmin_activities` 找到真实 `activityId`。
2. 调用：

```json
{
  "activityId": 123456789
}
```

3. 服务从 Garmin 下载 ZIP。
4. 解压并寻找唯一 FIT 文件。
5. 校验 FIT 文件头和 CRC。
6. 写入按区域和账号隔离的目录。
7. 返回文件名、大小和 SHA-256 摘要。

服务不会在工具结果中返回 FIT 二进制，也不会把完整本地路径或会话信息发送给智能体。

已有同名文件不会被覆盖。遇到 `OUTPUT_EXISTS` 时，不要删除旧文件来强行重试；换一个受控目录或先人工核对文件。

### 9.15 `get_garmin_calendar`：读取训练日历范围

用途：读取某段日期范围内已经存在的日历排期，不改动任何数据。

参数：

```json
{
  "startDate": "2026-09-14",
  "endDate": "2026-09-20",
  "timezone": "Asia/Shanghai"
}
```

- `startDate`、`endDate` 必填，闭区间，最长 366 天。
- `timezone` 可选，只用于在返回结果中回显时区标签；它**不会**移动日期。

返回的是一个「快照」，关键是**读取是否完整**：

- `entries` 是**实际观测到**的条目。
- `complete` 为真才说明整个范围都被读到。
- `warnings` / 未能读取的子区间会一并返回，表示哪些部分没有读到。

三条硬规则：

1. **读取不完整绝不等于空日历。** 读取失败或某个地区没有可核验的读接口时报 `CALENDAR_QUERY_UNSUPPORTED`，不会退化成「什么都没有」。
2. **任何范围读取都不能证明某次写入没有到达 Garmin。** 要回答这个问题只能用 `reconcile_garmin_write_operation` 对着本地日志核对。
3. **空结果不是写入授权。** 它只帮助用户选择日期，不能当作「没有冲突」的证明。

### 9.16 `get_garmin_write_operation`：查询本地写入日志

用途：不接触网络，直接读取当前账号在本地记录下来的写入操作。

三种调用方式，**互斥**：

```json
{ "operationId": "8a12…" }
```

```json
{ "idempotencyKey": "week-38-plan" }
```

```json
{ "limit": 20 }
```

- 用 `operationId` 或 `idempotencyKey` 查单条时，**不能**同时传 `limit` / `cursor`。
- 两个都不传则列出最近记录：默认 20 条，最多 100 条，返回 `nextCursor` 供翻页。
- `cursor` 是不透明本地令牌（不是路径），只在日志未变动时有效；一旦记录发生变化，返回 `staleCursor: true` 且**不含** `operations` 字段——因此空页永远不会被误认为「日志是空的」。

返回内容：

- 每条记录带汇总判断：`status`、`canResume`、`manualReviewRequired`、`nextAction`。直接用 `nextAction` 决定走核对还是恢复。
- 记录是**脱敏**的：原始幂等键、请求体、账号键都不会回显。
- 不存在的 ID 与属于**其他账号**的 ID 返回同一个 `OPERATION_NOT_FOUND`，所以这个查询不能用来探知别的账号写了什么。

这条查询不需要登录，也永远不会联系 Garmin——它只读本地磁盘。

### 9.17 `reconcile_garmin_write_operation`：只读核对（记录证据）

用途：针对一条结果不确定的操作，重新读取 Garmin，把可信观测记入本地恢复日志。

```json
{ "operationId": "8a12…" }
```

它**只记录证据**：

- 不发送任何排期 / 创建 / 取消请求，在 Garmin 上不删除任何东西。
- 结果不确定的步骤**保持不确定**，直到出现真实回执；核对不会改写 `status`。
- 观测到条目存在 → `desiredStateSatisfied: true`、结论为 `observed_present`；观测到不存在 → 如实报告 `absent`，并且不会改写此前的任何结果。
- 因为核对可能仍无法消除不确定性，之后 `canResume` 仍可能是 `false`。

读取有固定预算（最多 3 次读取、20 秒），所以核对不会无限重试。它更新的是**本地**状态，因此没有被标注为纯只读工具，但它从不修改 Garmin。

### 9.18 `resume_garmin_write_operation`：只恢复安全项

用途：从日志推导出「还没下发过」的剩余步骤，在用户批准后下发。

预览：

```json
{ "operationId": "8a12…" }
```

确认：

```json
{ "operationId": "8a12…", "confirmed": true, "confirmationId": "8a12…:1" }
```

要点：

- **没有载荷参数。** 日期、`workoutId`、模板定义全部取自日志记录，所以恢复不可能把写入挪到别的日期或换成别的模板——那是新请求，不是恢复。
- 只有**被证明从未生效**的步骤会被装载（`prepared`、`failed`、`not_attempted`）。
- `succeeded` 列为 `skip_existing`；`unknown` 列为 `blocked`，**永不重发**，也无法从这里清除。
- 预览返回 `previewRevision`；确认必须用该次预览签发的 `confirmationId`（`<operationId>:<previewRevision>`）。
- 下发本身不是幂等的：要拿持久结果请用 `get_garmin_write_operation` 重新查询，**不要**重复调用本工具。
- 恢复不是迁移的替代品，也不会覆盖既有历史，只追加本次下发的记录。

## 10. 日期、时区和训练日历规则

### 日期格式

必须使用四位年份、两位月份、两位日期：

```text
2026-09-15
```

以下写法无效：

```text
2026/09/15
26-09-15
2026-9-15
```

### 时区

优先显式填写 IANA 时区：

```text
Asia/Shanghai
America/Los_Angeles
Europe/London
```

省略时使用 MCP 服务所在电脑的时区，而不是智能体所在服务器或用户手机的时区。

### 训练日历和休息日

休息日不应创建 Workout。正确的批量计划只提交有训练的日期：

```json
{
  "schedules": [
    { "workoutId": "easy", "date": "2026-09-14" },
    { "workoutId": "quality", "date": "2026-09-16" },
    { "workoutId": "long", "date": "2026-09-20" }
  ]
}
```

但是，训练内部可以有 `rest` 或 `recovery` 步骤。这里的“休息日不创建”与“训练内部恢复段”是两件事。

## 11. 认证失效时怎么处理

### 支持 URL 登录提示的客户端

1. 工具返回认证要求。
2. 客户端显示本地登录 URL。
3. 打开 URL 完成 Garmin 登录和验证。
4. 关闭或完成浏览器流程。
5. 重新发起原工具调用。

服务不会自动重放原写入请求。用户必须重新确认任何创建、排期或取消操作。

### 不支持 URL 登录提示的客户端

先在项目目录执行：

```bash
node lib/auth-cli.js serve --account personal-codex --open
```

登录完成后重启或重新连接 MCP 客户端。

### 认证诊断命令

```bash
node lib/auth-cli.js --help
node lib/auth-cli.js login
node lib/auth-cli.js login --browser
node lib/auth-cli.js canary
```

日常 `serve` 使用系统浏览器，不要求安装 Playwright。`login --browser` 和 `canary` 是旧浏览器诊断入口，只有排查特殊登录问题时才使用。

## 12. 常见问题

### MCP 客户端找不到服务

检查：

1. `lib/mcp.js` 是否已经生成。
2. `command` 是否是 Node 的绝对路径。
3. `args` 是否是 `lib/mcp.js` 的绝对路径。
4. 客户端是否完全重启。
5. `GARMIN_USERNAME`、`GARMIN_ACCOUNT` 和会话文件是否写在正确的 `env` 中；区域由服务固定为中国区。

### 缺少 `GARMIN_USERNAME`

在客户端的 `env` 中配置邮箱，或在 MCP 启动工作目录的 `.env` 中配置：

```text
GARMIN_USERNAME=your@email.com
```

不要把密码写入聊天消息。

### 会话过期

使用同一个账号别名、区域和会话路径重新运行 `serve`。不要随意删除旧会话文件，也不要把一个账号的会话复制给另一个账号。

### 训练排期后看不到手表

先分层检查：

1. 工具是否返回了成功。
2. Garmin Calendar 是否出现排期。
3. 手表是否兼容该类型 Workout。
4. Garmin Connect 和手表是否完成同步。
5. 手表网络、电量和同步状态是否正常。

项目只能确认请求是否得到接口结果，不能保证 Garmin 当前服务端或手表同步一定接受非官方排期接口。

### 批量排期部分失败

查看返回的 `successCount`、`failureCount` 和逐条 `results`。先检查成功条目和失败条目在 Garmin Calendar 中的实际状态，再重试失败项。不要直接重复整个批次。

### 取消排期失败

确认使用的是 `workoutScheduleId`，不是 `workoutId`。如果之前的排期响应没有返回排期 ID，项目不会替你猜测。

### FIT 下载失败

检查：

1. `GARMIN_FIT_DOWNLOAD_DIR` 是否是绝对路径。
2. 目录是否由当前用户拥有并可写。
3. `activityId` 是否来自真实活动。
4. 目标文件是否已经存在。
5. 磁盘空间是否足够。

### Windows 首次响应较慢

Windows 首次运行本地 PowerShell 权限检查可能较慢，项目为原生检查保留了有上限的等待时间。不要因此关闭会话文件权限检查。

## 13. 隐私和安全

- 只在本地浏览器的 Garmin 表单中输入密码和验证码。
- 不要提交 `.env`、session JSON、FIT 文件或包含精确位置的活动详情。
- `full` 活动详情可能包含路线和位置，默认优先使用 `compact`。
- 会话文件应保持仅当前用户可读写。
- MCP stdout 只用于协议消息，日志写 stderr。
- 服务会对上游异常和日志做敏感字段脱敏。
- FIT 文件输出目录必须由用户明确配置，且不会覆盖已有文件。
- 健康数据和跑步建议不构成医疗诊断。

## 14. 开发和验证

在项目目录执行：

```bash
npm ci
npm run lint
npm test -- --runInBand
npm run test:coverage
npm run pack:smoke
npm run test:distribution
```

命令说明：

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 清理并编译 TypeScript |
| `npm run lint` | 运行 ESLint，不自动修改文件 |
| `npm test` | 运行 Jest 测试 |
| `npm run test:coverage` | 运行覆盖率测试 |
| `npm run pack:smoke` | 审计打包内容和依赖 |
| `npm run test:distribution` | 将打包产物安装到空目录并测试真实 stdio 启动 |
| `npm run test:integration` | 使用真实会话执行只读 Garmin 检查，不能在无账号时运行 |

本地集成检查不会创建训练、排期或删除排期。真实 Garmin 写入仍应由用户在 MCP 客户端中逐次确认。

该脚本默认只读 activities/sleep/steps/heartRate/weight/workouts/profile，**不读日历**。若要验证日历读取，
须显式授权一个区间，并开启 verbose 才会打印字段（否则只回答"能否读到"）：

```sh
GARMIN_INTEGRATION_VERBOSE=true \
GARMIN_CALENDAR_PROBE_RANGE=YYYY-MM-DD..YYYY-MM-DD \
npm run test:integration
```

未设置区间时日历探针输出 `skipped`，**这不等于通过**。区间没有默认值，避免对未选定的日期制造证据；
格式非法的区间会直接判失败且不回显原值。探针结果为 `passed` / `failed` / `refused` / `skipped` 四种：
**调用返回不代表读取成功**——适配器把传输失败 catch 成 `[CHUNK_READ_FAILED]` 后正常 resolve，因此带读取失败
warning 的快照判 `failed` 而非 `passed`；`refused` 表示该账号/区域不可查询，**没有发出任何请求**。
`failed` 与 `refused` 都会让退出码非零。详见
[calendar API verification](calendar-api-verification.md#7-the-minimum-read-only-authorisation-that-would-close-6)。

## 15. 功能边界

当前项目明确不承诺：

- 自动生成并执行完整长期训练计划。
- 跨状态目录的自动去重：去重保证是**本地的**，只覆盖共用同一 `GARMIN_STATE_DIR` 的机器（同一状态目录内的重复请求会被跳过或阻断，见 9.10 与 9.11）。
- 自动把休息日写入 Garmin。
- 自动重试可能已经成功的写入请求。
- 取消没有真实 `workoutScheduleId` 的排期。
- Garmin 官方 API 的长期兼容性。
- 所有 Garmin 手表型号都能同步所有 Workout 类型。
- 医疗诊断或伤病处方。

项目保留原始 MIT 许可证和上游来源说明。它是社区项目，不是 Garmin 官方产品。

## 16. 快速检查清单

第一次使用：

- [ ] Node.js 20+ 已安装。
- [ ] 已克隆并运行 `npm ci`。
- [ ] 已选择正确 Garmin 区域。
- [ ] 已完成浏览器登录。
- [ ] 已确认会话文件路径。
- [ ] 客户端使用了 Node 和 `lib/mcp.js` 的绝对路径。
- [ ] 已先用读取工具测试连接。

第一次写入训练：

- [ ] 先查询或明确训练定义。
- [ ] 先看预览。
- [ ] 用户明确批准。
- [ ] 使用原请求、`confirmed: true` 和正确的 `confirmationId`。
- [ ] 保存返回的训练 ID或排期 ID。
- [ ] 超时返回 `unknown` 与 `operationId` 时，先核对 Garmin，再改用其他日期或模板；不要重发同一条写入。

第一次批量排期：

- [ ] 已用训练库获得真实 `workoutId`。
- [ ] 所有日期格式正确。
- [ ] 已填写正确 IANA 时区。
- [ ] 休息日已省略。
- [ ] 同一批没有重复的训练和日期组合。
- [ ] 已逐条检查预览。
- [ ] 已准备处理部分成功和部分失败。
