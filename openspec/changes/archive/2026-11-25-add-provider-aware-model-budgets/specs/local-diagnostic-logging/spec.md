## ADDED Requirements

### Requirement: Model request budget is traceable at dispatch
后台 SHALL 只在最终请求体交给传输层时，按现有关联字段记录配置能力来源、上下文窗口、声明或兜底的最大输出、请求用途、最终输入估算和实际出站输出限额。该记录不是远端确认、服务器实际用量或模型有效上限。诊断 SHALL 只接受有界数值、有限枚举与既有安全关联字段；MUST NOT 记录密钥、请求地址、请求或响应原文、思考、工具内容及文稿。无实际派发的预算阻塞仍可走既有失败诊断，但不得产生派发预算事件。

#### Scenario: Correlate planned input and actual output with the sent request
- **WHEN** 不同用途的两条请求使用供应商声明额度和兜底额度，并在受控端点捕获最终请求体
- **THEN** 日志可按请求 span 区分额度来源和用途，记录的实际输出限额与三个既有协议各自的请求字段一致，最终输入为传输前估算而非实际用量

#### Scenario: Do not log a dispatch or leak content when a budget is blocked
- **WHEN** 一条请求因必要上下文预算不足而未派发，另一条含合成敏感标记的请求派发或能力查询降级
- **THEN** 未派发请求不出现派发预算记录；日志不包含提供方响应文本、密钥、地址、工具内容或作品标记，原有日志失败不阻塞应用的行为不变
