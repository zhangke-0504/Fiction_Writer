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

### Requirement: Maintainer documentation explains local troubleshooting
维护者排障文档 SHALL 写明实际日志目录的来源、Windows 默认路径、两类日文件、30 天留存边界、应用关闭及硬崩溃时的限制，并说明如何按诊断编号查找两类文件。Harness 中适用的失败 SHALL 给出可复制的编号：已开始的运行使用 `runId`，启动拒绝使用 `requestId`。文档须说明不要为了排查上传原始日志或复制原始密钥配置。

#### Scenario: Locate and correlate files without a log platform
- **WHEN** 维护者拿到 Harness 运行失败或启动拒绝的诊断编号，并且能访问产生该编号的本机日志
- **THEN** 维护者可按排障文档中的 Windows 路径和命令，在两类日文件中查找相关记录，无需本地或远端日志平台

### Requirement: Book memory recall and index outcomes are traceable
后台 SHALL 为 写章工具按明确目标章取材和主 Agent 显式调用的 `book_memory_recall` 写入可区分来源的诊断终态，关联同一运行、已绑定作品和本次召回；显式工具另可关联调用。成功时 SHALL 记录已存正文证据、计划、参考资料及作者约定各自的条数，区分空结果、失败和取消。处理索引时 SHALL 区分复用、首次建立、实际持久化刷新和内存降级；读异常、格式无效和写失败 SHALL 可区分。诊断本身不得改变召回结果、写章或作者约定的提交行为。

#### Scenario: Distinguish an empty recall from an unavailable recall
- **WHEN** 两次有效召回分别有命中和无匹配，另有一次失败或取消；入口覆盖写章取材与显式回忆工具
- **THEN** 日志明确关联每个来源及结果，成功空结果的证据和约定计数均为零，失败或取消不记为成功空结果；显式工具可以按调用 ID 对照；未调用工具、未写章的首轮不产生预先召回终态

#### Scenario: Observe lazy refresh only after a successful sidecar write
- **WHEN** 首次召回建立索引，随后又在现稿未变、外部编辑以及删除来源后分别召回
- **THEN** 初建、未写入的复用和真正写入的刷新状态可区分，编辑或删除造成的来源失效可见；不会为正常初建报错或把达到缓存上限的条目称为失效

#### Scenario: Degraded index use is not a successful refresh
- **WHEN** 侧车读取被拒、内容无法解析或原子替换失败，当前 Markdown 仍然可读
- **THEN** 日志分别显示读取、格式或写入降级，仍可报告从现稿召回的正确计数；不记录成刷新成功、不阻止读取或正常写章，也不把显式约定保存失败记成成功

### Requirement: Dispatched model context identifies the book memory it carried
后台 SHALL 仅在携带非空召回结果的模型请求实际交给传输层后记录该次携带事实，区分 Agent 已调用工具后携带的工具结果与正文生成请求按明确目标章携带的取材。显式调用可复用工具结果派发与召回诊断的调用关联，不需要另建首轮自动召回事迹。事件 SHALL 关联召回与本次模型 `spanId`，有界地记录发送的类别计数、唯一来源的安全文档及修订指纹、已知的来源章序。诊断 MUST NOT 将计划、命中、开始构建请求或实际派发当作模型采用。新增事件 SHALL 沿用仅本地、worker 白名单、非阻塞写入和原有留存规则。维护者排障文档 SHALL 说明如何按 `runId`、`recallId`、`spanId` 核对这些证据及其边界。

#### Scenario: Correlate early chapter evidence with the actual prose request
- **WHEN** 受控测试让第 25 章的新会话经显式记忆工具取得第 2 章证据并交给后续 Agent 请求，独立正文请求按目标章取材时也实际携带该证据
- **THEN** 本地日志能按来源和模型 `spanId` 区分两个请求，列出的来源指纹、章序、类别和计数与请求实际携带的证据一致，独立书籍的来源不得混入

#### Scenario: Empty recall or no dispatch does not imply model context
- **WHEN** 召回为空，或有命中但因预算、取消等原因未将结果发送给模型
- **THEN** 可以看到召回的真实终态；没有对应的记忆携带事件，也不在只读补读、会话摘要请求中冒记携带

#### Scenario: A prose retry keeps distinct transport evidence
- **WHEN** 同一章在允许的断流恢复中复用已验证的召回并实际派发两次正文请求
- **THEN** 两次派发使用各自的 `spanId` 并关联原召回；若校验冲突阻止重试，仅保留已经实际派发的记录

