## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Narrowed output-limit continuation is traceable without content
后台 SHALL 用有界枚举、计数和既有关联字段记录明确触限及续接决策、实际派发和结果；支持按 Run、逻辑轮、原请求 span 与实际续接 span 核对。不满足资格、不足以拆小、额度已使用、无有效进展、再次触限和取消 SHALL 能与坏 JSON 和子请求篇幅保护区分。记录是否以及为何停止不等于已经派发；只有实际工具回执和文档提交能证明写入。不得记录半截参数、原始提示、思考、文稿、密钥或供应商原始响应。

#### Scenario: Correlate a truncated attempt with only the valid continuation work
- **WHEN** 初始主 Agent 响应显式触限，使用新 span 续接一个通过校验的动作，另一次触限评估未派发或已触及次数上限
- **THEN** 日志关联合法续接与原 span，初始尝试没有工具执行、未派发的评估不伪造续接派发；失败和成功原因可定位且不泄漏载荷
