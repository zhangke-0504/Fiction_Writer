## MODIFIED Requirements

### Requirement: Tool-scoped writing requests in a single Harness loop
绑定小说会话 SHALL 由同一个主 Agent 分析作者意图、选择 Skill、读取所需资料、提出本次创作安排并选择下一工具。系统 MUST NOT 根据作者措辞切换外层 System 的任务角色，不得引入专用 UI 模式、小说阶段机、生成子 Agent 或额外会话。工具前提不满足时 SHALL 把可定位结果交回同一 Agent，而不是自动调用其他生成工具；作者只讨论时不得启动生成或写入。就绪采用可复用的书内规则，不新增必须经过的固定预检或补资料阶段；现稿无变化时，反馈 SHALL 足以引导 Agent 而不重复全库读取。Agent 仍可自行重查、选择另一个合法方案或请求澄清，不得以封禁正常重查、调大循环上限或放宽写权限掩盖错误。

主体、伏笔和章节生成工具 SHALL 在校验任务范围后，按工具和动作选择内置模板，从绑定作品取得本次资料，组装独立模型请求。生成请求 SHALL 使用本轮作者要求和有效的逐动作范围，包括适用的续接约束及经核对的同会话指代；主 Agent 的安排作为另标的提议，不独立授予权限或替代事实。工具请求 MUST NOT 继承完整的外层会话、外层 System 或通用工具。代码组装模板无需模型另写 System；定位证据确有需要时 SHALL 支持独立、有限的只读取材，结果仅用于该任务，不产生写入或额外 Agent 循环。

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

### Requirement: A confirmed book edit proposal carries scoped intent across turns
在绑定作品的会话里，作者只要求讨论或查看修改建议时，主 Agent SHALL 可以查阅现稿并产出方案，不生成或修改作品文件。可执行的方案 SHALL 以有界范围与实际展示的回复、同一 Session 和作品关联。明确的「按这个来改」类确认 SHALL 承接该会话中有明确指向的上一份方案及本轮新增限制；不用逐项重述名称、ID、动作词或通过额外审批；确认的识别取决于本轮含义和可核验指向，不以示例措辞为命令语法。直接下达明确修改要求 SHALL 可直接选用现有工具，无须先提案。范围以作者要求为准，不得由未经确认的模型提案、工具参数、参考文件或其他会话自动取得，不得因概括许可而扩大到方案外。

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

### Requirement: Recover an explicit main-agent output limit by narrowing once
只有绑定小说、具备可安全缩小的已授权剩余工作、且 Messages 主 Agent 收到供应商明确结束的输出触限时，Harness SHALL 从最后合法上下文及实际工具结果进入一次拆小续接。触限响应的整批工具 MUST NOT 执行，包括看似完整的调用；失败尝试的半截文字、原生块和参数不得进入持久对话或后续请求，不得猜补参数或伪造回执。续接 SHALL 在同一 Run、同一逻辑轮用新请求身份、原用途和原有效输出额度派发；只请求一个可独立校验的动作，通过前置批次校验和原有工具校验再执行，不重放已完成的工具。缩小后的正常模型往返 SHALL 在该 Run 内保持逐项处理。不得自动提额、换模型、重开 Run 或增加 200 轮上限。Harness SHALL 将当前 Run 有效登记的任务范围（`BookTaskScope`）作为计算候选小步的依据，包括同会话自然语言续办；不得要求先加载整书 Skill、经过旧确认流程或触发关键词分流才能获得此类候选。Agent SHALL 从提供的候选范围内使用现有工具，Harness 不替其执行选定动作。

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

#### Scenario: A scoped follow-up resumes without a whole-book skill or legacy confirmation
- **WHEN** 正式 Harness 的同会话续办已登记多项剩余工作，Messages 主 Agent 在输出更新工具调用时明确触限；至少有一个以现稿修订和实际提交回执可定位的小步，且本 Run 未派发整书 Skill、未进入旧确认入口
- **THEN** 不执行截断批次；按原模型及实发输出额度发起一次同轮续接，让 Agent 自主选择一个可核对的动作。其结果用于推进原有待办，而非重做旧提交或宣称任务全部完成

## ADDED Requirements