#### Scenario: Memory diagnostics remain bounded and contain no creative content
- **WHEN** 合成检索词、约定、正文、文档 ID、标题、路径、密钥和错误原文含有独特标记，并触发召回、缓存降级及派发；同时注入越界诊断字段或模拟日志不可写
- **THEN** 两份日志无这些原始标记，worker 外来源和超合同字段被拒；每个请求最多记录 8 条去重来源明细，额外来源只计数；诊断故障不影响模型请求和作品状态

### Requirement: Delivered writing context is distinguishable from selected sources
写作工具 SHALL 用受限诊断区分构造请求、缺失或预算阻塞、资料裁减与实际派发，使用现有 Run／模型请求关联。派发记录 SHALL 来自最终送交传输层的资料而不是预筛选结果，标记任务类别、内置模板标识或指纹，以及实际纳入和裁减的必需／可选分组计数及有界的脱敏引用；不把派发当成模型已阅读或遵循。有限的阻塞元数据 SHALL 区分阶段（候选生成／写章取材／输入预算等）和结果（无文件、空说明、结构不符、确有披露限制无法取用、引用／衔接问题或预算），与目标及有界的脱敏来源或计数关联；有效的已存说明不得只因过滤或投影而被记作空说明。未派发 MUST NOT 产生该请求带资料的证据。原始 System、作者要求、提示词、文档和摘录内容、原始工具输入输出及未经脱敏的标识 MUST NOT 写入诊断。

#### Scenario: Context diagnostics match the final writing request
- **WHEN** 写章请求保留了必需人物说明而裁掉一条次要证据，然后实际派发；另一次请求因缺少必要说明被阻塞
- **THEN** 可以按 `runId` 与 `spanId` 核对前一请求实际包含的资料组和裁减结果，后一次只有阻塞诊断、没有派发记录；诊断不含植入作品与提示词的敏感测试标记


#### Scenario: A blocked request distinguishes a private excerpt from an empty asset
- **WHEN** 一次选材无法使用非空说明中唯一受保护的事实，而另一次缺的确是空说明，并且两次均未发正文请求
- **THEN** 可在同一 Run 或不同 Run 分辨阶段、实际原因以及受影响资料类别；都没有正文派发记录，日志不包含被保护命题或用来判断它的稿件原文。正常共用词不触发缺资料诊断

### Requirement: Malformed Messages tool arguments and a bounded retry are traceable
后端诊断 SHALL 记录外层 Messages 不可解析工具参数的有限结构：消息结束状态、经白名单归一化的 stop 类型、解析失败分类、问题块索引与数量、收到的参数分片计数以及可用的缓冲字节数，并记录被限额省略的条数。同一逻辑轮的重取 SHALL 可通过 Run、轮次、尝试序号和原／新请求标识关联。不记录原始分片、JSON 异常中的内容、作者原话、稿件或凭据；不得把初次拒绝表示为执行、文件提交或成功回执。

#### Scenario: Correlate a rejected batch with the only successful attempt
- **WHEN** 已结束的 Messages 响应有坏工具参数，重取成功并实际执行工具
- **THEN** 可区分第一次的拒绝及结构计数、第二次的派发和唯一有效的工具执行／提交；同 Run 和逻辑轮下有两个请求标识，坏批次的候选没有工具执行事件

#### Scenario: Sensitive fixture data stays out of retry diagnostics
- **WHEN** 合成坏参数和重取请求含可识别的敏感标记，或坏批次超过记录条数限制
- **THEN** 两份日志均无原始文本或密钥，后端保留有限元数据与遗漏数量；仍失败或取消时可定位最终边界，不伪造成功与写入证据

### Requirement: Story edit intent and completed book edits are diagnosable separately
后端诊断 SHALL 区分仅提案、直接执行、承接明确方案或待办及未形成有效范围的结果，用已允许的类别、计数与脱敏关联核对目标范围及拒绝原因。已有发布／提交记录 SHALL 是实际书内写入证据；不把确定方案、工具预校验或 Run 结束当成已经落盘。不记录作者确认文本、提案全文、拟写正文或回收内容。

新建资料同步 SHALL 可通过同一 Run 及工具回执关联到关联片段的实际提交。诊断 SHALL 用白名单内的状态、类型、数量、拒绝原因及脱敏标识区分已写正文、待同步、同步提交和同步失败。日常诊断日志仅保留结构信息。原文核对通过作品文件和有界、版本化的引用完成。

