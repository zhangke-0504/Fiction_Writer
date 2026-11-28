# 检索优化验证

## 合成查询回放

在 Windows、Node.js 24.18.0 上运行 `node --import tsx tests/spikes/harness-tool-discovery.ts`。固定查询集共 31 项，含 14 项校准查询、12 项独立改写和 5 项 ID 查询。有目标的自然语言样例分别为 12 项和 11 项。校准仅使用校准组。夹具用实际构造器组装普通目录、绑定作品的主 Agent 和绑定作品的只读子任务。子任务的 `task_report` 来自脚本 Provider 捕获的实际声明。回放只搜索工具定义，未读取书稿、执行业务动作或访问供应商。 [查询集](../../../../tests/spikes/harness-tool-discovery-corpus.ts) · [目录夹具](../../../../tests/spikes/harness-tool-discovery-fixture.ts)

- **A** 使用提交 `00349e594baef5b7aeafd0e155d800be332e0e95` 的生产检索。在改动前执行 `node --import tsx tests/spikes/harness-tool-discovery.ts --capture-baseline` 并保存每条查询的有序候选、新增 schema 数和序列化字节。重生成时可在该提交的独立工作树安装锁定依赖并复制当前回放的入口、查询集和目录夹具，省略已保存的 JSON，再运行捕获命令。 [基线输出](../../../../tests/spikes/harness-tool-discovery-baseline.json)
- **B** 使用当前生产 `tool_search`，将完整调用说明换成正向检索元数据，并解析当前目录中的完整 ID。 [生产检索](../../../../electron/agent/tool-discovery.ts)
- **C** 使用 B 的同一目录、元数据和 ID 解析。按当前目录计算文档频率，以中文词切分和相邻汉字双字补充计算分字段 BM25。字段权重为名称 3、别名 3、用途 2、顶层参数名 0.5，双字项的 IDF 乘 0.35。校准中，剔除低于自然语言首位得分 35% 的候选使新增 schema 从 54 项降至 21 项，首位命中保持 12/12。因此先固定该截断再运行留出组。 [BM25 回放](../../../../tests/spikes/harness-tool-discovery-bm25.ts)

首个相关候选的平均倒数排名纳入标注的只读前置，漏召记 0。首位和前三只计目标动作。无关候选包含有无目标查询中的未标注结果。新增 schema 字节为每条独立搜索额外披露的 `ToolSpec` 数组的 UTF-8 序列化字节，扣除外层空数组的 2 字节。

| 查询组 | 版本 | 目标首位 | 目标前三 | 首个相关 MRR | 无关候选 | 新增 schema | 新增 schema 字节 |
| ------ | ---- | -------: | -------: | -----------: | -------: | ----------: | ---------------: |
| 校准   | A    |     7/12 |    10/12 |        0.681 |       42 |          53 |           81,702 |
| 校准   | B    |    12/12 |    12/12 |        1.000 |       30 |          46 |           74,660 |
| 校准   | C    |    12/12 |    12/12 |        1.000 |        8 |          21 |           33,230 |
| 留出   | A    |     2/11 |     4/11 |        0.258 |       21 |          23 |           39,356 |
| 留出   | B    |     4/11 |     6/11 |        0.455 |       11 |          17 |           24,990 |
| 留出   | C    |     5/11 |     7/11 |        0.682 |       19 |          26 |           34,996 |
| ID     | A    |      3/4 |      4/4 |        0.875 |       11 |          14 |           26,592 |
| ID     | B    |      4/4 |      4/4 |        1.000 |        4 |          11 |           19,902 |
| ID     | C    |      4/4 |      4/4 |        1.000 |        1 |           8 |           11,492 |

4 项纯 ID 查询中，A 有 2 项与预期列表和顺序一致，B 和 C 均为 4 项。混合查询中，B 和 C 都先给出请求中的 `book_get_context`，随后给出按自然语言找到的 `book_search_text`。3 项无命中自然语言查询在三个版本中都返回空候选。