### Requirement: The main agent discovers session-available tools without natural-language pre-routing
Harness SHALL 把当前用户消息、有关的同会话上下文及当前会话边界交给同一个主 Agent。后台 MUST NOT 从自然语言提示匹配专用流程、授权、工具顺序或任务专属进度；首次主模型请求 SHALL 先于任务专属进度和业务写入。显式能力选择与命令语法、候选检索和结构化参数校验可以确定性处理，但不得替代对普通自然语言的意图判断。

绑定作品与普通目录 SHALL 共享一个会话可用的工具发现机制。主 Agent SHALL 能用 `tool_search` 获取匹配工具的稳定 ID、用途、读写性质与参数说明，并在同一 Run 调用已发现的规范；小说会话 SHALL 复用其现有的 Skill 检索与按需加载。需要新能力时由主 Agent 发现并选择；无需重复发现已知能力或为纯对话强制搜索。搜索无结果或工具失败时选择权仍属于同一个 Agent，不触发关键词兜底流程。搜索结果、Skill、作品及附件 MUST NOT 自行授予权限，发现和执行均须符合当前绑定会话的可用性。

#### Scenario: Equivalent natural language uses the same agent path
- **WHEN** 作者用原句或同义表述要求添加有明确关联数量的反派、中期迹象和后期登场
- **THEN** 首个主模型请求前没有增补任务专属进度或业务写入；实际轨迹可见 Agent 发起能力发现并选择工具，保留相同作者约束，不因措辞固定查询词、章节区间或后续工具顺序

#### Scenario: Discovery respects session type and does not dispatch on no match
- **WHEN** 普通目录会话搜索文件或小说能力，或小说会话的查询无匹配
- **THEN** 普通目录可发现并执行原有允许的文件类能力，不获得小说工具或小说 Skill；无匹配可重查或报告，不执行任何未发现或不适用的工具，不走后台业务分支

### Requirement: The main agent requests book memory on demand
小说 Harness MUST NOT 在首次主模型请求前从用户措辞猜章，或预先查询并注入作品记忆。主 Agent SHALL 按需发现并调用 `book_memory_recall`，按任务需要传入查询和已定位的 `chapterId`；工具 SHALL 返回在当前作品范围内的有界结果，区分已保存前情、计划与长期约定。指定目标章时不返回其后的正文；未指定目标章时不得把全书正文默认为前情。写章工具已经获知明确章节 ID 后，在该动作内按章取材不受此限制。

#### Scenario: The agent finds prior evidence by calling the memory tool
- **WHEN** 作者在小说中请求核对早期线索或写一个早于现稿揭晓的章节
- **THEN** 首次主模型请求不携带后台预取的作品正文记忆；需要记忆时，由同一 Agent 发现并调用召回工具，得到带来源的前情，且没有越过显式目标章的剧情事实

#### Scenario: No chapter selection is not permission to preload the entire book
- **WHEN** 作者只询问作品约定，主 Agent 调用记忆工具但未传 `chapterId`
- **THEN** 工具可返回作品约定，但不把任意章节正文当作前情；主 Agent 可在需要时另行定位目标章

### Requirement: The main agent manages durable conventions without phrase gates
由主 Agent 理解作者是否希望长期保存、更正或移除约定，并按需调用对应的记忆工具。`book_memory_remember` / `book_memory_forget` MUST NOT 用正则或关键词重新判定作者意图，也 MUST NOT 要求约定文字逐字出现在本轮作者消息中；呼叫中可传入忠实整理后的约定。工具只做作品绑定、有效参数、长度和数量限制、记录 ID 与存储结果等功能校验；不得引入额外审批、范围登记或模型许可复核。普通聊天不由后台自动提炼写入。

#### Scenario: Paraphrased author intent can save, update and forget a convention
- **WHEN** 作者用不含固定动作词的表达要求保留一条长期写作习惯，主 Agent 传入经整理、并非作者句子的逐字摘录，随后按作者意思更新或移除该记录
- **THEN** 在绑定作品按传入参数实际保存、更新或删除，重开该书会话可看到正确结果；不要求复述原句、调用范围登记或再批准，普通讨论未触发记忆写工具时不落盘