#### Scenario: Inspect a partially executed multi-chapter plan
- **WHEN** 已确认方案的资料和一处正文保存成功、另一处因现稿修订未提交
- **THEN** 同 Run 可以从范围与各处回执区分同意、准备、实际提交和未完成原因，诊断不能把未写目标报告成完成，也不含稿件内容

#### Scenario: Prose exists but a new note is still pending synchronization
- **WHEN** 关联正文和大纲已保存，新主体说明同步因资料修订冲突未提交
- **THEN** 可定位实际正文提交、待同步目标和拒绝原因。运行结果点明尚缺同步，该次同步无文档提交事件。日志中的引用、提交与原因可关联，且符合脱敏约束

能力发现 SHALL 用受控工具标识、会话/Run 关联、计数及有界结果类别与实际模型请求、候选调用、逐动作范围校验、执行和可核验提交关联。任务结果 SHALL 区分完成、已满足无需写入、部分完成、未完成和运行取消／中断；不把 scope 发布、搜索结果或 Run 生命周期正常结束当作完成。诊断 MUST NOT 保存搜索词、作者措辞、上下文正文或原始工具参数。

#### Scenario: Audit ordering and an unsuccessful follow-up without logging content
- **WHEN** 同一会话执行关联增补和自然语言续办，续办的写入被拒且现稿仍有问题
- **THEN** 能用有序事件和脱敏关联核对首次主模型派发、发现、范围核验、调用以及没有实际提交的业务结果；即使 Run 正常结束，任务也可见为未完成，写入诊断没有作者措辞、查询或稿件

#### Scenario: Distinguish a chapter catalog write from an actual scene insertion
- **WHEN** 在上下文承接的场景增补中，章节目录字段变更已提交，但插入拒绝或未派发正文生成
- **THEN** 按 Run 和调用可分辨目录提交、未落盘的插入及正文目标结果，不把同一文档的目录提交计为正文完成；复用已有工具和落盘诊断，不记录正文或原始工具参数

#### Scenario: Distinguish one local commit from a completed relocation
- **WHEN** 同章搬移只提交旧段删除，补入候选未提交或被版本、锚点或范围校验拒绝
- **THEN** 通过现有 Run、调用、提交和任务结果能够核对哪部分成功、哪部分仍待处理；不把一次提交记为完整搬移，不记录稿件、作者原话或原始工具参数

#### Scenario: Separate a delivered whole-book skill from the chapter request it enables
- **WHEN** 已派发整书指南但缺活动整书目标，随后 Agent 经现有工具完成登记或恢复并写章
- **THEN** 复用现有 Run、工具结果、`model.budget_dispatched` 与提交事件，区分主 Agent 指南派发、`novel_goal_required` 的未派发正文和目标就绪后实际使用长写作用途的 `draft` 请求；独立单章保留自己的选档。只记录已派发额度与脱敏关联，不记录原始作者输入、工具参数或稿件，不把子请求触限误记成主 Agent 触限续接。

### Requirement: Model request budget is traceable at dispatch
后台 SHALL 只在最终请求体交给传输层时，按现有关联字段记录配置能力来源、上下文窗口、声明或兜底的最大输出、请求用途、适用的有限选档依据（如首次携带整书指南或已生效整书）作为独立于配置能力来源的字段、最终输入估算和实际出站输出限额。该记录不是远端确认、服务器实际用量或模型有效上限。诊断 SHALL 只接受有界数值、有限枚举与既有安全关联字段；MUST NOT 记录密钥、请求地址、请求或响应原文、思考、工具内容及文稿。无实际派发的预算阻塞仍可走既有失败诊断，但不得产生派发预算事件。

#### Scenario: Correlate planned input and actual output with the sent request
- **WHEN** 不同用途的两条请求使用供应商声明额度和兜底额度，并在受控端点捕获最终请求体
- **THEN** 日志可按请求 span 区分额度来源和用途，记录的实际输出限额与三个既有协议各自的请求字段一致，最终输入为传输前估算而非实际用量

#### Scenario: Do not log a dispatch or leak content when a budget is blocked
- **WHEN** 一条请求因必要上下文预算不足而未派发，另一条含合成敏感标记的请求派发或能力查询降级
- **THEN** 未派发请求不出现派发预算记录；日志不包含提供方响应文本、密钥、地址、工具内容或作品标记，原有日志失败不阻塞应用的行为不变

