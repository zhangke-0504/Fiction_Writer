# Background Agent Harness Specification

## Purpose

规范本地桌面 Harness 的模型配置、协议适配、会话生命周期、异步任务及文件反馈。小说和普通工作目录共用运行能力，界面切换不会中断任务。

## Requirements

### Requirement: Multiple model profiles and protocol adapters
模型设置 SHALL 支持新增、编辑和保存多条具名配置；每条需要名称、API Key、请求地址和一个手输的模型 ID，协议置于可展开区。新建配置 SHALL 先展示一个供应商选择页；首版「模型厂商」仅提供 DeepSeek，另有独立的「自定义配置」入口，两者复用同一表单。已保存配置 SHALL 直接打开编辑。供应商标识与协议 SHALL 分开保存，协议仍可选择 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages。不代理拦截、不提供账号登录、远程模型选择或用量展示；保存时仅允许已适配的供应商查询选定模型的能力。各协议须支持流式文本、完整工具调用与结果回传，并提供不读取作品的连接测试。配置密钥 SHALL 由应用侧单独保护，不出现在应用返回的配置详情、工具环境、Session 历史、日志或仓库。

#### Scenario: Configure and select distinct profiles
- **WHEN** 用户在设置中保存两条地址和协议不同的配置并重新打开应用
- **THEN** 两者仍可在 Harness 选择，设置展示名称、地址、模型、协议及适用的额度信息，不回传密钥明文

#### Scenario: Complete a tool round-trip per protocol
- **WHEN** 针对每种协议的受控端点分块返回工具调用参数
- **THEN** 适配器使用该配置的端点和鉴权，收齐并校验参数后调用工具，以该协议的调用身份提交结果，并接收后续流式回复

#### Scenario: Preserve requested DeepSeek continuation fields
- **WHEN** DeepSeek Chat Completions 端点在启用思考的工具轮次要求接续所需的推理字段
- **THEN** 同一轮的后续请求包含要求的原生状态，跨协议 Session 历史和应用日志不记录该原生字段

#### Scenario: Report tool incompatibility separately from basic connectivity
- **WHEN** 测试地址能返回普通文本但经工具往返检测不能完成调用
- **THEN** 测试结果分别给出连接成功、工具验证未通过的状态，而不自动改用其他协议或向其他地址发送密钥

#### Scenario: Reuse one saved profile across novels
- **WHEN** 作者保存一次有效配置，在两本新建的小说发起请求，重启应用后再次发送
- **THEN** 所有请求复用该应用级配置及已保存的模型能力，不需按小说重新填写密钥或识别额度；小说目录不写入供应商凭据

#### Scenario: Pick a vendor before setting up a profile
- **WHEN** 用户打开「新建配置」并选择 DeepSeek，或返回选「自定义配置」
- **THEN** 厂商列表只有 DeepSeek，没有账号登录；两条路径使用同一配置表单，DeepSeek 路径预填对应默认地址和协议，模型仍手填，选择与返回不联网；已有配置不经过选择页即可编辑

### Requirement: Global panel, directory-bound sessions and run options
应用 SHALL 只在小说编辑页提供 Harness 面板入口和 `Ctrl+Alt+I`。面板 SHALL 只查询、创建、切换和删除当前 `bookId` 对应的 Session，小说同名时不混用。Session SHALL 固定绑定创建时的目录；离开编辑页 SHALL 关闭面板，但不取消已开始的运行。旧普通目录 Session SHALL 保留后端存储。标题 SHALL 源于该 Session 第一条已保存的非空作者消息，规整并限定显示长度，后续消息不改名。发送前 SHALL 支持选择已配置模型、`low`／`medium`／`high` 思考等级及参考文件，默认 `high`；不能映射等级时 SHALL 明确显示采用模型默认值。本轮发送后模型、思考等级、目录及附件不因修改界面选项而改变。Harness SHALL 以同一个自然语言发送入口处理讨论和任务；界面及发送请求 MUST NOT 要求对话、单章、整书或继续工作流的模式参数。选中章节如传入，只作为该绑定作品的当前上下文。

#### Scenario: Open the Harness only for the current editor
- **WHEN** 用户在书库或设置页按快捷键，或从一本书的编辑页切到另一本同名小说的编辑页再打开面板
- **THEN** 书库和设置页都不打开面板；新面板只列新书的 Session，旧书运行不停止

#### Scenario: Name sessions from the first author input
- **WHEN** 用户在同一本书开启两个 Session，发送不同的首条消息，随后继续对话或重启应用
- **THEN** 两者显示可区分的首条作者输入标题，不使用共同的书名或之后的消息重命名；旧 Session 也能按历史推导标题

