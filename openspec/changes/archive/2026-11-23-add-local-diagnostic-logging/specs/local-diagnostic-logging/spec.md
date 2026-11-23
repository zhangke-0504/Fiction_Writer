## ADDED Requirements

### Requirement: Local daily append-only diagnostic files
应用 SHALL 在实际 Electron 用户数据目录下的 `logs/` 中为 renderer 和后端分别追加 UTF-8 JSONL：`frontend-YYYY-MM-DD.jsonl` 和 `backend-YYYY-MM-DD.jsonl`；后端文件包含主进程与后台 worker，须区分来源。日文件按接纳事件时的本地日期选择，不随 UI 切页、重启或后台重启而清空，也不上传。正常启动须写后端启动和前端就绪记录；未就绪时不伪造前端状态。记录的时间、启动标识和来源应能区分同日多个应用运行实例。

#### Scenario: Append distinct startups to the same day's files
- **WHEN** 应用在同一个本地自然日正常启动、退出，然后重新启动
- **THEN** 两份原有文件保留第一次的记录且新增第二次的启动记录，两个 `bootId` 不同，不生成额外的每日主文件

#### Scenario: Use the actual application data directory
- **WHEN** Windows 正常启动，或 E2E 显式覆盖应用数据目录
- **THEN** 日志位于当次实际的 `userData/logs`，不写到作品库、源码仓库或另一个实例的默认目录

#### Scenario: Rotate at local midnight without restart
- **WHEN** 应用在本地午夜两侧接纳事件，包括一次与 UTC 日期不同的本地日期
- **THEN** 事件写入自己的本地日文件；即使写入队列跨过午夜，已分配的有效日期也不被更改

#### Scenario: New records remain readable after a truncated line
- **WHEN** 前一次异常退出留下了没有换行结尾的残缺记录，下一次仍在同一天运行
- **THEN** 旧文件不被覆盖，新启动记录从独立行开始，可以作为 JSON 解析

### Requirement: Keep a thirty-local-day diagnostic window
应用 SHALL 在启动和运行中跨日时维护今天及前 29 个本地自然日的日志窗口，按文件名中的有效日期而非修改时间删除过期的普通日志文件。清理不得作用于诊断目录之外、非本应用格式、无效日期或链接；时钟回拨时不把未来日期误判为过期。应用关闭时无守护进程，下次启动执行维护。迟到记录不得在清理后重建已经过期的文件。

#### Scenario: Prune only dated diagnostic files past the cutoff
- **WHEN** 在日期 D 启动，目录有 D、D−29、D−30 的两类日志、时钟回拨造成的未来文件，以及命名相似但日期无效的文件、链接和无关文件
- **THEN** 只删除日期 D−30 的本应用普通日志，D 和 D−29 保留，无关、无效、未来和链接目标不受影响

#### Scenario: Retention advances while the app is still running
- **WHEN** 应用持续打开并跨入新的本地自然日，或跨日休眠后恢复，且没有重新启动
- **THEN** 清理使用新的截止日，不依赖用户再启动应用；晚到的旧日事件不会让超期文件重新出现

### Requirement: Correlatable lifecycle and operation metadata
诊断事件 SHALL 有稳定事件名、严重级别、时间、来源和本次启动的关联标识；应用启动的版本信息、窗口和 worker 实例应可区分。前后端关键操作须能通过请求标识对应，运行被接纳后关联既有 `runId`。应用 SHALL 记录 Run 开始和明确终态、拒绝、停止请求与结果、Session 创建/删除及工作区失效，并记录可以观察到的界面加载错误、渲染退出及后台退出/重启，不记录任意 UI 输入或原始 IPC 载荷。

#### Scenario: Join frontend and backend records for a run
- **WHEN** 用户从界面发起一次 Harness 运行并完成，期间另一工作区有独立运行
- **THEN** 日志可从该操作的 `requestId` 关联到正确的 `runId`、前端操作及后端终态，不把并发运行的事件混到同一上下文

