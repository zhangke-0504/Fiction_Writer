## Why

主体、伏笔、大纲和章节正文目前虽有各自写入入口，但独立生成仍可能被无关资料的读取／修订前提或自动发现的空引用阻塞；批量资产生成也需要验证每个目标确实获得合适的现有材料，而不是只共享一包上下文。需要明确现有 MCP tools 与 Skills 的协作契约，并用真实 Harness 调用路径覆盖独立、批量和已有材料联动，避免整书用例代替局部能力验收。

## What Changes

- 允许主体、未编排伏笔、大纲和单章正文分别独立生成；除目标自身写入前提外，不要求先生成其他产物。
- 为现有生成 MCP tools 建立按目标挑选相关来源的规则；单项与批量生成都验证实际模型请求收到了相关、可用且披露安全的材料。
- 将可选的自动发现／工具选材线索与作者明确要求的必要证据区分；缺少可选材料时继续生成，缺少真正必需证据时仍不得声称满足。
- 对齐相关写作 Skills，使其按本轮交付选择现有工具、复用材料并逐项核实已保存结果；不增加 MCP 端点或整书阶段调度。
- 增加空书独立生成、已有主体／伏笔／大纲／正文的单项及批量联动、保密与版本冲突回归；保留整书回归作为独立的非回退检查。

本变更仅调整现有 MCP tools 及其执行路径、相关 Skills、规格与测试；不修改 Renderer、顶层 `worker.ts` Agent 指引、书籍记忆或整书意图路由。`book_generate_chapter` 仍逐章调用；多章批量验收覆盖同一 Run 中逐章提交和后续章复用已保存前文。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `novel-writing-workflows`: 明确四类产物可独立生成、相关材料的按需联动、单项／批量语义及安全边界。

## Impact

- MCP 工具及上下文实现：`electron/agent/novel-tools.ts`、`electron/agent/story-assets.ts`、`electron/agent/chapter-context.ts`；必要时调整这些工具调用的既有写入保护实现。
- Skills：`skills/generate-novel/SKILL.md`、`skills/write-chapter/SKILL.md`，以及确有必要时 `skills/story-consistency/SKILL.md`。
- 规格与回归：`openspec/specs/novel-writing-workflows/spec.md`、`tests/story-assets.test.ts`、`tests/chapter-context-request.test.ts`、相关工具测试和 Harness IPC E2E。
- 不新增端点、依赖或 UI；不将局部目标改为整书目标，也不重定义顶层 Agent 的自然语言路由。
