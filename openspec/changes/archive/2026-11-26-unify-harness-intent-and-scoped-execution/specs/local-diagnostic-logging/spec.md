## MODIFIED Requirements

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

### Requirement: Narrowed output-limit continuation is traceable without content
后台 SHALL 用有界枚举、计数和既有关联字段记录明确触限及续接决策、实际派发和结果；支持按 Run、逻辑轮、原请求 span 与实际续接 span 核对。不满足资格、不足以拆小、额度已使用、无有效进展、再次触限和取消 SHALL 能与坏 JSON 和子请求篇幅保护区分。记录是否以及为何停止不等于已经派发；只有实际工具回执和文档提交能证明写入。不得记录半截参数、原始提示、思考、文稿、密钥或供应商原始响应。

#### Scenario: Correlate a truncated attempt with only the valid continuation work
- **WHEN** 初始主 Agent 响应显式触限，使用新 span 续接一个通过校验的动作，另一次触限评估未派发或已触及次数上限
- **THEN** 日志关联合法续接与原 span，初始尝试没有工具执行、未派发的评估不伪造续接派发；失败和成功原因可定位且不泄漏载荷

#### Scenario: Distinguish a scoped follow-up dispatch from rejection before tool execution
- **WHEN** 正式写作范围已有剩余任务，原模型响应因 `output_limit` 在工具执行前被拒，随后实际派发一次同轮续接；对照用例因无可执行候选不派发
- **THEN** 复用现有预算、恢复、工具执行、文档提交和任务结果事件，按 Run、轮次和 span 核对原请求与续接的有效输出额度相同、原批次未执行、续接实际有无提交；不把未派发判定记作尝试，也不增加存储模型截断参数的事件

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
后台 SHALL 仅在携带非空召回结果的模型请求实际交给传输层后记录该次携带事实，区分 Agent 已调用工具后携带的工具结果与正文生成请求按明确目标章携带的取材。显式调用可复用工具结果派发与召回诊断的调用关联，不需要另建首轮自动召回事迹。事件 SHALL 关联召回与本次模型 `spanId`，有界地记录发送的类别计数、唯一来源的安全文档及修订指纹、已知的来源章序。诊断 MUST NOT 将计划、命中、开始构建请求或实际派发当作模型采用。新增事件 SHALL 沿用仅本地、worker 白名单、非阻塞写入和原有留存规则。README SHALL 说明如何按 `runId`、`recallId`、`spanId` 核对这些证据及其边界。

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