#### Scenario: Select a provider, effort and referenced file
- **WHEN** 用户在面板中用某条模型配置开始一轮，附加一份有效的本地文件，再在运行中切换页面和配置选择
- **THEN** 本轮只按发起时所选配置和工作目录运行，使用所附文件；后一轮才应用新选择，附件若缺失或超限应在发送前报告

#### Scenario: Discuss a book without writing any files
- **WHEN** 用户在绑定小说的面板发送「先聊聊怎么把《奥德赛》改编成十章小说，别写文件」
- **THEN** 不需要选择对话模式；Agent 提供建议，不执行写入，不启动整书生成

### Requirement: General multi-step agent loop with local tools
后台 SHALL 支持不依赖小说结构的多步 Agent 循环，包含文件列表、文本搜索、文件读取、创建或覆盖、局部编辑、删除和命令执行。工具 SHALL 能在所选普通目录执行实际的文件和代码任务，而非只生成建议，不要求逐次审批或使用工具沙箱。命令须有工作目录、退出结果、超时、输出边界和取消；工具和模型错误 SHALL 产生可见结果而非无期限挂起。

#### Scenario: Edit and test code in an ordinary folder
- **WHEN** 用户选择没有任何小说元数据的本地示例代码目录并指示 Harness 修改一个文件并运行测试
- **THEN** 模型可经过搜索、读取、编辑和命令执行等多步工具往返，实际文件和测试结果反映这次任务

#### Scenario: A tool errors or a command hangs
- **WHEN** 命令超时或工具输入无效
- **THEN** 运行器生成可诊断的结果供模型或用户处理，不挂住界面和另一个工作区；达到运行边界时明确结束该轮

### Requirement: Discover and activate built-in writing skills on demand
对小说会话，后台 SHALL 向通用 Agent 提供内置 Skill 检索和按注册标识加载指令的工具。检索 SHALL 返回与当前任务相关的候选及简要用途；加载 SHALL 只提供被选中的已注册 Skill 指令。模型 SHALL 能在同一 Run 中理解当前请求、实际检索并选择对应的 Skill，再用现有工具执行。检索排名、Skill 内容或附件 MUST NOT 自行授予写入权限或启动任务。整书请求 MUST NOT 通过专用任务模式、固定整书阶段机、特定提示词匹配或包装该阶段机的工具执行。

#### Scenario: A task discovers and uses a built-in skill in the same run
- **WHEN** 用户在小说会话要求生成一整本小说，模型检索相应写作能力并选中候选 `generate-novel`
- **THEN** 同一 Agent Run 实际返回检索结果、加载该 Skill、把指令交给后续模型请求，再由模型调用小说工具；用户不需要选模式、手工指定 Skill 或审批每一步

#### Scenario: Unsupported skill names and ordinary directories do not trigger writing skills
- **WHEN** 模型申请加载未知 Skill 或提供任意文件路径，或者请求来自普通目录会话
- **THEN** 未注册 Skill 不会被读取或执行；普通目录仍可用通用工具处理本地任务，不注入小说 Skill 或工具

### Requirement: Background ownership and recoverable sessions
后台 SHALL 独立持有活跃运行与 Session，支持消息和运行状态流、历史持久化、在仍运行的应用内接回任务，以及重启后阅读历史。关闭面板、切换页面、切换 Session 或重载渲染界面 SHALL 不取消运行。每个绑定工作区最多一个活跃 Agent Run，整书任务使用同一运行和停止机制；应用完全退出或后台终止导致的未完成运行 SHALL 标为中断，不自动执行未确认完成的命令或文件写入。

#### Scenario: Navigate away while a novel task is running
- **WHEN** Agent 在小说 A 新增主体并开始续写一章，用户关闭 Harness、回书库新建小说 B，再返回小说 A
- **THEN** A 的 Session 是同一次运行，新主体在列表中，正在生成的章节可重新接上当下预览，并在完成后读取已保存正文

#### Scenario: Reconnect after missing events
- **WHEN** 渲染界面重载或事件游标落后于保留窗口
- **THEN** 界面从后台取得最新文档、消息、状态和活跃预览快照，再接后续更新，不重复应用旧事件或启动第二次任务

#### Scenario: Recover a missed file notification while the current view stays open
- **WHEN** 当前作品的文件变更通知未到达界面，而后续 Run 状态的事件序号显示有缺口
- **THEN** 系统重新读取当前作品和运行快照，不需要切页或重新聚焦即可看到落盘的变更

