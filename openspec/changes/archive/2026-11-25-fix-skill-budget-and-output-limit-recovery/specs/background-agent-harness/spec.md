## MODIFIED Requirements

### Requirement: Recover a malformed Messages tool batch before execution once
外层主 Agent 的 Messages 响应达到可接受的消息结束状态，但有工具参数不能解析为 JSON 且本轮没有工具执行时，系统 SHALL 拒绝整批；若同一逻辑轮尚未使用额外尝试额度，SHALL 在同一 Run、同一逻辑轮从最后的合法上下文重取一次。此轮额度与输出触限续接共享，任一重取都不得接着触发另一种重取。不得猜补参数、部分执行坏批次、回传损坏原生块或重做先前工具动作；失败尝试的临时流式文字不得进入后续请求或持久对话。重取成功按既有校验执行，取消则终止，重取仍失败 SHALL 报告可定位的原因与已保留进度，不自动重开全书。断流、输出触限、鉴权失败和合法 JSON 的 Schema 错误不适用本规则；保留现有上下文预算、取消与往返上限。

#### Scenario: A completed Messages response contains invalid tool JSON
- **WHEN** 外层 Messages 响应已结束，同批含不可解析及原本可解析的工具参数，重取返回合法且通过校验的调用
- **THEN** 初次批次执行和提交数均为零，重取以新请求标识属于同一运行和同一逻辑轮，只有重取后的有效调用执行一次；先前有效回执与文档不被重放，用户不需要发送「继续」

#### Scenario: The single retry also fails or the author stops the run
- **WHEN** 已经重取一次仍未取得合法参数，或作者在重取前／中点击停止
- **THEN** 不发出第三次尝试或新 Run，坏批次从未执行，保留原有提交和可核对的进度；区分失败与取消

#### Scenario: Other model or tool failures do not trigger this recovery
- **WHEN** 响应没有结束、报告长度触限、HTTP 鉴权失败，或工具参数是合法 JSON 但不符合工具 Schema
- **THEN** 沿用各自的诊断和处理路径（明确输出触限按独立的有限续接规则评估），不用本规则掩盖异常或重复请求

### Requirement: Plan each model request within saved capability and context limits
Harness SHALL 用同一预算规则规划模型请求：输出由请求用途目标、保存的供应商最大输出、已知适用的协议或模式上限以及剩余上下文共同约束；输入按上下文窗口扣除本次输出和安全预留，并遵守已知独立输入上限。用于上下文装配的预算 MUST 与实际出站请求一致。必要输入装不下时 SHALL 走现有预算阻塞，不静默省略或发送无效额度。普通请求与显式小任务保留独立的用途预算；已有大写作预算选档在能力允许时 SHALL 使用 64 Ki tokens 的新策略目标而非 16,384 固定值。对符合整书资格且首次实际携带成功的 `generate-novel` 工具结果的请求，Harness SHALL 在上下文裁配前选择 `long-writing`，并确保完整指引随最终请求一起派发。已生效的整书 Run 继续使用该用途；仅查到候选、加载失败、普通请求或整书资格不成立，MUST NOT 因该 Skill 选择大预算。预算选择不得提前生效 Skill 或改变写入授权、200 轮限制与有效上下文防护。无法装入必须发送的完整 Skill 结果时 SHALL 阻止派发，不发送截断的首次整书指引。

#### Scenario: Calculate input using the applicable output target
- **WHEN** 配置声明 `1,048,576` 上下文、`393,216` 最大输出且没有更小适用上限，分别规划普通请求和已有资格提档的写作请求
- **THEN** 普通请求按 `8,192` 输出、`1,039,184` 输入规划，大预算请求按 `65,536` 输出、`981,840` 输入规划（均扣除 `1,200` 预留）；出站字段采用同一规划值，而不是每轮使用 `393,216`

