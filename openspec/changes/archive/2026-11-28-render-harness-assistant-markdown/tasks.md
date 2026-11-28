## 1. 渲染 Harness 的 Agent 正文

- [x] 1.1 在 `package.json` 和锁文件中加入 `react-markdown`、`remark-gfm` 和 `remark-breaks`。在 `ChatMessage` 的 Agent 正文分支接入按正文字符串记忆化的渲染组件，供累计流式文本和已保存文本共用。按规格处理单换行、原生 HTML、链接和图片。
- [x] 1.2 在 `src/styles.css` 中限定角色标签和纯文本样式的作用范围，给 Agent 正文设置标题、段落、列表、引用、代码和表格样式。为宽表格和代码块提供区块内滚动，并沿用消息区的纵向滚动及近底部跟随。

## 2. 桌面回归与验证

- [x] 2.1 用受测试控制的本地流式响应分段发送包含标题和粗体的回复。在第一段、收到闭合标记后和回复保存后分别检查语义元素、重复消息和保存的原文。
- [x] 2.2 用旧会话记录验证 Markdown、中文方案单换行、HTML 与引用的文本呈现。更新 `harness-tool-activity.spec.ts` 中依赖直接子 `<p>` 的顺序断言，检查作者消息、工具内容、状态、错误及工具折叠，并运行 `confirmed-edits.spec.ts` 验证现有修改方案承接。
- [x] 2.3 使用 `viewport-scrolling.spec.ts` 的最小窗口和滚动断言，覆盖宽表格与长代码行的区块内横向滚动、消息区的纵向滚动与跟随，以及输入框和发送按钮的可达性。
- [x] 2.4 运行 `npm run typecheck`、`npm test`、涉及 Markdown 展示和会话兼容性的桌面回归及 `openspec validate --all --strict`，并用 Prettier 检查改动文件。
