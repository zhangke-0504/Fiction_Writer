## MODIFIED Requirements

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

## ADDED Requirements

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
