## ADDED Requirements

### Requirement: Book-bound durable memory and provenance
Harness SHALL 从会话绑定的 `bookId` 读写一份独立的 `.fiction-writer/memory.json`，不得按模型传入的书名或路径选择作用域。Markdown SHALL 为作品事实的权威来源。可召回的故事证据 SHALL 标记稳定文档 ID、版本和原文出处。聊天、未提交的预览和未被采用的想法不得自动写入作品记忆。

#### Scenario: Recall an old clue in a new session of the same book
- **WHEN** 一本小说的早期已保存正文埋有线索，而在后续章节的新 Session 请求引用它
- **THEN** 能找回带来源的早期段落；另一本同名书的 Session 不召回它

#### Scenario: Discard stale or unsaved evidence
- **WHEN** 作者修改或删除来源文档（包括应用外修改），或生成只产生中途预览而没有提交
- **THEN** 后续召回不使用旧版本、已删除文档或预览中的文字；索引失败不把一次已提交的写作判为失败

### Requirement: Explicit durable author conventions
书内工具 SHALL 能查询和保存作者明确要求长期遵守的约定，并能按作者的新要求更正或遗忘。未明确要求记忆的对话内容不成为持久约定；本轮指令优先于既存约定。

#### Scenario: Remember and update a stable writing convention
- **WHEN** 作者明确要求记下、修订或移除一条约定，并另开同书 Session 或重启
- **THEN** 仅该书取到已确认保存的最新约定，其他作品不受影响

### Requirement: Story timeline scope
召回 SHALL 区分既有正文事实、计划中的大纲／伏笔和作品级约定。指定目标章时，后续章节的正文不得作为已发生的情节注入该章。

#### Scenario: Draft before an already written reveal
- **WHEN** 回到较早章节写作且较晚章节已经保存了揭晓段落
- **THEN** 早章的正文请求不能收到来自后章的已发生事件证据；大纲和伏笔仍以计划而非已发生事实呈现
