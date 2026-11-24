## Why

小说逐章增长后，最近消息和前几章摘录无法让新会话可靠地续接同一本书。Harness 现在在书库也可打开，且用书名标记会话，不利于管理同书的多个任务。

## What Changes

- Harness 只从小说编辑页打开，按已绑定作品列出会话；会话用第一条已落盘的作者消息命名。切换页面不取消任务。既有普通目录会话数据保留。
- 每部小说有独立的可追溯长期记忆文件；用已保存的 Markdown 喂给跨会话召回，支持记下作者明确指定的作品级约定。Agent 与写章都可按需从本书取材。
- 在实际发请求前按预算压缩会话，保留完整的近期工具往返、作者指令和继续任务所需的状态。私有摘要和工具执行回执追加到 Session 历史文件，不覆盖原消息，不跨会话复制原聊天或重放工具。
- 供应商配置保持应用级，补跨作品及应用重启的回归；不新增沙箱、审批、HITL、向量库或定时 Dreaming。

## Capabilities

### New Capabilities

- `book-scoped-memory`: 作品级持久记忆、同书跨会话召回、来源失效和写章时间边界。

### Modified Capabilities

- `background-agent-harness`: 小说页限定入口、按书读取会话、首条输入命名、应用级配置复用、会话压缩和工具回执。
- `novel-writing-workflows`: 将有效且相关的作品记忆接到每次真正输出章节的请求。

## Impact

改动 renderer 的路由和 Session 面板，后台 RunManager、Agent 请求投影、小说工具与 Markdown 工作区的记忆 sidecar。旧作品无需迁移，可按现稿生成索引；旧 Session 的原始消息不变。沿用现有三种模型协议及供应商密钥存放位置。