**采用 B。** B 和 C 均将校准中的原文查找、局部资料修订、段间空白、插入和起草排在首位。C 的留出收益集中在两个样例，伏笔局部修订由第 2 位升到第 1 位，普通目录找原文增加了排第 2 的 `search_text`，但 `delete_file` 仍在首位。C 在留出组多披露 9 项 schema 和 8 个无关候选，对长改写的章中插入新增候选 `book_patch_chapter`，仍未召回 `book_generate_chapter`。B 和 C 均漏掉留出组的起草、找书稿原文和按位置回读目标。当前证据支持交付正向元数据和精确 ID 解析，BM25 继续留作回放对照。 [回放入口](../../../../tests/spikes/harness-tool-discovery.ts)

## Electron 写作请求对照

本地 Messages 夹具通过实际 Harness IPC 完成十章起草，再在现有第五章插入场景并保存相关资料。捕获 A 时使用旧版工具检索及「搜索整书 Skill 后加载」脚本。交付版本使用 B 和已知名直接加载，首次返回的完整 ID 列表按查询顺序匹配。两次运行均核对实际写入、章模式与插入参数，局部 Run 中原有不匹配的写入调用均被拒并无对应提交。纯讨论步骤通过原有夹具验证，表中两行按各自写作 Run 汇总。 [写作夹具](../../../../tests/e2e/workflow.spec.ts)

| Run      | 版本 | 请求数 | `tool_search` 次数 | `skill_search` 次数 | 累计请求体字节 | 累计输入 token 估算 | 本地耗时 |
| -------- | ---- | -----: | -----------------: | ------------------: | -------------: | ------------------: | -------: |
| 整书十章 | A    |     37 |                  1 |                   1 |        972,829 |             522,098 | 2,872 ms |
| 整书十章 | 交付 |     36 |                  1 |                   0 |        873,233 |             471,599 | 2,882 ms |
| 局部插入 | A    |     25 |                  1 |                   0 |        622,700 |             325,562 | 1,463 ms |
| 局部插入 | 交付 |     25 |                  1 |                   0 |        559,549 |             294,168 | 1,470 ms |

整书和局部插入的请求体分别减少 10.2% 和 10.1%。两次本地运行的耗时接近。输入 token 为 `model.budget_dispatched` 的宿主估算，耗时包含本机 IPC、夹具和测试轮询。该对照覆盖脚本动作与实际派发，外部模型的检索选择、请求延迟和计费尚无实测数据。

复跑当前带汇总附件的用例可执行 `npm run test:e2e -- tests/e2e/workflow.spec.ts --grep "two natural-language sends" --reporter=json`，报告中的 `writing-workflow-metrics` 为合成场景汇总。

## 回归覆盖

- `npm test` 通过 356 项，覆盖精确与混合 ID、实际作品目录排序、同轮发现与下一轮披露、跨 Run 状态、宿主预算投影、Messages 参数重取及首次 Skill 送达。 [工具检索](../../../../tests/tool-discovery.test.ts) · [主循环](../../../../tests/harness.test.ts) · [整书指南](../../../../tests/novel-goal.test.ts) · [供应商协议](../../../../tests/providers.test.ts)
- `npm run test:e2e -- tests/e2e/workflow.spec.ts tests/e2e/task-delegation.spec.ts tests/e2e/scoped-output-limit.spec.ts tests/e2e/scoped-followup-cleanup.spec.ts tests/e2e/local-whole-goals.spec.ts` 通过 41 项，覆盖写作、围绕实际 schema 的父子目录隔离、局部续办与触限恢复。
- 扩展离线桌面套件执行 75 项，72 项首轮通过。两项 Harness 测试分别等待运行结束日志落盘、增加了等待 Windows 命令执行结束的用例期限，修正后单独复跑均通过。剩余的编辑器 `PageDown` 滚动失败在当前构建与干净基线 `00349e5` 都复现，两个构建的四个 renderer 产物哈希一致。 [确认编辑夹具](../../../../tests/e2e/confirmed-edits.spec.ts) · [日志夹具](../../../../tests/e2e/diagnostics.spec.ts) · [滚动失败](../../../../tests/e2e/viewport-scrolling.spec.ts#L230)
- `npm run typecheck`、所改文件的 Prettier 检查和 `openspec validate --all --strict` 均通过。
