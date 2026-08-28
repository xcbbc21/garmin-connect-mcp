# 发布测试报告

[English](./TEST_REPORT.md)

本页面是基于 `0.1.5` package manifest 的当前 `Unreleased` 修改静态验证快照，记录
已经验证的范围、主动排除的操作，以及仍需人工验证的项目。

> **验证范围：** 下列自动检查已在本机源码树重新执行。新的系统浏览器与 MCP 认证路径
> 已有离线覆盖，但中国区和国际区真实账号的完整 MFA 浏览器到刷新链路完成前，仍只按
> 预览功能说明。

## 验证概览

| 项目 | 结果 |
| --- | --- |
| 测试日期 | 2026-08-28 |
| package manifest | `0.1.5` + `Unreleased` 修改 |
| 发布就绪度 | **自动门禁通过** — 真实账号 MFA 端到端仍为预览 |
| 本机自动测试 | **通过** — 36 个套件、736 项测试 |
| TypeScript 构建 | **通过** |
| npm 打包烟测 | **通过** — 163 个文件；压缩后 281.6 kB；解压后 1.1 MB |
| 真实 Garmin 集成 | **本次未重跑** — 2026-08-21 的 `global` 只读基线为 8/8 |
| 两步验证 | **预览** — runtime/broker/MCP 离线覆盖通过；真实 CN/global E2E 待完成 |

## 自动验证

在 Node.js 20 或更高版本中，可以用以下命令复现自动检查：

```bash
npm ci
npm run test:coverage
npm run build
npm run pack:smoke
```

### 测试与覆盖率

| 指标 | 结果 |
| --- | ---: |
| 测试套件 | 36 个通过 |
| 测试 | 736 项通过 |
| 语句覆盖率 | 85.56% |
| 分支覆盖率 | 79.32% |
| 函数覆盖率 | 87.04% |
| 行覆盖率 | 88.45% |

`npm run build` 已成功完成。`npm run pack:smoke` 也已通过，检查的 npm 包包含
163 个文件（包含新的本地认证与 MCP 认证 runtime、更新日志及中英文测试报告页面），
压缩后大小为 281.6 kB，解压后大小为 1.1 MB。

测试还覆盖了绝对路径、有界且无 shell 的 Windows PowerShell/.NET ACL 边界、静态编码的
精确 DACL 程序、当前 SID owner、全链重解析点与不可信根目录拒绝、逐层目录 fail-closed
验证/创建，以及在写入凭据字节前先保护空临时文件的顺序。CI 已新增 `windows-latest` 任务，用真实
Windows ACL API 运行该套件；本机快照未执行该远端任务。

POSIX 覆盖还包括有效 UID owner 与 owner 写入/执行权限、不安全祖先拒绝、安全链接规范化、
逐级 `0700` 预创建、no-follow 临时文件，以及原子替换前的父目录/文件再次验证。读取时也会
规范化安全父目录别名，并在绑定已打开文件描述符前后验证完整祖先链和最终私有父目录。
本机 macOS 套件还真实创建了继承式及文件级扩展 ACL：即使 mode 是 `0700`/`0600`，任何
授权型 ACL 仍会被拒绝，系统 deny-only ACL 则可保留。CI 已新增 `macos-latest` 任务重复
这些 Darwin 专项检查。

认证覆盖还包括：Web/CLI/MCP 启动桥页前共用目标目录预检、按内容指纹热加载另一本机进程
写入的 session、锁定版本 SDK 的 MFA/ticket 失败转换、可由信号中止的终端提示、系统浏览器
启动器非零退出、MCP 完成通知超时边界，以及保存进入不可取消提交点后的排空等待，避免把
仍可能成功的原子写入误报为“已取消”。测试还覆盖 Web 在不可取消写入期间卸载、broker 与
controller 的排空超时不串行叠加、失效内联 token 只能由账号绑定 session 接管，以及 MCP
stdin/退出信号关闭会在有界凭据清理结束前持续拦截终止信号。CLI 的 browser、canary 与
`serve` 关闭同样给首个信号一个有界优雅退出窗口，第二个信号则立即请求强制退出。

## 真实 Garmin 只读集成

