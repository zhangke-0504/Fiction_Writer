## ADDED Requirements

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
