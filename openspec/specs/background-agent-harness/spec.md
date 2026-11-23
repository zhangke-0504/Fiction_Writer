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

### Requirement: Global panel, directory-bound sessions and run options
应用 SHALL 在聚焦时支持 `Ctrl+Alt+I` 和可见入口切换 Harness 面板；只在面板内查询、新建、切换和删除 Session。Session SHALL 绑定创建时的小说或用户选择的普通目录，不随页面变化。发送前 SHALL 支持选择已配置模型、`low`／`medium`／`high` 思考等级及参考文件，默认 `high`；不能映射等级时 SHALL 明确显示采用模型默认值。本轮发送后模型、思考等级、目录及附件不因修改界面选项而改变。

#### Scenario: Start a session from the editor or the library
- **WHEN** 用户在小说页用快捷键打开面板创建会话，再从书库为一个普通目录创建会话
- **THEN** 两个会话独立存在且各自显示绑定目录，章节导航不包含历史列表；切换当前书籍不改变既有绑定

#### Scenario: Select a provider, effort and referenced file
- **WHEN** 用户在面板中用某条模型配置开始一轮，附加一份有效的本地文件，再在运行中切换页面和配置选择
- **THEN** 本轮只按发起时所选配置和工作目录运行，使用所附文件；后一轮才应用新选择，附件若缺失或超限应在发送前报告

### Requirement: General multi-step agent loop with local tools
后台 SHALL 支持不依赖小说结构的多步 Agent 循环，包含文件列表、文本搜索、文件读取、创建或覆盖、局部编辑、删除和命令执行。工具 SHALL 能在所选普通目录执行实际的文件和代码任务，而非只生成建议，不要求逐次审批或使用工具沙箱。命令须有工作目录、退出结果、超时、输出边界和取消；工具和模型错误 SHALL 产生可见结果而非无期限挂起。

#### Scenario: Edit and test code in an ordinary folder
- **WHEN** 用户选择没有任何小说元数据的本地示例代码目录并指示 Harness 修改一个文件并运行测试
- **THEN** 模型可经过搜索、读取、编辑和命令执行等多步工具往返，实际文件和测试结果反映这次任务

#### Scenario: A tool errors or a command hangs
- **WHEN** 命令超时或工具输入无效
- **THEN** 运行器生成可诊断的结果供模型或用户处理，不挂住界面和另一个工作区；达到运行边界时明确结束该轮

### Requirement: Background ownership and recoverable sessions
后台 SHALL 独立持有活跃运行与 Session，支持消息和运行状态流、历史持久化、在仍运行的应用内接回任务，以及重启后阅读历史。关闭面板、切换页面、切换 Session 或重载渲染界面 SHALL 不取消运行。每个绑定工作区最多一个活跃 Agent Run 或整书任务；应用完全退出或后台终止导致的未完成运行 SHALL 标为中断，不自动执行未确认完成的命令或文件写入。

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