#### Scenario: Diagnose a rejected request before a run exists
- **WHEN** 运行请求因附件、配置或工作区条件而被拒绝，还未创建 Run
- **THEN** 可用同一 `requestId` 对照前端显示和后端拒绝原因，不虚构 `run.started` 或记录附件和配置原值

#### Scenario: Record a worker restart and a renderer startup failure
- **WHEN** 受控场景使后台进程退出后重启，或使窗口加载失败而未就绪
- **THEN** backend 写明已观察的阶段、来源和可用原因，重启的 worker 有新实例标识但仍同属该应用启动；未就绪的界面不记成功

### Requirement: Agent rounds, model requests and tool decisions are traceable
默认诊断 SHALL 记录每个实际 Agent loop 轮次的开始、结束及继续/终止理由，每个模型请求的来源阶段、协议、配置引用、结果、耗时、HTTP 状态和首个流事件耗时（如可测）。工具留痕 SHALL 从候选请求开始，区分解析/校验、是否实际执行、执行结果及是否已将结果送往下一模型请求；允许的字段名或数量、退出码、取消、超时、截断和安全错误类别应在适用时可查。不记录模型原始流、命令或工具结果内容。

#### Scenario: Trace a successful multi-round tool call
- **WHEN** 合成模型请求合法工具，实际执行后继续下一轮，每轮各自流式返回
- **THEN** 日志能按 Run、轮次、模型请求和本地调用 ID 串起请求、通过校验、执行、结果回传及最终停止原因

#### Scenario: A bad tool candidate is rejected without claiming execution
- **WHEN** 模型给出未知工具名、非法参数或不完整的工具 JSON
- **THEN** 诊断记录候选与拒绝的安全原因，不写原始输入，不误记实际执行；从后续事件可判断 loop 是否继续

#### Scenario: Distinguish command timeout from successful tool transport
- **WHEN** 命令执行跑到时限或返回非零退出码，工具包装器仍把结构化结果返回模型
- **THEN** 日志区分工具运输层正常、命令未成功，记录退出或超时、耗时和取消后可观察到的终止状态，不记录命令文本和输出

#### Scenario: A failed model connection or stream has a bounded diagnosis
- **WHEN** 模型鉴权失败、响应中断、解析失败或用户停止流
- **THEN** 日志标明同一请求的已到达阶段与明确结果，保存可用的协议、状态和耗时，不能漏记成只有开始，也不写原始响应/鉴权信息

### Requirement: Skill application and novel workflow stages are traceable
诊断 SHALL 区分 Skill 读取/验证与某条写作路径实际采用该 Skill，记录静态标识、版本或资源指纹、使用阶段和原因，不伪称已证明模型遵循。单章直写、长篇回读与整书生成即使绕过通用 loop，也 SHALL 留下实际发生的模型请求、取材决定、预览生命周期、阶段结果、跳过、检查点保存和恢复记录。

#### Scenario: Distinguish loaded resources from the skill applied to the run
- **WHEN** 小说会话载入多份 Skill 资源但只启动「单章续写」或「故事一致性」其中一种路径
- **THEN** 日志分别记录已加载的资源和实际使用的 Skill，不把未选择的资源记成已执行，不记录 Skill 注入后的提示词

#### Scenario: Readback and chapter generation without a generic loop
- **WHEN** 写章路径先只读取材再流式生成正文，部分补读命中或没有匹配，随后提交或者取消
- **THEN** 日志能区分两类请求、补读命中/缺失、预览开始/结束及最终提交结果，不写查询关键词、引用片段或生成正文

#### Scenario: Whole-book resume reports why existing chapters were skipped
- **WHEN** 整书在某章失败后重启并继续，前面已有提交或手写章节
- **THEN** 可查阶段或检查点验证与恢复、跳过原因、目标章引用和最终结果，并能区分「沿用已完成」和「重新生成」

