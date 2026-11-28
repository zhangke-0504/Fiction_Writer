## MODIFIED Requirements

### Requirement: Global panel, directory-bound sessions and run options

应用 SHALL 只在小说编辑页提供「AI」侧栏入口和 `Ctrl+Alt+I`。侧栏顶部 SHALL 将历史、新建 `+` 和关闭控件放在右侧，并移除「本地协作」「Harness」标题及历史页内的重复新建按钮。侧栏及关闭控件 SHALL 提供使用「AI」命名的无障碍名称。

侧栏 SHALL 只查询、创建、切换和删除当前 `bookId` 对应的 Session，小说同名时按 ID 区分。打开侧栏时，SHALL 基于当前小说成功加载的完整会话列表判断是否为空。空历史 SHALL 直接显示「新会话」和输入区。已有历史且尚未选择视图时 SHALL 显示会话历史。关闭侧栏前正在查看的当前小说会话 SHALL 可在重新打开时恢复。历史搜索 SHALL 只按会话名称做归一化子串匹配，搜索框 SHALL 显示「按会话名称查找」。零匹配 SHALL 留在历史视图并显示「没有匹配的会话」。

打开空历史的侧栏和点击顶部 `+` SHALL 使用同一个新会话输入界面。提交首条消息时 SHALL 创建持久化 Session 并用其 ID 启动本轮。创建成功但启动被拒绝时 SHALL 保留输入、参考文件和已取得的会话 ID，允许向同一会话重试。Session SHALL 固定绑定创建时的目录。离开编辑页 SHALL 关闭侧栏，已开始的运行由后台继续持有。旧普通目录 Session SHALL 保留后端存储。标题 SHALL 源于该 Session 第一条已保存的非空作者消息，规整并限定显示长度，后续消息不改名。

发送前 SHALL 支持选择已配置模型、`low`／`medium`／`high` 思考等级及参考文件，默认 `high`。不能映射等级时 SHALL 明确显示采用模型默认值。本轮发送后模型、思考等级、目录及附件不因修改界面选项而改变。Harness SHALL 以同一个自然语言发送入口处理讨论和任务。界面及发送请求 MUST NOT 要求对话、单章、整书或继续工作流的模式参数。选中章节如传入，只作为该绑定作品的当前上下文。

#### Scenario: Open the Harness only for the current editor

- **WHEN** 用户在书库或设置页按快捷键，或从一本书的编辑页切到另一本同名小说的编辑页再打开侧栏
- **THEN** 书库和设置页都不打开侧栏，新侧栏仅使用当前小说的 Session，旧书的运行继续

#### Scenario: Open the sidebar while session history is loading

- **WHEN** 用户打开侧栏时，当前小说的首份会话快照尚未返回
- **THEN** 侧栏在等待时显示加载状态，收到快照后按完整会话列表打开历史或新会话，读取失败时显示错误

#### Scenario: Start typing in a novel with empty history

- **WHEN** 用户用「AI」或快捷键打开没有已保存会话的小说侧栏
- **THEN** 可直接看到「新会话」的输入区。作者可以主动浏览空历史。未发送便关闭和重新打开时，历史仍为空，重新打开后可直接输入。未配置模型时，输入区提供模型设置入口

#### Scenario: Create a session on its first send

- **WHEN** 用户在已有历史的小说中点击顶部 `+`，完成输入并发送首条消息
- **THEN** 显示与空历史默认打开时相同的新会话界面。发送前历史保持原条目，发送时为当前小说创建一条会话并用该会话启动本轮

#### Scenario: Retry a rejected first send

- **WHEN** 首次发送已创建会话并取得 ID，但启动被拒绝，作者修正问题后再次发送
- **THEN** 侧栏保留输入及参考文件、显示启动错误，并使用已取得的会话 ID 重试

#### Scenario: Search current novel history by session name

- **WHEN** 当前小说有会话，用户先输入匹配会话名称的片段，再输入仅出现在会话目录中的片段
- **THEN** 第一次显示名称匹配的会话，第二次在历史页显示「没有匹配的会话」

#### Scenario: Name sessions from the first author input

- **WHEN** 用户在同一本书开启两个 Session，发送不同的首条消息，随后继续对话或重启应用
- **THEN** 两者显示可区分的首条作者输入标题，不使用共同的书名或之后的消息重命名，旧 Session 也能按历史推导标题

#### Scenario: Select a provider, effort and referenced file

- **WHEN** 用户在侧栏中用某条模型配置开始一轮，附加一份有效的本地文件，再在运行中切换页面和配置选择
- **THEN** 本轮只按发起时所选配置和工作目录运行，使用所附文件。后一轮才应用新选择，附件若缺失或超限应在发送前报告

#### Scenario: Discuss a book without writing any files

- **WHEN** 用户在绑定小说的侧栏发送「先聊聊怎么把《奥德赛》改编成十章小说，别写文件」
- **THEN** 不需要选择对话模式。Agent 提供建议，不执行写入，不启动整书生成
