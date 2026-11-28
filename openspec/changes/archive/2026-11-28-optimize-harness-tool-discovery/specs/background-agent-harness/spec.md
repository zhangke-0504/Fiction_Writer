## MODIFIED Requirements

### Requirement: Discover and activate built-in writing skills on demand

对小说会话，后台 SHALL 向通用 Agent 提供内置 Skill 检索和按注册标识加载指令的工具。`skill_search` SHALL 基于已注册 Skill 的目录元数据返回与查询相关的候选及简要用途。`skill_load` SHALL 接受已知注册名直接加载，并只提供所选 Skill 的指令。模型 SHALL 能在同一 Run 内按需检索并选择 Skill，或直接加载已知 Skill，再依据后续模型请求收到的指令使用现有工具。

整书提示 SHALL 引导主 Agent 在需要且尚未收到整书指南时直接用注册名 `generate-novel` 加载，并沿用整书范围登记和目标激活流程。整书指南是否送达 SHALL 以加载结果实际随模型请求派发为准。检索排名、Skill 内容或附件 MUST NOT 自行授予写入权限或启动任务。整书请求 MUST NOT 通过专用任务模式、固定整书阶段机、特定提示词匹配或包装该阶段机的工具执行。

#### Scenario: A task discovers and uses a built-in skill in the same run

- **WHEN** 小说会话需要一项能力，主 Agent 先用 `skill_search` 查找适用的 Skill，再选择其中一项
- **THEN** 候选仅列出相关的已注册 Skill 和简要用途。同一 Agent Run 按已选注册名加载该 Skill，后续模型请求收到指令后，主 Agent 按现有规则使用小说工具。用户不需要选模式、手工指定 Skill 或审批每一步

#### Scenario: Load a known whole-book skill by registered name

- **WHEN** 用户要求生成一整本小说，本 Run 尚未收到整书指南，主 Agent 按 `generate-novel` 调用已声明的 `skill_load`
- **THEN** 即使没有先调用 `skill_search`，也能加载所选指南。指南实际随下一次模型请求派发后计为送达，并沿用符合条件的首次整书指南预算。主 Agent 继续通过现有范围和目标激活路径推进整书工作

#### Scenario: Unsupported skill names and ordinary directories do not trigger writing skills

- **WHEN** 模型申请加载未知 Skill 或提供任意文件路径，或者请求来自普通目录会话
- **THEN** 未注册 Skill 不会被读取或执行。普通目录仍可用通用工具处理本地任务，不注入小说 Skill 或工具

### Requirement: The main agent discovers session-available tools without natural-language pre-routing

Harness SHALL 把当前用户消息、有关的同会话上下文及当前会话边界交给同一个主 Agent。后台 MUST NOT 从自然语言提示匹配专用流程、授权、工具顺序或任务专属进度。首次主模型请求 SHALL 先于任务专属进度和业务写入。显式能力选择与命令语法、候选检索和结构化参数校验可以确定性处理，普通自然语言的意图仍由同一个主 Agent 判断。

绑定作品与普通目录 SHALL 共享 `tool_search`。每次检索 SHALL 以发起该查询的会话或子任务实际可用的工具目录为准，返回有界的候选，以及各候选的稳定 ID、用途、读写性质和参数说明。对于由单个或多个完整工具 ID 组成的查询，规范化大小写、全角半角及分隔空白后，结果 SHALL 只包含该目录中能精确匹配的 ID。查询同时包含完整 ID 和自然语言时，结果 SHALL 优先列出精确匹配，再根据自然语言部分补充候选。某个 ID 未注册或在当前目录不可用时，MUST NOT 用共享词片段或其他工具替代它。

自然语言查询 SHALL 根据工具自身支持的动作、对象和常用别名排序。同一描述中仅为解释适用边界而提及的其他动作或工具，MUST NOT 成为该工具的正向检索用途。没有相关匹配时返回空候选。小说会话 SHALL 复用内置 Skill 的检索与按需加载。需要新能力时由 Agent 检索和选择。纯对话无需强制搜索，本 Run 已可用的工具无需重复发现。搜索无结果或工具失败时，选择权仍属于同一个 Agent，无关键词兜底流程。

新发现工具的真实 schema SHALL 从下一次模型请求开始声明，并可在本 Run 内复用。同一模型响应中附带的调用 SHALL 以该响应对应请求实际声明的工具为准。搜索结果、Skill、作品及附件 MUST NOT 自行授予权限，发现和执行均须符合当前目录的可用性与既有执行条件。

#### Scenario: Equivalent natural language uses the same agent path

- **WHEN** 作者用原句或同义表述要求添加有明确关联数量的反派、中期迹象和后期登场
- **THEN** 首个主模型请求前没有增补任务专属进度或业务写入。实际轨迹可见 Agent 发起能力发现并选择工具，保留相同作者约束，不因措辞固定查询词、章节区间或后续工具顺序

#### Scenario: Discovery respects session type and does not dispatch on no match

- **WHEN** 普通目录会话搜索文件或小说能力，或小说会话的查询无匹配
- **THEN** 普通目录可发现并执行原有允许的文件类能力，不获得小说工具或小说 Skill。无匹配时返回空候选，Agent 可重查或报告，无工具因这次查询被执行，无后台业务分支被启动

#### Scenario: Exact tool IDs are resolved only in the active catalog

- **WHEN** Agent 搜索单个完整工具 ID，或以空白分隔的多个完整工具 ID，其中包含规范化后能匹配的 ID、未知 ID 或当前目录不可用的 ID
- **THEN** 结果只包含当前目录中精确匹配的工具，全部不可用时为空。普通目录不会匹配绑定作品的工具，只读子任务不会匹配父 Agent 的写入或委派工具

#### Scenario: Rank tools by the requested action and object

- **WHEN** 绑定作品中的 Agent 分别检索人物卡说明的定点替换、向现有章节插入一段过渡、章节原文的只读查找
- **THEN** 各查询的适用工具分别优先于生成整份资料、改动章节旧文或写入相关的候选。检索提供可选能力，具体调用和参数仍由 Agent 选择

#### Scenario: Newly discovered schemas are available from the next model request

- **WHEN** 模型在同一响应中调用 `tool_search` 并尝试调用此前未声明、由此次搜索命中的工具
- **THEN** 新发现的工具在本响应中不执行。下一次模型请求实际声明该工具的原有完整定义，后续请求在本 Run 可重复使用它。调用仍须符合现有参数检查和执行前提
