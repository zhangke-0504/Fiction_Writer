## ADDED Requirements

### Requirement: A confirmed book edit proposal carries scoped intent across turns
在绑定作品的会话里，作者只要求讨论或查看修改建议时，主 Agent SHALL 可以查阅现稿并产出方案，不生成或修改作品文件。可执行的方案 SHALL 以有界范围与实际展示的回复、同一 Session 和作品关联。明确的「按这个来改」类确认 SHALL 承接该会话中有明确指向的上一份方案及本轮新增限制；不用逐项重述名称、ID、动作词或通过额外审批。直接下达明确修改要求 SHALL 可直接选用现有工具，无须先提案。范围以作者要求为准，不得由未经确认的模型提案、工具参数、参考文件或其他会话自动取得，不得因概括许可而扩大到方案外。

直接执行或承接已确认方案时，有效范围 SHALL 包含以实际落盘正文校准本次新建资料中的相关剧情状态及计划。主 Agent 可按现有工具调用完成同步，续接时须核对原有效范围和成功回执并应用本轮限制。

#### Scenario: Review a proposal and then execute it in the same session
- **WHEN** 作者先问「你看看要改哪些内容」，随后在同一作品、同一会话回复「嗯，就按这个来改」确认刚展示的明确方案
- **THEN** 第一轮只展示方案、不改稿；第二轮由同一主 Agent 依据该方案选择执行工具，包括实际关联正文写入后对新建资料的必要同步，作者一句确认即可执行

#### Scenario: General agreement only applies to the clearly referenced proposal
- **WHEN** 作者紧接一个明确的可执行方案说「我允许你所有操作」，或在没有可确认的唯一方案时说同一句话
- **THEN** 前者只承接该方案且不扩大到无关资料或整章覆盖；后者不产生全局写权限。如范围有实质歧义，助手指出具体缺口而不是猜测写入

#### Scenario: A later restriction overrides a previously proposed edit
- **WHEN** 作者表示只看建议或明确不写某一类内容，或者工具试图使用已被替代的方案或另一作品／会话的记录
- **THEN** 不执行被限制或未被确认的作品修改；无需让作者为了普通直接指令先进入提案模式

### Requirement: Recover a malformed Messages tool batch before execution once
外层主 Agent 的 Messages 响应达到可接受的消息结束状态，但有工具参数不能解析为 JSON 且本轮没有工具执行时，系统 SHALL 拒绝整批并在同一 Run、同一逻辑轮从最后的合法上下文重取一次。不得猜补参数、部分执行坏批次、回传损坏原生块或重做先前工具动作；失败尝试的临时流式文字不得进入后续请求或持久对话。重取成功按既有校验执行，取消则终止，重取仍失败 SHALL 报告可定位的原因与已保留进度，不自动重开全书。断流、输出触限、鉴权失败和合法 JSON 的 Schema 错误不适用本规则；保留现有上下文预算、取消与往返上限。

#### Scenario: A completed Messages response contains invalid tool JSON
- **WHEN** 外层 Messages 响应已结束，同批含不可解析及原本可解析的工具参数，重取返回合法且通过校验的调用
- **THEN** 初次批次执行和提交数均为零，重取以新请求标识属于同一运行和同一逻辑轮，只有重取后的有效调用执行一次；先前有效回执与文档不被重放，用户不需要发送「继续」

#### Scenario: The single retry also fails or the author stops the run
- **WHEN** 已经重取一次仍未取得合法参数，或作者在重取前／中点击停止
- **THEN** 不发出第三次尝试或新 Run，坏批次从未执行，保留原有提交和可核对的进度；区分失败与取消

#### Scenario: Other model or tool failures do not trigger this recovery
- **WHEN** 响应没有结束、报告长度触限、HTTP 鉴权失败，或工具参数是合法 JSON 但不符合工具 Schema
- **THEN** 沿用各自的诊断和处理路径，不用本规则掩盖异常或重复请求

### Requirement: Harness composer supports Enter to send and Shift Enter for newline
当焦点在 Harness 消息输入框且当前可发送时，未修饰的 Enter SHALL 通过现有表单提交一次消息；Shift+Enter SHALL 在光标／选区位置换行且不发送。按钮与键盘 SHALL 使用相同的校验和提交逻辑，并保留原有模型、思考档位、附件、会话和所选章；发送失败保留输入及附件。键盘不得绕过无模型、工作区不可用、空白、运行中和提交中的限制，不得触发停止或改变其他编辑器的 Enter 行为。

