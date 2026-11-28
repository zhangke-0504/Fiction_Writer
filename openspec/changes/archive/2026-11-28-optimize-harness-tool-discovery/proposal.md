## Why

工具描述同时包含操作指引和相邻工具的名字，现有词法检索容易把定点修改、生成、方案和只读查询混排。当前目录的合成回放已复现人物卡定点修订漏召、章节插入漏召和不可用 ID 返回替代项的问题，值得先建立可重复的基线，再确定是否采用 BM25。

## What Changes

- 在工具定义旁维护正向检索用途、动作对象和常用中文别名。用当前会话或子任务目录查找单个或多个明确 ID，并对自然语言候选排序。
- 保留 `tool_search` 的候选结果协议。匹配工具的真实 schema 在下一次模型请求中可用，并在本 Run 内复用。模型继续负责选择动作和产生调用参数。
- 让模型知道可用已知注册名直接 `skill_load`，整书提示直接引导加载 `generate-novel`。未知能力仍可通过 `skill_search` 查看候选，按需改进三项内置 Skill 的短查询别名。
- 用同一组合成查询比较现状、新元数据下的现有计分，以及同一新元数据下的分字段 BM25。只有对照显示 BM25 带来额外排序收益时才将其用于运行路径。

## Capabilities

### New Capabilities

### Modified Capabilities

- `background-agent-harness` 更新当前目录内的精确 ID 查找、候选排序与后续请求的 schema 披露，以及按已知注册名直接加载内置 Skill 的行为。

## Impact

- 涉及 `electron/agent/tool-discovery.ts`、`local-tool.ts`、会话工具定义和 `loop.ts` 的工具定义派发边界。
- 涉及 `electron/worker.ts` 的整书提示，以及 `electron/agent/skills.ts` 的加载说明与检索元数据。
- 验证使用合成检索用例、脚本 Provider 和本地协议或 IPC 夹具。沿用现有 provider 工具协议、作品范围、修订核对和写入路径。
