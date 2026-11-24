# local-diagnostic-logging Specification

## Purpose

为 Fiction Writer 提供仅保存在本地、按日追加并保留 30 个本地自然日的前后端诊断日志。通过关联标识追踪界面操作、Agent 运行和文件变更，便于排障，不记录凭据或创作内容，也不阻塞应用主功能。

## Requirements

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

### Requirement: Skill dispatch and novel writing results are traceable
默认诊断 SHALL 能按同一 Run 和工具调用区分内置 Skill 检索、资源读取或加载、所选指令进入实际模型请求、小说工具执行以及磁盘结果。日志 SHALL 仅记录已注册能力标识、资源指纹、候选数、安全状态和关联标识；请求发出不表示模型遵循 Skill。单章工具内部的只读取材与正文流 SHALL 保留各自的请求、预览和提交诊断。续写 SHALL 记录目标章和跳过已有内容的原因，不依赖固定阶段或检查点事件。

#### Scenario: Trace discovery and use without confusing loaded resources with execution
- **WHEN** Agent 检索写作 Skill，候选不止一个，选择 `generate-novel` 后调用作品工具
- **THEN** 日志可串起候选与选中的标识、选中资源指纹、其实际发往模型的请求、后续工具执行与文件提交；不把其他候选记为已激活，不保存搜索词、生成指令或工具内容

#### Scenario: Trace rejected references and distinct chapter stream failures
- **WHEN** 合成场景触发不存在的伏笔目标、前两章落盘后第三章提前结束，或者第三章返回终止事件但达到输出上限
- **THEN** 日志能区分写入前的无效引用拒绝、未完成流和达到输出上限，关联发生失败的工具、请求或安全章节引用；不保存用户文档的原始 ID、异常正文、流事件或稿件片段

#### Scenario: Readback and drafting inside the chapter tool have separate evidence
- **WHEN** 写章工具先只读取材再流式生成正文，部分补读命中或没有匹配，随后提交或者取消
- **THEN** 日志能区分两类请求、补读命中/缺失、预览开始/结束及最终提交结果，不写查询关键词、引用片段或生成正文

#### Scenario: Whole-book continuation reports why existing chapters were skipped
- **WHEN** 第三章未成功保存而整书中断，用户重启后通过同一输入框明确继续
- **THEN** 日志可查核对现稿后的目标章、已保存章被跳过和目标章重新生成的结果，不把可继续状态当作已有提交

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

### Requirement: Book memory recall and index outcomes are traceable
后台 SHALL 为 Agent 自动召回、正文自动召回和显式 `book_memory_recall` 写入可区分来源的诊断终态，关联同一运行、已绑定作品和本次召回；显式工具另可关联调用。成功时 SHALL 记录已存正文证据、计划、参考资料及作者约定各自的条数，区分空结果、失败和取消。处理索引时 SHALL 区分复用、首次建立、实际持久化刷新和内存降级；读异常、格式无效和写失败 SHALL 可区分。诊断本身不得改变召回结果、写章或作者约定的提交行为。

#### Scenario: Distinguish an empty recall from an unavailable recall
- **WHEN** 两次有效召回分别有命中和无匹配，另有一次失败或取消；入口覆盖 Agent、写章与显式回忆工具
- **THEN** 日志明确关联每个来源及结果，成功空结果的证据和约定计数均为零，失败或取消不记为成功空结果；显式工具可以按调用 ID 对照

#### Scenario: Observe lazy refresh only after a successful sidecar write
- **WHEN** 首次召回建立索引，随后又在现稿未变、外部编辑以及删除来源后分别召回
- **THEN** 初建、未写入的复用和真正写入的刷新状态可区分，编辑或删除造成的来源失效可见；不会为正常初建报错或把达到缓存上限的条目称为失效

#### Scenario: Degraded index use is not a successful refresh
- **WHEN** 侧车读取被拒、内容无法解析或原子替换失败，当前 Markdown 仍然可读
- **THEN** 日志分别显示读取、格式或写入降级，仍可报告从现稿召回的正确计数；不记录成刷新成功、不阻止读取或正常写章，也不把显式约定保存失败记成成功

### Requirement: Dispatched model context identifies the book memory it carried
后台 SHALL 仅在含有非空自动召回内容的模型请求实际交给传输层后记录该次携带事实，区分 Agent 请求与正文生成请求。事件 SHALL 关联召回与本次模型 `spanId`，有界地记录发送的类别计数、唯一来源的安全文档及修订指纹、已知的来源章序。诊断 MUST NOT 将计划、命中、开始构建请求或实际派发当作模型采用。新增事件 SHALL 沿用仅本地、worker 白名单、非阻塞写入和原有留存规则。README SHALL 说明如何按 `runId`、`recallId`、`spanId` 核对这些证据及其边界。

#### Scenario: Correlate early chapter evidence with the actual prose request
- **WHEN** 受控测试让第 25 章的新会话在 Agent 和独立正文请求中分别带入第 2 章的有效证据
- **THEN** 本地日志能按来源和模型 `spanId` 区分两个请求，列出的来源指纹、章序、类别和计数与请求实际携带的证据一致，独立书籍的来源不得混入

#### Scenario: Empty recall or no dispatch does not imply model context
- **WHEN** 自动召回为空，或有命中但随后因预算、取消等原因未发起相应模型请求
- **THEN** 可以看到召回的真实终态；没有对应的记忆携带事件，也不在只读补读、会话摘要请求中冒记携带

#### Scenario: A prose retry keeps distinct transport evidence
- **WHEN** 同一章在允许的断流恢复中复用已验证的召回并实际派发两次正文请求
- **THEN** 两次派发使用各自的 `spanId` 并关联原召回；若校验冲突阻止重试，仅保留已经实际派发的记录

#### Scenario: Memory diagnostics remain bounded and contain no creative content
- **WHEN** 合成检索词、约定、正文、文档 ID、标题、路径、密钥和错误原文含有独特标记，并触发召回、缓存降级及派发；同时注入越界诊断字段或模拟日志不可写
- **THEN** 两份日志无这些原始标记，worker 外来源和超合同字段被拒；每个请求最多记录 8 条去重来源明细，额外来源只计数；诊断故障不影响模型请求和作品状态
