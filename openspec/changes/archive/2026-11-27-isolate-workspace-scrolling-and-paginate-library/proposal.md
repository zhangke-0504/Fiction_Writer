## Why

章节条目、主体和伏笔的长列表或长详情会撑高 Writer 的根页面。滚动资料时，工作区会整体移动。书库作品增多时也会出现整窗滚动。

## What Changes

- 将 Writer 布局限制在当前窗口内，由各区域处理溢出的内容。
- 为章节条目、主体列表和详情、伏笔列表和详情提供独立的原生滚动。大纲和章节正文继续使用 Markdown 编辑器的滚动区。
- 让 Harness 的消息区和会话列表在窗口内独立滚动，保留输入和发送操作的可达性。
- 将书库改为随可用高度调整每页容量的分页列表。先按现有规则搜索和排序，再分页。
- 在隐藏的 Electron 测试窗口中用 Playwright 和隔离书库验证滚轮、滑块拖动、分页及小窗口下的操作。

## Capabilities

### New Capabilities

### Modified Capabilities

- `markdown-novel-workspace` 覆盖整窗布局、工作区区域滚动和书库分页。
- `background-agent-harness` 覆盖消息、会话列表及输入区在固定窗口布局中的行为。

## Impact

变更集中在 React 渲染层的应用布局、工作区、书库、Harness 和设置页，以及 Electron 端到端测试。测试数据通过现有工作区接口写入隔离书库。
