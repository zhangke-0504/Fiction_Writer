# Background Agent Harness Specification

## Purpose

规范本地桌面 Harness 的模型配置、协议适配、会话生命周期、异步任务及文件反馈。小说和普通工作目录共用运行能力，界面切换不会中断任务。

## Requirements

### Requirement: Multiple model profiles and protocol adapters
模型设置 SHALL 支持新增、编辑和保存多条具名配置；每条需要名称、API Key、请求地址和一个手输的模型 ID，协议置于可展开区。可选协议 SHALL 包括 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages，不代理拦截、不请求远程模型列表、不展示用量。各协议须支持流式文本、完整工具调用与结果回传，并提供不读取作品的连接测试。配置密钥 SHALL 由应用侧单独保护，不出现在应用返回的配置详情、工具环境、Session 历史、日志或仓库。

#### Scenario: Configure and select distinct profiles
- **WHEN** 用户在设置中保存两条地址和协议不同的配置并重新打开应用
- **THEN** 两者仍可在 Harness 选择，设置展示名称、地址、模型和协议而不回传密钥明文

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
- **THEN** 所有请求复用该应用级配置，无需按小说再次填写密钥；小说目录不写入供应商凭据

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
Harness SHALL 为实际模型请求估算输入预算，对旧文本和完整的历史工具往返按需压缩。压缩 SHALL 保留当前指令、关键作者约束、继续任务需要的进度、近期工具的匹配调用及协议所需原生状态。旧消息和整书任务的索引不因压缩改变。检查点 SHALL 私有且追加写入 Session；摘要失败 SHALL 有有限回退，不无限重试。

#### Scenario: Compact a long session with intact tool exchanges
- **WHEN** 长对话和多次工具调用超过保留预算
- **THEN** 实际的后续请求缩小，仍有当前方向、最早的已保留方向和足以继续的状态；近期 call/result 成对，所需原生字段原样透传

#### Scenario: Reopen a session after a checkpoint
- **WHEN** 产生压缩检查点之后重启应用或摘要端点失败
- **THEN** 原始会话可完整读取；重启后可用检查点和未压缩尾部继续，既不自动执行任务也不回放旧工具

### Requirement: Bounded durable tool execution receipts
实际执行的工具 SHALL 写入有限的回执，包含调用身份、结果和可确认的提交证据。回执 MUST NOT 把未执行调用变成成功操作，也不得存模型原生思考、供应商密钥、附件内容和原始工具输出。

#### Scenario: Inspect successes and failures after restarting
- **WHEN** 工具写入成功、部分成功或执行失败后打开同一 Session
- **THEN** 历史文件中的确认状态、实际落盘的文档身份及版本能区分已写和未写操作，且没有自动重放

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