本次快照没有重跑真实 Garmin 集成。下表是 2026-08-21 使用本机私有 `.env`、连接
Garmin `global` 区域得到的 `0.1.5` 历史只读基线：

```bash
GARMIN_INTEGRATION_VERBOSE=false npm run test:integration
```

以下 8 项检查全部通过：

| 检查项 | 结果 |
| --- | --- |
| 身份验证／密码登录 | 通过 |
| 活动 | 通过 |
| 睡眠 | 通过 |
| 步数 | 通过 |
| 心率 | 通过 |
| 体重／身体成分 | 通过 |
| 训练库 | 通过 |
| 用户资料 | 通过 |

此前运行严格限于只读接口，没有创建、更新、安排或删除训练，也没有修改其他 Garmin
数据。运行时明确关闭了 verbose 输出，因此只显示状态和数量，不显示账号标识、活动
明细或健康数值。

## 中国区浏览器 MFA／DI 局部验证

经账号所有者明确同意，2026-08-21 使用可见 Chrome 完成了 Garmin 托管的中国区登录，
并产生一张短期 service ticket。受限诊断程序另行完成了一次中国区 DI ticket 交换和
profile API 探测。全程只输出固定阶段名，没有打印邮箱、密码、MFA 验证码、Cookie、
ticket、Token、profile 数据或响应正文。

这仍只是真实账号的局部证据，不代表新流程已经完成端到端验证。当前自动测试已经覆盖
共享 loopback runtime、ticket 交换、显式 profile 确认、仅所有者可读的 session 提交、
无 shell 的系统浏览器启动、终端清理、缺失／过期／拒绝三类凭据状态、MCP URL
elicitation、完成通知、并发流程共用及同进程 session 替换。这些测试使用受控 fixture 和
模拟 Garmin DI HTTP，不能替代中国区与国际区各一次真实 MFA 验证。

## FIT 导出验证

本次验证没有真实下载 FIT 文件，以免在未经用户明确同意时把个人活动文件写入本机。

自动测试已经覆盖 FIT 目标目录规则、ZIP 处理、CRC 校验和安全解压行为。新下载使用
以下目录结构：

```text
<GARMIN_FIT_DOWNLOAD_DIR>/
  GARMIN_FIT_<cn|global>_<规范化邮箱>/
    <activityId>.fit
```

已有的 `GARMIN_FIT_<邮箱>` 目录**不会自动迁移**。旧文件继续保留在原目录中；只有
新的下载会进入带区域标志的
`GARMIN_FIT_<cn|global>_<规范化邮箱>` 目录。

由于没有执行真实导出，本报告不声称已经端到端验证 Garmin 压缩包下载、本地 `.fit`
文件落盘，或将该文件导入设备及第三方应用。

## 已知验证缺口

以下场景尚未使用真实账号或客户端完成端到端验证：

- 使用真实中国区和国际区 MFA 账号完整运行 `garmin-connect-auth serve`，再分别通过
  dsh/MCP 使用并刷新保存的 session。
- 在 Codex、Claude Code 等具体客户端中验证 MCP URL elicitation、完成通知与重试；
  当前仅离线覆盖能力回退。
- 在真实 `windows-latest` runner 上执行新增 ACL 烟测；workflow 已加入，但本机 macOS
  快照无法执行该任务。
- WorkBuddy MCP 客户端烟测。
- ZCode MCP 客户端烟测。
- 真实 FIT 下载以及后续文件导入。

这些项目是本次报告明确记录的限制，不代表测试通过。

## 隐私与发布说明

- 集成测试使用的私有 `.env` 不属于本报告，禁止提交或发布。
- 本报告不包含密码、session token、MFA 验证码、账号标识、本地目标路径、活动明细
  或健康数值。
- 2026-08-28 本次快照没有执行 Garmin 数据写操作或真实浏览器认证；session 持久化只用
  合成凭据在隔离的临时／测试位置中验证。
- package manifest 仍为 `0.1.5`；新认证工作记录在 `Unreleased`，本次验证没有发布它。

后续每个候选版本都应重新运行上述自动检查。真实 MFA、FIT 及客户端烟测只能在账号
所有者明确同意后执行，并继续使用同等的隐私保护措施。
