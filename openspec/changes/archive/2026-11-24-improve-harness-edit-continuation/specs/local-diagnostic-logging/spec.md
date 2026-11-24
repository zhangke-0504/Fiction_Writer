## ADDED Requirements

### Requirement: Malformed Messages tool arguments and a bounded retry are traceable
后端诊断 SHALL 记录外层 Messages 不可解析工具参数的有限结构：消息结束状态、经白名单归一化的 stop 类型、解析失败分类、问题块索引与数量、收到的参数分片计数以及可用的缓冲字节数，并记录被限额省略的条数。同一逻辑轮的重取 SHALL 可通过 Run、轮次、尝试序号和原／新请求标识关联。不记录原始分片、JSON 异常中的内容、作者原话、稿件或凭据；不得把初次拒绝表示为执行、文件提交或成功回执。

#### Scenario: Correlate a rejected batch with the only successful attempt
- **WHEN** 已结束的 Messages 响应有坏工具参数，重取成功并实际执行工具
- **THEN** 可区分第一次的拒绝及结构计数、第二次的派发和唯一有效的工具执行／提交；同 Run 和逻辑轮下有两个请求标识，坏批次的候选没有工具执行事件

#### Scenario: Sensitive fixture data stays out of retry diagnostics
- **WHEN** 合成坏参数和重取请求含可识别的敏感标记，或坏批次超过记录条数限制
- **THEN** 两份日志均无原始文本或密钥，后端保留有限元数据与遗漏数量；仍失败或取消时可定位最终边界，不伪造成功与写入证据

### Requirement: Story edit intent and completed book edits are diagnosable separately
后端诊断 SHALL 区分仅提案、直接执行、承接明确方案及未形成有效范围的结果，用已允许的类别、计数与脱敏关联核对目标范围及拒绝原因。已有发布／提交记录 SHALL 是实际书内写入证据；不把确定方案、工具预校验或 Run 结束当成已经落盘。不记录作者确认文本、提案全文、拟写正文或回收内容。

新建资料同步 SHALL 可通过同一 Run 及工具回执关联到关联片段的实际提交。诊断 SHALL 用白名单内的状态、类型、数量、拒绝原因及脱敏标识区分已写正文、待同步、同步提交和同步失败。日常诊断日志仅保留结构信息。原文核对通过作品文件和有界、版本化的引用完成。

#### Scenario: Inspect a partially executed multi-chapter plan
- **WHEN** 已确认方案的资料和一处正文保存成功、另一处因现稿修订未提交
- **THEN** 同 Run 可以从范围与各处回执区分同意、准备、实际提交和未完成原因，诊断不能把未写目标报告成完成，也不含稿件内容

#### Scenario: Prose exists but a new note is still pending synchronization
- **WHEN** 关联正文和大纲已保存，新主体说明同步因资料修订冲突未提交
- **THEN** 可定位实际正文提交、待同步目标和拒绝原因。运行结果点明尚缺同步，该次同步无文档提交事件。日志中的引用、提交与原因可关联，且符合脱敏约束