#### Scenario: Use the keyboard to compose and submit a multiline message
- **WHEN** 作者在 Harness 输入框输入文字、按 Shift+Enter 再输入下一行，然后按 Enter
- **THEN** 只发一个会话启动请求，正文带有换行且提交参数同点击发送；点击发送仍可用

#### Scenario: Enter confirms an IME candidate without sending
- **WHEN** Windows 中文输入法正在组合或使用 Enter 确认候选字，随后在非组合状态按 Enter
- **THEN** 第一次只处理选字、不发送，之后一次正常发送；其他修饰键组合和 Markdown 编辑器键位不被截获

#### Scenario: Repeated or unavailable submissions do not start another run
- **WHEN** 作者长按 Enter、在提交尚未完成时再按 Enter／点击按钮，或当前仅空白、无模型、工作区不可用或任务正在运行
- **THEN** 不会双发或绕过不可用状态，不会意外清空草稿、清除附件或停止现有任务

## MODIFIED Requirements

### Requirement: Tool-scoped writing requests in a single Harness loop
绑定小说会话 SHALL 由同一个主 Agent 分析作者意图、选择 Skill、读取所需资料、提出本次创作安排并选择下一工具。系统 MUST NOT 根据作者措辞切换外层 System 的任务角色，不得引入专用 UI 模式、小说阶段机、生成子 Agent 或额外会话。工具前提不满足时 SHALL 把可定位结果交回同一 Agent，而不是自动调用其他生成工具；作者只讨论时不得启动生成或写入。就绪采用可复用的书内规则，不新增必须经过的固定预检或补资料阶段；现稿无变化时，反馈 SHALL 足以引导 Agent 而不重复全库读取。Agent 仍可自行重查、选择另一个合法方案或请求澄清，不得以封禁正常重查、调大循环上限或放宽写权限掩盖错误。

主体、伏笔和章节生成工具 SHALL 在校验任务范围后，按工具和动作选择内置模板，从绑定作品取得本次资料，组装独立模型请求。生成请求 SHALL 使用本轮作者要求、适用的显式续接约束或经核对的同会话确认方案范围；主 Agent 未经作者确认的安排作为另标的提议，不是授权或事实。工具请求 MUST NOT 继承完整的外层会话、外层 System 或通用工具。代码组装模板无需模型另写 System；定位证据确有需要时 SHALL 支持独立、有限的只读取材，结果仅用于该任务，不产生写入或额外 Agent 循环。

主 Agent 主动读取的资料按现有预算进入其上下文。工具 SHALL 只把有界的提交、缺项或冲突回执返回外层，不默认回传其 System、完整取材包或生成全文；主 Agent 可通过正常的作品读取工具进一步取用。取材与生成 SHALL 遵循发起 Run 的取消和作品绑定。

#### Scenario: Generate one subject without starting a book pipeline
- **WHEN** 在已有小说中仅要求为指定主体补说明，且已有足够资料
- **THEN** 主 Agent 可按需要读取和执行该主体工具；实际生成请求只有主体任务模板和此次资料，未启动伏笔、写章、取材子 Agent 或整书任务；回执不含完整说明或请求，之后仅在显式读取时取得保存内容

#### Scenario: A missing prerequisite returns control to the same Agent
- **WHEN** 一次写章工具发现本章的必需主体没有说明
- **THEN** 向当前 Agent 返回目标章和缺失主体，不自动发主体生成请求；仅在 Agent 根据作者允许的范围另行调用工具后才补资料，之后任何写章调用重新核对现稿

#### Scenario: Draft uses bounded readback without consuming the outer history budget
- **WHEN** 主 Agent 的简短安排指向早期原文，而默认取材不能定位该证据
- **THEN** 写章工具能在本次 Run 内进行有界的只读取材，正文请求使用经核对的结果；没有独立 Agent，会话不自动接收选材请求和原文，普通目录会话不注册这些能力


#### Scenario: An existing note and a genuine missing note lead to different next actions
- **WHEN** 本章缺项核对遇到已存在但目前没有可核验摘录的说明，或另一条说明确实为空
- **THEN** 回执分别指出真实原因及适用的下一步，不引导对非空说明调用 fill、不诱导通用写入绕过该章前提；主 Agent 可以在同一 Run 选择取一段已保存的证据、修正引用、补真正的空卡或改合法安排，不需要切换用户模式
