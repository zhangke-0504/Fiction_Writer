## Why

Harness 会把 Agent 回复中的 Markdown 标记原样显示。作者阅读写作建议、修改方案和核对结果时，需要自行辨认标题、列表和表格等结构。

## What Changes

- 在 Harness 会话中排版 Agent 正文，覆盖流式输出、回复完成和旧会话重开。
- 在窄栏内显示表格和代码块，并为超宽内容提供区块内横向滚动。
- 用可读文本展示链接、图片说明和原生 HTML。按消息角色应用排版，让作者输入和工具活动中的 Markdown 字符仍可逐字查看。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `background-agent-harness` 增加 Agent 会话正文的 Markdown 显示要求。

## Impact

- 涉及 Harness 的会话消息组件、样式和渲染依赖。
- 渲染直接使用当前流式文本和已有会话记录。桌面回归覆盖流式到历史的交接、旧方案换行、工具活动顺序和窄栏布局。