#### Scenario: A second task targets the same work directory
- **WHEN** 小说 A 已有活跃任务，用户从另一 Session 请求同一工作区的任务，再到另一个目录发起任务
- **THEN** 同工作区的请求被明确告知忙，另一个目录仍可运行，作者仍能使用书库及编辑器

#### Scenario: App restarts after interruption
- **WHEN** 应用在一次运行未完成时完全退出，随后重新启动
- **THEN** 可以重开已保存的 Session，运行显示中断，已提交的文件保留，未完成的工具操作不自行重放

### Requirement: Committed change notifications and live chapter previews
应用 SHALL 将确认落盘的小说变更及时投影到资产列表及相关文档，并将写章的未提交增量正文明确标为生成预览。预览只出现在目标章的无冲突视图，成功校验并落盘后才成为原稿；失败、停止或提交前提不匹配 SHALL 不以预览覆盖磁盘。未保存的人工输入 SHALL 不被后台更新覆盖，也不会无提示保存到已经变更的文件上。

#### Scenario: Committed updates refresh an open asset view
- **WHEN** 运行中的 Agent 新增、修改或删除正在查看的主体、伏笔、章节或大纲中的一项
- **THEN** 成功落盘后，对应列表或干净的文档视图更新，无需手动刷新，也不会把未提交的工具输入当成文档

#### Scenario: A selected chapter receives actual streamed prose
- **WHEN** 写章工具为当前选中且无未保存编辑的章生成两段可独立观察的文本
- **THEN** 编辑器在本轮结束前逐次显示标记为未保存的预览，磁盘保持旧稿；成功提交后预览由已保存正文替代

#### Scenario: Preserve a human draft when a committed change arrives
- **WHEN** 作者有未保存的章节编辑，后台对同一章提交了一次变更
- **THEN** 界面保留未保存文本并提示冲突，可复制草稿或重载磁盘原稿；旧编辑缓冲不会静默覆盖新文件

#### Scenario: Reject an obsolete generation base
- **WHEN** 写章任务生成预览期间，原稿已被其他已确认的写入更改
- **THEN** 写章任务不提交基于旧稿的预览，显示冲突并保留已经更改的磁盘正文

#### Scenario: A workspace file is changed outside the managed write path
- **WHEN** 用户使用外部编辑器保存了有效的 Markdown，或通用 Shell 命令在当前工作目录修改文档
- **THEN** 应用重读受影响的文档，重新聚焦时能核对磁盘源，重复通知不会产生重复列表项

### Requirement: Stop runs and hard-delete sessions without resurrection
面板 SHALL 支持停止一轮运行并等待被管理的流、工具和写入退出。主动停止保留已提交改动，丢弃未提交生成预览。删除 Session SHALL 不要求删除确认、不归档；活跃 Session 先停止再实际移除历史。已知绑定到被删除小说的任务 SHALL 先停止后删除作品，既有 Session 历史不因此伪造一个可写工作区。

#### Scenario: Delete a Session while writing
- **WHEN** 用户直接删除一个有在途工具或未提交预览的 Session
- **THEN** 系统阻止新任务、停止并等待写操作结束，移除持久化历史；迟到事件不会把会话或历史重新建回来

#### Scenario: Delete an active novel
- **WHEN** 用户硬删除当前被 Agent 使用的小说
- **THEN** 在该作品的受管理任务停止后才删除目录，相关历史仍可阅读但显示目录不可用，后台不会重建已删作品

#### Scenario: Concurrent workspace deletion cannot restore a deleted session
- **WHEN** 作品正在被删除，而用户同时硬删除该作品关联的 Session
- **THEN** 作品删除只更新仍存在的 Session；已删除的会话文件和条目在重启后也不复活

### Requirement: Bounded session context and append-only checkpoints
Harness SHALL 为实际模型请求估算输入预算，对旧文本和完整的历史工具往返按需压缩。压缩 SHALL 保留当前指令、关键作者约束、继续任务需要的进度、近期工具的匹配调用及协议所需原生状态。旧消息和整书任务的索引不因压缩改变。检查点 SHALL 私有且追加写入 Session；摘要失败 SHALL 有有限回退，不无限重试。每次开始新的 Run 时，Harness SHALL 仅为同一会话的近期旧对话原文计算配额：从首条主 Agent 请求的规划输入预算扣除系统指令、当前消息和工具定义的输入估算，取非负剩余空间的 `43%`（向下取整）作为一项约束。若配置能力来源为供应商声明，另一项约束为规划输入预算的 `5%`（向下取整）；若使用厂商兜底、通用兜底或无已确认额度，另一项约束为 `9,800`。SHALL 取两者较小值，从最近开始保留完整的旧对话分组。此配额不增加总输入预算，不改变作品记忆、摘要请求预算或当前 Run 工具往返的裁剪规则。

