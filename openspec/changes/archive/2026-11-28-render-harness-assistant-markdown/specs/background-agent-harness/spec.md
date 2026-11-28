## ADDED Requirements

### Requirement: Markdown rendering for Agent replies

Harness SHALL 将会话中流式和已保存的 Agent 正文按 Markdown 排版，支持标题、段落、强调、列表、引用、行内代码、围栏代码块和 GFM 表格。段落内原文的单换行 SHALL 显示为换行。已保存回复的排版 SHALL 以会话记录中的原文为输入，使已有会话重开时也能直接应用排版。

Harness SHALL 将原生 HTML 当作文本显示，将 Markdown 链接显示为标签和可用目标的文本，并以替代文本呈现图片。作者消息、工具活动和状态消息 SHALL 显示各自的文字，保持既有顺序和工具活动折叠行为。超宽的代码块和表格 SHALL 在各自区块内横向滚动。消息区 SHALL 继续提供独立的纵向滚动，输入区 SHALL 保持可达。

#### Scenario: Markdown renders while a reply streams

- **WHEN** Agent 的流式输出先送达一个完整标题和未闭合的粗体标记，后续分片补齐粗体语法，随后该回复被写入会话记录
- **THEN** 完整标题在流式过程中显示为标题，收到闭合标记后的流式更新显示粗体，写入记录后同一回复只显示一次且排版一致

#### Scenario: Older conversations reopen with formatted replies

- **WHEN** 作者打开保存于本变更之前的会话，里面有列表、引用或表格，有段落内使用单换行的 Agent 方案，还有包含 Markdown 字符的作者消息、工具活动和状态消息
- **THEN** Agent 回复按 Markdown 排版且方案中段落内的单换行仍可辨认，其他消息按原文显示并保持原有位置，工具活动仍可折叠和展开

#### Scenario: Reply markup and references are displayed as text

- **WHEN** Agent 回复含有原生 HTML、带标签的网页链接、作品内的相对链接和有替代文本的 Markdown 图片
- **THEN** HTML 字符、链接标签、可用的链接目标和图片替代文本均以可读文本呈现

#### Scenario: Wide reply content fits in the Harness panel

- **WHEN** 作者在最小支持窗口中阅读包含宽表格和长围栏代码行的回复
- **THEN** 表格和代码块各自提供横向滚动，消息区仍能纵向滚动并保持现有的近底部跟随行为，输入框和发送按钮可达