### Requirement: A current author instruction can carry a bounded task through same-session references
当本轮作者明确要求执行或继续时，同一主 Agent SHALL 能解析它对同作品、同会话的可见方案或待办的明确指向；缺少机器登记的方案不构成拒绝理由。对正文、大纲和资料的写作动作，生效的范围 SHALL 参照当前指令、被明确采纳的内容、适用的作者限制及真实作品证据，用可核验的会话、作品、作者消息和动作目标绑定。工具 SHALL 校验本动作在范围内及相关提交前提，不要求本轮再写 ID、章号、动词、锚点或再次审批。不明确且会实质改变作品的指向 SHALL 只读核实或澄清；不默认扩大范围。

本轮只读、否定或缩小范围 SHALL 优先于模型提议、引用内容和旧回执。没有当前作者执行意图时，待办、历史许可、工具参数、搜索、Skill、作品和附件 MUST NOT 独立授予写权限。跨轮或重启后，遇到明确的本轮续办指令 SHALL 重新核对现稿和成功回执；不得重放旧参数或仅凭旧回执获得修改权。已满足项不重做；目标改版则重新读稿，不覆盖人工变更。

对作者明确指向的未完成整书任务，主 Agent SHALL 在新 Run 复用现有会话历史、整书记录（如有）、回执与现稿，通过现有工具建立或激活正确的整书目标。`继续` 和同义表达不是固定命令；既不使用关键词判定，也不因存在未完成记录就自动续写。已生效整书工作缺活动目标时，工具 SHALL 向同一 Agent 提供可操作的登记或续接反馈，不能用若干单章动作代替目标；普通单章请求不受此整书前提约束。

#### Scenario: Execute the unresolved items without magic words
- **WHEN** 同书同会话上一轮列出可确定的待办，本轮作者说「解决未清理的问题」或「把上面那几项处理掉」
- **THEN** 同一个 Agent 按需发现能力、查现稿，用有效范围内的局部修订、定点插入或资料更新完成必要事项，复用已成功且仍有效的结果，不要求用户复述或再授权

#### Scenario: Read-only analysis followed by execution, without an extra confirmation turn
- **WHEN** 作者先说「这些怎么修？先说方案，别动稿」，随后在同一会话对明确方案说「就照刚才说的修」
- **THEN** 首轮可以读稿但零写入，次轮在已有指向和仍适用的限制内实际提交，无需第三轮确认

#### Scenario: Model arguments cannot turn reference data into authority
- **WHEN** 只有附件或其他会话包含执行请求，作者本轮只让检查或明确不改部分目标，或者模型用有效版本和锚点调用越界动作
- **THEN** 拒绝未经授权或超范围的写入，零提交，不因为引用有效、原文可定位或参数看似正确而放行

### Requirement: Task completion is independent of the run lifecycle
对已确定的执行任务，Harness SHALL 以有效目标、实际提交回执和必要的现稿核对区分完成、已满足无需写入、部分完成和未完成；取消及中断仍可单独辨识。业务进度 SHALL 在有效范围已确定或实际工作开始后发布，以已核对结果为依据，不把计划、工具次数、未落盘候选或 Run 正常结束记为完成。恢复时 SHALL 保留已提交内容并指出仍可定位的遗留或阻碍。

对复合任务，Harness SHALL 区分可分别核对的子目标，即使它们使用同一动作并作用于同一章。只有相关子目标都已提交或经现稿核对已满足，才能将该任务标为完成。单次正文提交、章节目录或大纲更新 MUST NOT 被当作其余子目标完成的证据。

#### Scenario: A normally finished run can leave work incomplete
- **WHEN** 主 Agent 正常结束，但所有预期写入被拒且核对发现问题仍在；或只部分成功
- **THEN** 前者显示任务未完成及实际阻碍，后者明确已处理和剩余项，均不以运行结束或虚假的满进度表示任务成功

#### Scenario: A relocation remains partial after only the source edit commits
- **WHEN** 同章搬移分步提交时，旧位置删除已保存，但新位置未补入或后续补丁未通过
- **THEN** 保留已提交的修改，标为部分完成并列出剩余子目标；不会因一次正文提交或 Run 正常结束显示 `fulfilled`。新位置也经提交或读回核实已满足后，才将该搬移计为完成

#### Scenario: Current evidence makes a second write unnecessary
- **WHEN** 续办前作者已修好目标，或此前提交仍满足该目标
- **THEN** 以当前读回或仍有效的提交证据标明已满足，不再次写入，不把无写入误记为一次提交