#### Scenario: Compact a long session with intact tool exchanges
- **WHEN** 长对话和多次工具调用超过保留预算
- **THEN** 实际的后续请求缩小，仍有当前方向、最早的已保留方向和足以继续的状态；近期 call/result 成对，所需原生字段原样透传

#### Scenario: Reopen a session after a checkpoint
- **WHEN** 产生压缩检查点之后重启应用或摘要端点失败
- **THEN** 原始会话可完整读取；重启后可用检查点和未压缩尾部继续，既不自动执行任务也不回放旧工具

#### Scenario: Scale retained dialogue with the confirmed input budget
- **WHEN** 同一会话开始新的普通请求，配置中的 DeepSeek 能力来自供应商声明，规划输入预算为 `1,039,184` 且剩余空间约束允许
- **THEN** 近期旧对话原文的预算为 `51,959` 个估算 token；实际发出的原文仅来自同会话可用的完整分组，不为填满配额回读既有检查点前的原文或其他会话

#### Scenario: Keep current input and unknown capability fallbacks bounded
- **WHEN** 当前系统指令、作者消息和工具定义使剩余空间约束低于原文上限，或能力来自厂商兜底、通用兜底或未确认的配置
- **THEN** 前者由剩余空间的 `43%`（向下取整且不为负）限制；后者按剩余空间约束与 `9,800` 中较小者规划，即便厂商兜底声明了 1M 窗口也不改用 `5%`；未纳入的旧对话按既有检查点机制处理，不删除原始记录

### Requirement: Bounded durable tool execution receipts
实际执行的主工具及其既有写作子请求工具 SHALL 写入有限的回执，包含调用身份、结果和可确认的提交证据。回执 MUST NOT 把未执行调用变成成功操作，也不得存模型原生思考、供应商密钥、附件内容和原始工具输出。主 Agent 的委派与等待调用只记调用结果，不是子任务完成或业务提交的证据；委派任务内部的查询和报告往返 MUST NOT 写入父会话历史或持久回执，不随重启重建。

#### Scenario: Inspect successes and failures after restarting
- **WHEN** 工具写入成功、部分成功或执行失败后打开同一 Session
- **THEN** 历史文件中的确认状态、实际落盘的文档身份及版本能区分已写和未写操作，且没有自动重放

#### Scenario: A successful start receipt does not prove completion or persistence

- **WHEN** 主 Agent 启动一个稍后失败的子任务并等待，之后重开 Session
- **THEN** 只保留主调用的有限回执且没有业务提交；子任务说明、报告和往返未存入父会话，打开历史不重建或执行任务

### Requirement: Tool-scoped writing requests in a single Harness loop
绑定小说会话 SHALL 由同一个主 Agent 分析作者意图、选择 Skill、读取所需资料、提出本次创作安排并选择下一工具。系统 MUST NOT 根据作者措辞切换外层 System 的任务角色，不得引入专用 UI 模式、小说阶段机、可调用写作工具的生成子 Agent 或额外会话。主 Agent 显式调用的本 Run 只读委派不改变上述职责。工具前提不满足时 SHALL 把可定位结果交回同一 Agent，而不是自动调用其他生成工具；作者只讨论时不得调用用于写入的生成工具或写入作品。就绪采用可复用的书内规则，不新增必须经过的固定预检或补资料阶段；现稿无变化时，反馈 SHALL 足以引导 Agent 而不重复全库读取。Agent 仍可自行重查、选择另一个合法方案或请求澄清，不得以封禁正常重查、调大循环上限或放宽写权限掩盖错误。

主体、伏笔和章节生成工具 SHALL 在校验任务范围后，按工具和动作选择内置模板，从绑定作品取得本次资料，组装独立模型请求。生成请求 SHALL 使用本轮作者要求和有效的逐动作范围，包括适用的续接约束及经核对的同会话指代；主 Agent 的安排作为另标的提议，不独立授予权限或替代事实。工具请求 MUST NOT 继承完整的外层会话、外层 System 或通用工具。代码组装模板无需模型另写 System；定位证据确有需要时 SHALL 支持独立、有限的只读取材，结果仅用于该任务，不产生写入或额外 Agent 循环。

主 Agent 主动读取的资料按现有预算进入其上下文。工具 SHALL 只把有界的提交、缺项或冲突回执返回外层，不默认回传其 System、完整取材包或生成全文；主 Agent 可通过正常的作品读取工具进一步取用。取材与生成 SHALL 遵循发起 Run 的取消和作品绑定。