#### Scenario: Clamp requests and keep mandatory input intact
- **WHEN** 受控端点配置的适用最大输出比请求用途目标更小，或必要上下文与安全余量无法在适用窗口内装入
- **THEN** 前者在装配上下文前以较小的输出预算计算输入空间，出站使用实际限额；后者标记 `context_limit`，不发出请求或截掉必需资料，也不改变已落盘内容

#### Scenario: Use the whole-book budget when delivering the skill for the first time
- **WHEN** 第 N 轮成功读取内置 `generate-novel`，且第 N+1 轮首次将其完整指引和匹配的调用结果随合格整书请求派发
- **THEN** 第 N+1 轮已经按 `long-writing` 规划和裁配，不等第 N+2 轮；DeepSeek 配置能力允许时实发 `65,536`，更小的配置按既有上限。`skill.applied` 及整书业务状态仍只在真实派发时生效一次

#### Scenario: Do not activate or claim delivery for an undelivered skill result
- **WHEN** 只检索候选、加载失败、整书资格不成立，或合格指南的必需指引因空间不足或取消未派发
- **THEN** 前三者不因此获得整书档；后两种未派发路径不记录 Skill 已送达、不提前激活整书权限或进度，也不发送半截指南

## ADDED Requirements

### Requirement: Recover an explicit main-agent output limit by narrowing once
只有绑定小说、具备可安全缩小的已授权剩余工作、且 Messages 主 Agent 收到供应商明确结束的输出触限时，Harness SHALL 从最后合法上下文及实际工具结果进入一次拆小续接。触限响应的整批工具 MUST NOT 执行，包括看似完整的调用；失败尝试的半截文字、原生块和参数不得进入持久对话或后续请求，不得猜补参数或伪造回执。续接 SHALL 在同一 Run、同一逻辑轮用新请求身份、原用途和原有效输出额度派发；只请求一个可独立校验的动作，通过前置批次校验和原有工具校验再执行，不重放已完成的工具。缩小后的正常模型往返 SHALL 在该 Run 内保持逐项处理。不得自动提额、换模型、重开 Run 或增加 200 轮上限。

输出触限续接在整个 Run 内最多一次，同一逻辑轮最多一次额外尝试（与坏 JSON 恢复共享轮级限制）。没有安全的小动作、续接必要输入装不下、第二次触限、续接无进展或超出授权时 SHALL 安全停止，保留已提交内容并报告可核对的剩余工作；不猜未知失败位置。取消 SHALL 阻止新的派发或工具执行，并按现有取消语义保留已完成写入。其他协议、普通目录、纯讨论、子请求、Writer 自身篇幅保护、断流、鉴权失败和上下文超限不适用本规则。

#### Scenario: Continue an eligible truncated response from the last valid tool results
- **WHEN** 已授权的小说主 Agent 响应以 Messages `max_tokens` 明确结束，当前有可独立校验的小动作，初始响应流已显示部分文本并出现工具块
- **THEN** 初始批次工具执行数和提交数均为零；临时文本被清除，只附上安全的逐项续接指引，从有效历史和既有回执发一次同轮请求且不提高该轮输出额度；完整合法的小动作至多执行一次

#### Scenario: Repeated output limits or mixed failures do not chain attempts
- **WHEN** 拆小后本次或同一 Run 的后续逐项请求仍明确触限，或者同一轮先坏 JSON 后触限、先触限后坏 JSON
- **THEN** 不发第三次同轮请求或第二次同 Run 的触限续接，按实际上游终态报告未完成；先前成功提交保留，证据不支持的调用不执行

#### Scenario: Do not dispatch a narrower continuation when its prerequisites are absent
- **WHEN** 未知授权或目标、无安全拆分、必需上下文无法装入、非适用 lane 或协议发生同名错误，或者取消发生于续接派发前或响应执行前
- **THEN** 没有安全候选时不请求续接；已派发但在执行前取消时，不执行其工具。保留真实进度，区分触限、其他失败和取消，不宣称部分结果已完成
