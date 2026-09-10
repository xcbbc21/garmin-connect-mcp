---
name: garmin-connect-mcp
description: 通过已连接的 Garmin Connect MCP 读取运动和恢复数据、解释训练方法、预览并创建训练或安排日历、下载活动 FIT。适用于支持 MCP 的各类智能体；技能可选，不负责提供 MCP 工具。
---

# Garmin Connect MCP 使用指导

本技能是客户端无关的操作说明。普通 MCP 客户端不加载本技能也可使用全部工具。原项目贡献者见仓库 NOTICE.md。

## 连接与账号

先检查当前会话是否已有 Garmin 工具。没有时，读取 [连接说明](references/setup.md)；配置服务器并重新加载客户端后才能调用。使用用户提供的 GitHub 源码版本，不从 npm 下载同名包。

遵守已有授权与客户端权限设置。账号可能有歧义时先确定别名，不混合不同账号的数据。密码、验证码、令牌和会话内容不能进入对话。遇到缺失、过期或拒绝的凭据，使用服务提供的登录提示或独立认证命令。

## 按问题选择最少数据

读取工具：
`get_garmin_activities`、`get_garmin_sleep`、`get_garmin_steps`、
`get_garmin_heart_rate`、`get_garmin_weight`、`get_garmin_workouts`、
`get_garmin_profile`。

不要默认拉取所有数据。相对日期换算为明确的当地日期，并说明是否包含未结束的当天。按工具限制查询，超过 30 天的日范围分成互不重叠的批次。活动默认用 compact；full 可能包含精确路线，应与请求目的相符。

区分直接观察、推断和缺失数据。睡眠和静息心率只能作为有限恢复参考；当前工具没有完整的 HRV、Body Battery、训练准备度或训练负荷能力。不要用估算数据诊断疾病。

解释训练方法时使用 `get_running_skill_advice` 的 explain 模式。为具体用户制定训练时使用 personalized 模式，补齐工具要求的目标、成绩、训练经历、时间及恢复约束。用户已经明确给出的训练定义可以直接编码，不必重新制定计划。

## 创建训练和日历写入

这些写操作必须遵守工具代码内的预览与确认规则：
`create_garmin_workout`、`schedule_garmin_workout`、
`batch_schedule_garmin_workouts`、`create_and_schedule_garmin_workout`、
`unschedule_garmin_workout`。

1. 用户只要求分析或建议时，不写入 Garmin。
2. 首次省略 confirmed 或设为 false，取得预览及 confirmationId。
3. 展示已配置的目标账号别名、训练内容、日期、时区和操作范围；目标账号信息来自配置上下文，不要假定每种预览响应都包含账号字段。
4. 用户批准后，原样发送请求，补充 confirmed=true 和该 confirmationId。
5. ID 十分钟内有效且只能用一次。请求改变、服务重启或预览过期后，重新预览并确认。
6. 返回失败或结果不确定时，不自动重放；先核对 Garmin 的实际状态。

训练库是“练什么”，日历是“哪天练”。已有训练安排到单日使用 schedule；一次跨多天或多周使用 batch（1–100 条）；新建并安排单次训练使用 create_and_schedule。

先读取训练库获取真实 workoutId。日期使用 YYYY-MM-DD，优先显式填写 IANA 时区，例如 Asia/Shanghai。同一训练可安排在不同日期；同一批中相同 workoutId/date 会被拒绝。工具不提供跨请求全局去重，不能承诺重试不会重复排期。

休息日省略，不创建 workout。训练内部的 rest/recovery 步骤仍然合法。批量失败逐条报告，不能把部分成功说成全部成功，也不能默认撤销成功条目。创建成功但排期失败时保留并报告返回的 workoutId，避免重新创建同一模板。

取消排期需要排期结果的 workoutScheduleId；它不是 workoutId。没有返回排期 ID 时不能编造。取消移除日历记录，不删除训练库模板。

### 下周五次跑步示例

先查询已有轻松跑、门槛跑和长跑模板，将“下周一、二、四、六、日”换成明确日期，组成五条 schedules 和 timezone="Asia/Shanghai"。向用户展示预览；批准后再确认写入。周三和周五不作为条目发送。

## 活动 FIT

仅在用户要求下载时调用 `download_garmin_activity_fit`。先核对 activityId，并确认服务器配置了用户选择的 GARMIN_FIT_DOWNLOAD_DIR。不要传入额外路径参数，也不要删除已有文件以绕过 OUTPUT_EXISTS。报告文件元数据，不在对话中输出 FIT 二进制或会话凭据。