#### Scenario: Generate one subject without starting a book pipeline
- **WHEN** 在已有小说中仅要求为指定主体补说明，且已有足够资料
- **THEN** 主 Agent 可按需要读取和执行该主体工具；实际生成请求只有主体任务模板和此次资料，生成工具不启动伏笔、写章、取材子 Agent 或整书任务；回执不含完整说明或请求，之后仅在显式读取时取得保存内容

#### Scenario: A missing prerequisite returns control to the same Agent
- **WHEN** 一次写章工具发现本章的必需主体没有说明
- **THEN** 向当前 Agent 返回目标章和缺失主体，不自动发主体生成请求；仅在 Agent 根据作者允许的范围另行调用工具后才补资料，之后任何写章调用重新核对现稿

#### Scenario: Draft uses bounded readback without consuming the outer history budget
- **WHEN** 主 Agent 的简短安排指向早期原文，而默认取材不能定位该证据
- **THEN** 写章工具能在本次 Run 内进行有界的只读取材，正文请求使用经核对的结果；取材不启动独立 Agent，会话不自动接收选材请求和原文，普通目录会话不注册这些写作能力


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

### Requirement: Persist model limits while saving a global model profile
保存已适配的模型配置 SHALL 使用该厂商的查询规则，在限定时间内为本次表单中的地址、协议和模型解析能力，校验数值后与配置原子持久化。首版只查询匹配的官方 DeepSeek 端点，不从自定义或中转端点的名称或协议推断官方能力；查询不得将凭据转发给不匹配的站点或跨源复用旧 Key，不发送作品、生成请求或原始供应商错误。能力缺失、无效或查询失败 SHALL 保存当前配置适用的兜底并显示来源，不要求另行点击检测；凭据保护或配置写入失败仍不得报告保存成功。既有无能力字段的配置 SHALL 可用本地兜底加载，不在启动、建书或运行时自动查询。活动 Run SHALL 继续用启动时解析的配置。

#### Scenario: Save provider-declared limits without a second action
- **WHEN** 已选 DeepSeek 且地址与协议匹配，用户手填模型 ID 并点「保存配置」，官方查询返回多条模型中的匹配条目及有效额度
- **THEN** 配置保存该模型的上下文窗口、最大输出及供应商来源并在设置页显示，不使用列表第一项替代、不生成正文、不额外要求测试连接

#### Scenario: Save with the appropriate fallback when capability discovery fails
- **WHEN** 已知官方 DeepSeek 模型查询超时、失败或返回不合法额度，或者配置是未识别的官方模型/自定义端点
- **THEN** 前者按适用的 DeepSeek 兜底 `1,048,576` 上下文和 `393,216` 最大输出保存；后者按通用兜底 `64,000` 和 `8,192` 保存；两者均标明降级，不宣称已测通写作请求

#### Scenario: Do not query official capabilities with a gateway credential
- **WHEN** 地址是中转网关、伪似官方域名，或其他与所选协议不匹配的路径，即使模型叫 `deepseek-flash`
- **THEN** Writer 不向官方查询端点发送该凭据，不因模型同名套用官方额度，也不阻止有效配置按通用兜底保存。若合规的官方查询返回重定向，Writer 不跟随也不转发凭据，视为查询失败并使用相应兜底

#### Scenario: Replace capability data when changing a profile
- **WHEN** 用户编辑配置并保存不同模型或端点，或在旧版留下的配置上首次保存
- **THEN** 新额度按更新后的配置身份解析，不能沿用不同身份的额度；保持配置 ID 与已有会话引用。同源留空 Key 使用已安全保存的 Key，切到不同来源时不得自动把旧 Key 用于新查询

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

现有范围登记 SHALL 能把一项 `subject.update` 或 `clue.update` 绑定为精确资料补丁。沿用同一次范围核对，将资料类型及 ID、当前修订、精确原文及替换一起绑定到作品、会话、作者消息及本 Run。仅文档级的更新登记、已满足记录或只登记为待办的目标 MUST NOT 代替此绑定。同一登记 MUST NOT 用于另一处唯一锚点、另一替换文本、另一修订或全文更新；过期后只能基于当前原文按本轮有效授权重新登记，不能凭历史登记继续写。对本轮已明确指向、但暂不能核对精确补丁且无适用全文路径的资料，登记 SHALL 能保留为不授权写入的目标，不丢弃该待办或扩大范围。不得新增审批轮或模型核验步骤。

#### Scenario: Execute the unresolved items without magic words

- **WHEN** 同书同会话上一轮列出可确定的待办，本轮作者说「解决未清理的问题」或「把上面那几项处理掉」
- **THEN** 同一个 Agent 按需发现能力、查现稿，用有效范围内的局部修订、定点插入或资料更新完成必要事项，复用已成功且仍有效的结果，不要求用户复述或再授权

