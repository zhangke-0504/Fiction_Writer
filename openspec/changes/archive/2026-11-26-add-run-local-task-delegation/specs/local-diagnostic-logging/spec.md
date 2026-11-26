## ADDED Requirements

### Requirement: Trace delegated task lifecycle and report dispatch without content

本地诊断 SHALL 用父 `runId`、脱敏任务标识、子任务 lane 和独立模型 `spanId` 关联委派接受、模型请求实际派发与终态、子任务终止、等待结果及报告携带。记录有界的计数、额度、耗时、原因类别和安全关联字段；SHALL 区分已启动与实际派发、等待到时与子任务截止、报告已准备与完整派发。输入估算、实发输出上限与供应商 usage MUST NOT 混用。报告派发不证明模型收到、采用或作品已写入。

这些事件 SHALL 遵循既有白名单和留存策略，MUST NOT 记录任务说明、报告、引用摘录、候选文字、原文、文件路径原文、搜索词、隐藏推理、原始模型响应、工具参数、工具结果或凭据。主、子、写作请求与选材请求诊断 SHALL 可区分，不扩大任何协议的恢复资格。

#### Scenario: Compare actual overlap and separate stop reasons

- **WHEN** 同一 Run 两个子任务实际并发派发，父继续独立工作；一次等待先到时，之后一条子请求明确触限或超时
- **THEN** 能分别把两条子请求与各自的开始、实际派发、终态及父请求关联，从在途请求核对重叠，区分等待截止、明确触限、流中断、取消与超时，不以已发任务 ID 证明请求并发

#### Scenario: Log projected status separately from a delivered report

- **WHEN** 报告中有敏感夹具标记，第一次仅状态装得进父请求，后来完整报告实际派发
- **THEN** 前一次只可见状态或延迟，后一次才有对应父模型 `spanId` 的报告派发证据，重复等待不产生第二次完整送达记录；日志和会话回执中没有报告或标记