#### Scenario: Identify the request that first delivered the skill and its actual budget
- **WHEN** 主 Agent 发送首条带成功整书指引的请求，或装配该指引后取消、阻塞而未派发
- **THEN** 成功派发时可按同一 span 核对 `skill.applied` 与实际出站的选档及限额，选档原因和能力来源分别记录；未派发时不产生该请求的派发预算或 Skill 已送达证据

### Requirement: Narrowed output-limit continuation is traceable without content
后台 SHALL 用有界枚举、计数和既有关联字段记录明确触限及续接决策、实际派发和结果；支持按 Run、逻辑轮、原请求 span 与实际续接 span 核对。不满足资格、不足以拆小、额度已使用、无有效进展、再次触限和取消 SHALL 能与坏 JSON 和子请求篇幅保护区分。记录是否以及为何停止不等于已经派发；只有实际工具回执和文档提交能证明写入。不得记录半截参数、原始提示、思考、文稿、密钥或供应商原始响应。

#### Scenario: Correlate a truncated attempt with only the valid continuation work
- **WHEN** 初始主 Agent 响应显式触限，使用新 span 续接一个通过校验的动作，另一次触限评估未派发或已触及次数上限
- **THEN** 日志关联合法续接与原 span，初始尝试没有工具执行、未派发的评估不伪造续接派发；失败和成功原因可定位且不泄漏载荷

#### Scenario: Distinguish a scoped follow-up dispatch from rejection before tool execution
- **WHEN** 正式写作范围已有剩余任务，原模型响应因 `output_limit` 在工具执行前被拒，随后实际派发一次同轮续接；对照用例因无可执行候选不派发
- **THEN** 复用现有预算、恢复、工具执行、文档提交和任务结果事件，按 Run、轮次和 span 核对原请求与续接的有效输出额度相同、原批次未执行、续接实际有无提交；不把未派发判定记作尝试，也不增加存储模型截断参数的事件

### Requirement: Trace insertion validation and local prose patch outcomes without content

默认诊断 SHALL 以现有 Run、调用、章标识和允许的版本引用关联插入候选校验结果、失败类别、是否发起了定向更正及最终实际提交。质量不合格 SHALL 与断流、上限、冲突和取消分别可识别；可区分跨标点的边界重叠与已有整句回声。实际执行的正文定点调用 SHALL 区分授权拒绝、证据不足或不可核验、锚点／范围不符、版本冲突与实际提交；通用资料工具不支持正文也 SHALL 给出可识别的安全原因。同 Run 插入回声清理 SHALL 能关联实际插入回执，区分范围或授权拒绝、版本／回执过期、没有可证实的安全删除区间、实际新提交及同步复核结果。拒绝结果无提交，成功必须有实际提交证据。仅允许记录已注册标识、原因、状态和计数等安全字段，MUST NOT 记录候选、原文锚点、被删除或替换的文本、归一化重叠串、片段内容摘要、来源摘录、提示词、工具原始参数或输出。

已登记的正文补丁实际进入既有审校时，日志 SHALL 按同一 Run、补丁 `callId` 和可用模型 `spanId` 区分批准、明确否决、无有效裁决和请求未完成；仅记录可知的附带可见文字存在性，不记录裁决参数、说明或响应片段。前置范围、锚点、证据缺失和版本拒绝不得误记为审校否决。资料定点收尾 SHALL 按 Run 和工具调用可核对登记、路由不支持与实参无效的区别、精确绑定不符、读稿／锚点、冲突、取消及结果；成功 SHALL 能用实际提交事件与回执修订验证。只使用白名单工具标识、有限类别、安全关联、计数和现有允许的修订指纹，不记录原文、候选、提示、解释、原始参数或补丁内容的指纹。

#### Scenario: Tell a rejected insert and a successful patch apart from persistence

- **WHEN** 使用含独特测试标记的候选和补丁参数运行一次重试后仍被拒绝的插入、一次被拒绝的局部修订和一次成功的局部修订
- **THEN** 日志能关联各自结果、一次更正尝试和最终磁盘是否写入；回执只记实际提交，诊断中没有测试文本标记或工具原始内容，修订拒绝不误记为通用网络或供应商失败

#### Scenario: Correlate a committed insert with one bounded echo cleanup

- **WHEN** 合成用例有一次因边界重叠拒绝的候选，以及另一个带真实回执、在活动 Run 成功清理并需要重核同步的片段
- **THEN** 诊断能区分候选拒绝、插入提交、清理新提交及同步状态，不把清理当作另一处插入；注入陷阱标记的重复文本或证据不进入诊断日志

#### Scenario: Explain a review outcome without keeping reviewer text