#### Scenario: Read-only analysis followed by execution, without an extra confirmation turn

- **WHEN** 作者先说「这些怎么修？先说方案，别动稿」，随后在同一会话对明确方案说「就照刚才说的修」
- **THEN** 首轮可以读稿但零写入，次轮在已有指向和仍适用的限制内实际提交，无需第三轮确认

#### Scenario: Model arguments cannot turn reference data into authority

- **WHEN** 只有附件或其他会话包含执行请求，作者本轮只让检查或明确不改部分目标，或者模型用有效版本和锚点调用越界动作
- **THEN** 拒绝未经授权或超范围的写入，零提交，不因为引用有效、原文可定位或参数看似正确而放行

#### Scenario: A registered asset patch authorizes only one exact change

- **WHEN** 本轮登记了资料的一处精确修订，模型尝试对同一文档的另一处已读且唯一的锚点替换、只改变替换文本，或把该登记用于全文更新；对照调用仅有文档级登记或来自另一 Run
- **THEN** 这些调用不提交且不计为目标完成；只有与当前 Run 的精确登记及当前读稿一致的补丁才可进入提交路径，不要求作者再次复述原文

### Requirement: Task completion is independent of the run lifecycle

对已确定的执行任务，Harness SHALL 以有效目标、实际提交回执和必要的现稿核对区分完成、已满足无需写入、部分完成和未完成；取消及中断仍可单独辨识。业务进度 SHALL 在有效范围已确定或实际工作开始后发布，以已核对结果为依据，不把计划、工具次数、未落盘候选或 Run 正常结束记为完成。恢复时 SHALL 保留已提交内容并指出仍可定位的遗留或阻碍。

对复合任务，Harness SHALL 区分可分别核对的子目标，即使它们使用同一动作并作用于同一章。只有相关子目标都已提交或经现稿核对已满足，才能将该任务标为完成。单次正文提交、章节目录或大纲更新 MUST NOT 被当作其余子目标完成的证据。

同会话收尾 SHALL 分别核对实际待办中的正文和资料，已满足或已提交且仍有效的项不重做。精确资料登记只因匹配的真实提交与当前修订一致才计为写入完成；已有当前证据可按原语义计为无需写入。不能安全写入的已知资料待办仍 SHALL 计入目标，不能因未生成候选、登记为只待办或定点写入被拒而从任务结果消失。只满足部分目标仍为 `partial`；全未满足时为 `incomplete`，均不由 Run 正常结束覆盖。

#### Scenario: A normally finished run can leave work incomplete

- **WHEN** 主 Agent 正常结束，但所有预期写入被拒且核对发现问题仍在；或只部分成功
- **THEN** 前者显示任务未完成及实际阻碍，后者明确已处理和剩余项，均不以运行结束或虚假的满进度表示任务成功

#### Scenario: A relocation remains partial after only the source edit commits

- **WHEN** 同章搬移分步提交时，旧位置删除已保存，但新位置未补入或后续补丁未通过
- **THEN** 保留已提交的修改，标为部分完成并列出剩余子目标；不会因一次正文提交或 Run 正常结束显示 `fulfilled`。新位置也经提交或读回核实已满足后，才将该搬移计为完成

#### Scenario: Current evidence makes a second write unnecessary

- **WHEN** 续办前作者已修好目标，或此前提交仍满足该目标
- **THEN** 以当前读回或仍有效的提交证据标明已满足，不再次写入，不把无写入误记为一次提交

#### Scenario: A same-session cleanup completes only the documented remaining work

- **WHEN** 上轮增补已有真实回执和可见待办，当前作者要求收尾；本轮正文补丁与定点资料替换均获得实际提交，另有此前已满足的增补
- **THEN** 回执与当前文件证明两个续办项均已完成，不重复增补、不把其中一次提交当成另一次，按实际结果完成任务

#### Scenario: A blocked asset is still counted after a chapter commits

- **WHEN** 正文收尾实际提交，资料定点操作被拒，或资料目标已知但只能登记为待办，主 Agent 随后正常结束
- **THEN** 正文提交保留，资料没有虚假写入或满进度，仍报告资料剩余项和 `partial`，无权用全文工具清掉这一项

### Requirement: Bound rereadable tool results before model dispatch

Harness SHALL 对主 Agent 实际出站的可重读工具资料分别应用单条结果、同一回复触发的整批新结果、历史各轮保留原文的预算，即使整次模型请求仍能装入硬输入窗口也要生效。结果预算 SHALL 以实际序列化的资料体积估算，并服从原有输入预算；不改变模型输出计划、原生往返结构、旧对话原文配额或主循环执行顺序。