### Requirement: File commits and visible workspace revision can be compared
诊断 SHALL 记录受管理写入的类型、前提校验、成功/失败/部分提交、受影响文档的安全引用及可比对的修订标识，关联已发出的文件变更通知。前端 SHALL 记录受影响的通知序号、断档、重读结果、实际显示的修订或保留作者草稿的决定；不把通知发出当作界面已应用，也不将外部 watcher 推断为应用写入。

#### Scenario: A missed file change is diagnosable from the two logs
- **WHEN** 受控场景让后台完成小说文件写入但前端漏收该变更通知，随后检测到序号缺口并补读
- **THEN** 日志能对齐提交、通知序号、缺口、重读结果和实际应用的修订；无需读取稿件正文或会话历史即可看到问题经过

#### Scenario: Partial writes and human draft conflicts stay distinct
- **WHEN** 一批文件只有部分实际提交，或显示同一文档时作者有未保存草稿并收到了新文件修订
- **THEN** 日志分别标明已提交与未提交数量、修订/冲突和界面保留草稿的决定，不误记为整体成功或已经覆盖草稿

### Requirement: Diagnostic data is allowlisted and separate from user content
日志记录 SHALL 按事件白名单构造和校验，不接收任意消息、任意字段或将原始对象直接序列化。密钥、认证和解密资料、原始工具参数与输出、命令原文与输出、提示词、对话、作品内容、引用附件和隐藏推理 MUST NOT 进入日志；不保存用户路径、个性化标签及原始异常或堆栈可能带出的内容。诊断可保留安全标识和错误分类，独立于 Session 历史、作品和远端；删除 Session 不能通过诊断恢复会话。

#### Scenario: Sensitive fixture values stay out of both diary files
- **WHEN** 合成密钥、提示、正文、附件、命令及其输出、模型推理、路径和异常消息分别带有唯一敏感标记，运行成功与失败交替
- **THEN** 两份日志均无任何原始敏感标记，但仍可看到其请求、工具、文件或错误的安全诊断结果

#### Scenario: Reject data outside the renderer logging contract
- **WHEN** renderer 上报未注册事件、额外字段、伪造来源/标识或超限消息
- **THEN** 不写入它提供的任意内容，不改变可信来源或其他操作的诊断，正常编辑和请求仍能运行

### Requirement: Logging failures do not block the application
记录与刷盘 SHALL 异步并具有固定上界。正常写入时完整记录关键生命周期；溢出、文件不可写或清理失败不得阻塞或使业务失败，恢复后记录可知的诊断缺失数量。正常退出 SHALL 有限时的写入收尾，硬崩溃不承诺缓存内容均落盘；不得递归写失败日志或无限重试。

#### Scenario: Recover from a blocked log destination or full queue
- **WHEN** 模拟日志路径拒绝写入或大量事件超过队列上限，随后写入恢复
- **THEN** 主功能继续执行，队列不无限增长，有安全的恢复/丢弃摘要，后续日志能继续写入

#### Scenario: Flush without hanging a normal exit
- **WHEN** 应用正常退出时日志队列未空，分别模拟健康磁盘和卡住的写入
- **THEN** 健康情况下在受限收尾中写到退出事件；写入故障时应用不会无限等待或试图同步写入全部缓冲

### Requirement: README explains local troubleshooting
README SHALL 写明实际日志目录的来源、Windows 默认路径、两种日文件、30 天边界、关闭期间与硬崩溃的限制及如何按诊断编号查找两份文件。Harness 中适用的失败 SHALL 给出可复制的编号：已开始的运行使用 `runId`，启动拒绝使用 `requestId`。文档须说明不要为了排查提交外部日志或复制原始密钥配置。

#### Scenario: Locate and correlate files without developer tools
- **WHEN** 用户看到 Harness 运行失败或启动请求拒绝并打开 README
- **THEN** 可用界面的编号和 README 的 Windows 路径与命令，在本地两份日文件查找相关记录，不需要本地或远端日志平台
