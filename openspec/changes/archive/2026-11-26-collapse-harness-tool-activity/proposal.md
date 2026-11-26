## Why

多步 Harness 任务会连续产生大量工具开始和完成记录，淹没作者消息及 Agent 回复，并迫使用户长距离滚动才能查看对话。将相邻工具活动默认折叠，可在保留检查细节能力的同时缩短历史对话的视觉长度。

## What Changes

- 将连续的工具调用与结果呈现在一个可展开的活动摘要中，默认收起。
- 摘要显示工具调用数量，并在存在未完成调用时提供可见提示；展开后可查看各调用和结果状态。
- 保持用户消息、Agent 可见文字、进度、运行状态及错误在原有顺序中独立可见。
- 兼容已保存的旧会话消息。

## Capabilities

### New Capabilities

### Modified Capabilities
- `background-agent-harness`: 工具活动在对话中默认紧凑显示，并可展开检查。

## Impact

- `src/Harness.tsx` 和 `src/styles.css` 的会话活动呈现。
- Background Agent Harness 的行为规范与对应 UI 回归测试。
- 不改变模型请求或工具执行行为。