新的结果不能完全装入时 SHALL 使用有效分页或明示未携带的可回读引用；旧的可重读资料 SHALL 能去重或退为可定位引用，不能把引用或预览当原文。保留的工具往返 SHALL 保持调用与结果成对、原调用身份与顺序以及协议要求的原生块；需要丢弃旧往返时 SHALL 按完整往返处理。Harness SHALL 优先保留当前作者输入、有效目标及范围、可续办待办、必要 Skill 和能核对已完成工作的提交回执；不能靠把必要控制状态截成不完整片段来装入请求。必要状态仍装不下时沿用原有上下文不足行为，不伪造已送达或重做旧写入。投影 MUST NOT 改写作品、会话原记录或持久回执，不新增原始工具结果留存。

#### Scenario: Cap a large read batch well below the provider context limit

- **WHEN** 大窗口主 Agent 在一个回复中请求多个长资料页，每条本可单独装入模型窗口，后续还要继续取材
- **THEN** 实际出站的单条与同批可重读部分都在其配额之内；工具结果仍与原调用匹配并保持顺序，未携带的内容可定位回读而不是伪造完整数据，模型实发输出上限不因为投影改变

#### Scenario: Retain useful state without accumulating old rereadable text

- **WHEN** 多轮取得大段原文并产生可核对的写入回执，同版同范围被重复读取，后续请求仍远小于模型硬输入窗口
- **THEN** 历史保留的可重读原文合计受历史配额约束；旧正文可退为含文档、修订、范围的引用，近期原生往返和继续工作所需的任务状态仍有效；原稿、会话记录与真实回执未被投影改写，已完成的写入不重放

#### Scenario: Preserve first whole-book skill dispatch under read pressure

- **WHEN** 合格的首次整书 Skill 结果和若干大读取结果同轮装配，或因必要资料无法装入而没有派发
- **THEN** 能装入时必要指南完整携带、原生往返匹配，仍按已有首个整书 Skill 的预算规划；未派发时不生成已应用 Skill、已送达结果或实际派发预算的证据

### Requirement: Explicitly delegate read-only tasks within one Run

绑定小说与普通目录会话 SHALL 共用通用任务委派。主 Agent SHALL 能通过现有工具发现查看委派与等待能力，按需显式调用启动工具，传入有界任务说明、预期产物及可选来源引用。启动工具 SHALL 返回本 Run 的任务 ID 而不等待子模型；主 Agent 可继续执行独立工作或再启动任务。主工具执行顺序不变。后台 MUST NOT 根据作者措辞、书名、Skill、读取结果或模型触限自动委派，不要求作者另行选择委派模式或再审批。

子任务 SHALL 继承当前 Run 的作品或目录绑定与模型配置，维护独立模型上下文、工具往返和工具目录，不继承父或兄弟任务的历史、原生状态或未显式传入的附件内容。子工具目录 SHALL 只提供适用当前会话的纯查询和任务本地报告能力，不提供业务写入、记忆持久化、命令执行、范围登记、整书激活、递归委派或创建会话；子任务 MUST NOT 改动作品、工作区文件、父会话或进度。允许以有界报告返回查证、审阅、比较结果或候选文字，不视为保存。子任务 MUST NOT 获得 Messages 主 Agent 的逐项续接资格。

#### Scenario: Start independent tasks and make parent progress before waiting

- **WHEN** 主 Agent 发现委派工具，显式启动两个独立任务，且夹具保持两条子模型请求在途
- **THEN** 两个启动回执不等子模型完成，实际子模型请求有重叠，父 Agent 仍可发出下一条模型请求并执行不依赖结果的工作；没有改变普通父工具的执行顺序

#### Scenario: Keep discovery, inputs and output in the task's own context

- **WHEN** 子任务在带有父会话历史的小说或普通目录 Run 中多轮搜索并定向读取，或尝试发现父写入或委派能力
- **THEN** 子请求只含明确交付的任务输入及自己的往返，结果不泄漏到兄弟任务或父流与会话记录；只呈现当前绑定的纯查询，不能调用父写入或委派工具，普通目录不出现小说工具；父只按需取得有界报告

#### Scenario: No implicit delegation or fallback on a truncated parent response

- **WHEN** 主 Agent 未显式调用启动工具，或未登记范围时其含委派候选的回复因输出触限而截断
- **THEN** 不创建子任务、不执行截断批次，不猜写入参数；符合资格的已登记父续接仍只按既有逐项规则处理，不重放已执行调用

### Requirement: Bound delegated task resources and finish them with the parent Run

