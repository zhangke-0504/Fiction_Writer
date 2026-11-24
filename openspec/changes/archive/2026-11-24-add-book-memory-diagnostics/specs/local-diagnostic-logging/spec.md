## ADDED Requirements

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