- **WHEN** 受控的已登记正文补丁审校分别返回带说明的合法批准、明确否决、无效裁决和未完成请求
- **THEN** 补丁调用和模型请求可关联到各自类别与已知的附带文字标志，只有实际提交有写入证据；诊断不出现夹具注入的说明、原文、候选或原始参数

#### Scenario: Trace asset routing, scope and an actual save separately

- **WHEN** 同一 Run 先登记范围，再有参数无效、通用入口不支持、定点登记不符或版本冲突的调用，以及一个实际提交的定点更新
- **THEN** 能把每次拒绝与该次 `callId` 对应，并按回执和提交新修订确认记录中哪一次写入；不把登记或正常 Run 结束当作成功，不泄漏资料文本或模型内容

### Requirement: Correlate projected tool context to actual request dispatch

后台 SHALL 按 Run、轮次和实际模型请求 `spanId` 关联主 Agent 的总输入估算、实发输出上限、本轮新携带与历史保留的可重读体积估算和投影计数。工具结果与业务诊断 SHALL 区分完整携带、只携带投影或引用，以及未携带，不能把内部结果准备好等同派发；携带记忆的来源和计数以出站内容为准。估算 MUST NOT 伪装成供应商 usage，派发 MUST NOT 伪装成对端收到、模型采用或稿件落盘。只沿用本地白名单记录安全标识、类别和计数；MUST NOT 记录正文、引用摘录、提示词、搜索词、原始参数或结果、供应商原始响应、隐含推理或密钥。

#### Scenario: Diagnose a projected read without disclosing payloads

- **WHEN** 一个工具结果只部分出站或退为引用，同一 Run 另一结果因容量或取消未派发；夹具在出站前后的载荷中放入敏感标记
- **THEN** 诊断能与捕获的实际请求及预算核对，并区分发送体积及未派发；不会给未派发结果记送达，也不把被省略的记忆内容算作携带；日志不含标记或任何原始载荷

### Requirement: Distinguish explicit Chat length stops without extending recovery

后台 SHALL 在本地终态诊断中区分 Chat Completions 明确报告 `finish_reason: length` 的输出上限、缺少明确正常终态的中断以及本地取消、超时。没有明确终态时 MUST NOT 根据 HTTP 成功、首事件或实发额度猜触限。诊断分类 MUST NOT 扩大原有 Messages 触限续接资格、改变重试次数或派发截断批次中的任何工具；不能把半截模型回复写成合法的业务证据。

#### Scenario: Identify explicit length separately from a dropped or locally stopped stream

- **WHEN** 本地协议夹具分别返回明确 `length`、无有效终态的断流以及本地超时和取消，部分请求含已开始生成的工具块
- **THEN** 日志按实际协议与请求区分四类终态，不保存原始内容或参数；无一截断批次工具执行或持久化，不进入 Messages 的有范围续接分支

### Requirement: Trace delegated task lifecycle and report dispatch without content

本地诊断 SHALL 用父 `runId`、脱敏任务标识、子任务 lane 和独立模型 `spanId` 关联委派接受、模型请求实际派发与终态、子任务终止、等待结果及报告携带。记录有界的计数、额度、耗时、原因类别和安全关联字段；SHALL 区分已启动与实际派发、等待到时与子任务截止、报告已准备与完整派发。输入估算、实发输出上限与供应商 usage MUST NOT 混用。报告派发不证明模型收到、采用或作品已写入。

这些事件 SHALL 遵循既有白名单和留存策略，MUST NOT 记录任务说明、报告、引用摘录、候选文字、原文、文件路径原文、搜索词、隐藏推理、原始模型响应、工具参数、工具结果或凭据。主、子、写作请求与选材请求诊断 SHALL 可区分，不扩大任何协议的恢复资格。

#### Scenario: Compare actual overlap and separate stop reasons

- **WHEN** 同一 Run 两个子任务实际并发派发，父继续独立工作；一次等待先到时，之后一条子请求明确触限或超时
- **THEN** 能分别把两条子请求与各自的开始、实际派发、终态及父请求关联，从在途请求核对重叠，区分等待截止、明确触限、流中断、取消与超时，不以已发任务 ID 证明请求并发

#### Scenario: Log projected status separately from a delivered report

- **WHEN** 报告中有敏感夹具标记，第一次仅状态装得进父请求，后来完整报告实际派发
- **THEN** 前一次只可见状态或延迟，后一次才有对应父模型 `spanId` 的报告派发证据，重复等待不产生第二次完整送达记录；日志和会话回执中没有报告或标记