Harness SHALL 至多同时运行两个子任务，并设置每任务及本 Run 子任务合计的模型请求、读取、结果体积和耗时上限，以及本 Run 接受任务总数上限。启动容量不足或累计预算耗尽 SHALL 返回可区分结果，不排队、不启动超额工作。失败、截止和取消保持可区分；一项失败 MUST NOT 清除其他任务的结果，也不自动重试整项任务。父 Run 取消、失败或正常结束时 SHALL 停止新子工作、取消未完成子任务并等待其退出，然后才完成 Run 的收口。任务 ID、子状态和报告 MUST NOT 跨 Run 可用或在重启后自动恢复；不会产生额外活跃 Run，也不占用额外会话。

#### Scenario: Refuse capacity and stop an exhausted child without discarding another result

- **WHEN** 两个子任务在途时尝试启动第三个，且随后一项达到自己的资源上限而另一项正常提交报告
- **THEN** 第三个明确未启动；超额任务停止新增派发或读取，另一项的结果仍可独立交付。已取得完整的阶段报告可标为部分结果，没有可用报告则明确终止原因，不猜补截断数据

#### Scenario: Join children before stopping or releasing the Run

- **WHEN** 父 Run 被停止、因错误或正常结束，尚有子模型或受管理的读取在途
- **THEN** 父停止或结束前取消并等待子任务退出，受管理的停止、删除工作区或会话操作不留下子任务；下一 Run 不能查询前一 Run 的 ID，重启也不恢复它

### Requirement: Deliver bounded delegated reports on demand

等待工具 SHALL 只查询指定的本 Run 任务，有新终态时返回，不启动或重跑任务。SHALL 区分完成、部分结果、失败、任务超时和取消，及本次等待到时仍在运行的 ID；等待到时 MUST NOT 取消任务。单个未知 ID 不丢弃其他已知任务的状态、报告或终止原因。阶段报告必须来自此前完整接受的内容，不使用截断工具参数、半截文字或原生流。

报告 SHALL 有界，包含可用发现、可回读出处和未查项；未知不得写成不存在。父请求只携带实际选中的报告和状态，不继承子提示、逐轮内容、调用或原生状态。Harness SHALL 仅在向父请求传输层交付完整报告时标记该报告送达；同一请求去重，限额所致的延期只返回明确状态并保持可再次获取。后续历史可在配额内保留近期报告或退为短引用；重复等待已派发报告只返回状态，不新增正文副本。配对和必要控制状态维持现有规则；一次合法的同轮请求重发不算再次交付或执行。

#### Scenario: Poll and wait without conflating wait timeout and task timeout

- **WHEN** A、B 都在运行，一次等待先到时，之后 A 完成而 B 仍运行；对照中 B 后来达到自己的截止
- **THEN** 首次等待不结束 A 或 B；后续等待可先交付 A 而不等 B，B 的任务超时单独报告；重复等待不启动 A 或 B 也不重复注入已派发报告

#### Scenario: Redeliver a report whose earlier wait only dispatched a reference

- **WHEN** 任务已有终态报告，但父模型请求预算只允许携带状态或未派发；随后父 Agent 在同 Run 再次等待该 ID
- **THEN** 第一次不记为报告送达，仍可在下一次装得下的派发中交付；同一父请求中多个等待结果指向同一报告时只携带一份，保持每个工具调用和结果配对

### Requirement: Compact tool activity in Harness conversations

Harness SHALL render each contiguous group of tool activity messages as one collapsed-by-default disclosure in the conversation. Expanding the disclosure SHALL show the individual tool activity messages and their outcomes in their original order. User messages, assistant-visible text, progress, run status, and errors SHALL remain independently visible and in their original chronological positions. Older sessions containing text-only tool activity messages SHALL remain readable and eligible for grouping without a history migration.

#### Scenario: Review a run with consecutive tool activity
- **WHEN** a Harness conversation contains several consecutive tool activity messages followed by assistant-visible text
- **THEN** the tool activity appears as one collapsed summary, and the assistant text remains a separate visible message after it

#### Scenario: Expand tool activity details
- **WHEN** the author expands a grouped tool activity summary
- **THEN** the individual tool activity messages and success or failure outcomes are visible in their saved order

#### Scenario: Read an older session
- **WHEN** the author opens a session saved before grouped tool activity is introduced
- **THEN** existing text-only tool activity messages can be grouped and expanded without changing the saved session or hiding other messages

#### Scenario: Preserve non-tool conversation content
- **WHEN** tool activity is adjacent to progress, run status, an error, a user message, or assistant-visible text
- **THEN** those items remain independently visible and retain their chronological positions relative to the tool activity group
