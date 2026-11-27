## MODIFIED Requirements

### Requirement: Plan each model request within saved capability and context limits

Harness SHALL 用同一预算规则规划模型请求：输出由请求用途目标、保存的供应商最大输出、已知适用的协议或模式上限以及剩余上下文共同约束；输入按上下文窗口扣除本次输出和安全预留，并遵守已知独立输入上限。用于上下文装配的预算 MUST 与实际出站请求一致。必要输入装不下时 SHALL 走现有预算阻塞，不静默省略或发送无效额度。普通请求与显式小任务保留独立的用途预算；已有大写作预算选档在能力允许时 SHALL 使用 64 Ki tokens 的新策略目标而非 16,384 固定值。对本轮已有有效整书范围登记、且首次实际携带成功的 `generate-novel` 工具结果的主 Agent 请求，Harness SHALL 在上下文裁配前选择 `long-writing`，并确保完整指引随最终请求一起派发。本轮整书范围有效且指南已实际送达的后续主 Agent 请求 SHALL 继续使用该用途。仅查到候选、加载失败、没有本轮有效整书范围或仅有历史整书记录的请求，MUST NOT 因该 Skill 选择大预算，即使指南已按普通预算实际派发。预算选择不得提前生效 Skill 或改变写入授权、200 轮限制与有效上下文防护。无法装入必须发送的完整 Skill 结果时 SHALL 阻止派发，不发送截断的首次整书指引。

#### Scenario: Calculate input using the applicable output target

- **WHEN** 配置声明 `1,048,576` 上下文、`393,216` 最大输出且没有更小适用上限，分别规划普通请求和已有资格提档的写作请求
- **THEN** 普通请求按 `8,192` 输出、`1,039,184` 输入规划，大预算请求按 `65,536` 输出、`981,840` 输入规划（均扣除 `1,200` 预留）；出站字段采用同一规划值，而不是每轮使用 `393,216`

#### Scenario: Clamp requests and keep mandatory input intact

- **WHEN** 受控端点配置的适用最大输出比请求用途目标更小，或必要上下文与安全余量无法在适用窗口内装入
- **THEN** 前者在装配上下文前以较小的输出预算计算输入空间，出站使用实际限额；后者标记 `context_limit`，不发出请求或截掉必需资料，也不改变已落盘内容

#### Scenario: Use the whole-book budget when delivering the skill for the first time

- **WHEN** 本轮整书范围已核对登记，第 N 轮成功读取内置 `generate-novel`，且第 N+1 轮首次随主 Agent 请求派发其完整指引和匹配的调用结果
- **THEN** 第 N+1 轮已经按 `long-writing` 规划和裁配，不等第 N+2 轮；DeepSeek 配置能力允许时实发 `65,536`，更小的配置按既有上限。`skill.applied` 仍只在真实派发时记录；预算和送达均不代替目标激活

#### Scenario: Do not activate or claim delivery for an undelivered skill result

- **WHEN** 只检索候选、加载失败或指南因空间不足或取消未派发；另一场景是无整书范围登记而指南确实送达
- **THEN** 未派发的不记录 Skill 已送达，也不发送半截合格指南；无有效整书登记的实际送达保持普通预算。两者均不因此激活整书权限或进度

#### Scenario: Qualify later when the skill was delivered for reference

- **WHEN** 本轮先按普通预算实际送达整书指南，之后才取得有效整书登记
- **THEN** 从满足资格的后续主 Agent 请求选用 `long-writing`，不追溯修改首次派发记录，不为升档伪造送达或强制重载同一指南

### Requirement: Tool-scoped writing requests in a single Harness loop

绑定小说会话 SHALL 由同一个主 Agent 分析作者意图、选择 Skill、读取所需资料、提出本次创作安排并选择下一工具。系统 MUST NOT 根据作者措辞切换外层 System 的任务角色，不得引入专用 UI 模式、小说阶段机、可调用写作工具的生成子 Agent 或额外会话。主 Agent 显式调用的本 Run 只读委派不改变上述职责。工具前提不满足时 SHALL 把可定位结果交回同一 Agent，而不是自动调用其他生成工具；作者只讨论时不得调用用于写入的生成工具或写入作品。就绪采用可复用的书内规则，不新增必须经过的固定预检或补资料阶段；现稿无变化时，反馈 SHALL 足以引导 Agent 而不重复全库读取。Agent 仍可自行重查、选择另一个合法方案或请求澄清，不得以封禁正常重查、调大循环上限或放宽写权限掩盖错误。

主体、伏笔和章节生成工具 SHALL 在校验任务范围后，按工具和动作选择内置模板，从绑定作品取得本次资料，组装独立模型请求。生成请求 SHALL 使用本轮作者要求和有效的逐动作范围，包括适用的续接约束及经核对的同会话指代；主 Agent 的安排作为另标的提议，不独立授予权限或替代事实。工具请求 MUST NOT 继承完整的外层会话、外层 System 或通用工具。代码组装模板无需模型另写 System；定位证据确有需要时 SHALL 支持独立、有限的只读取材，结果仅用于该任务，不产生写入或额外 Agent 循环。

当作者要求创作一部由 N 章组成的故事且没有限定章节子集时，主 Agent SHALL 将完整 N 章作品视为交付目标，即使作者未使用“整书／完整小说”固定词；该意图 SHALL 经现有 `novel.register` 和整书目标激活路径表达。主 Agent MUST NOT 以逐章登记局部 `chapter.draft` 操作代替作者要求的完整多章交付。若作者明确只要求写指定章节、增加一章或续办局部事项，则 SHALL 继续使用局部范围。该语义 SHALL 由同一主 Agent 和既有范围核对处理，不新增自然语言预路由、Agent 回合或审批。

主 Agent 主动读取的资料按现有预算进入其上下文。工具 SHALL 只把有界的提交、缺项或冲突回执返回外层，不默认回传其 System、完整取材包或生成全文；主 Agent 可通过正常的作品读取工具进一步取用。取材与生成 SHALL 遵循发起 Run 的取消和作品绑定。

#### Scenario: Generate one subject without starting a book pipeline

- **WHEN** 在已有小说中仅要求为指定主体补说明，且已有足够资料
- **THEN** 主 Agent 可按需要读取和执行该主体工具；实际生成请求只有主体任务模板和此次资料，生成工具不启动伏笔、写章、取材子 Agent 或整书任务；回执不含完整说明或请求，之后仅在显式读取时取得保存内容

#### Scenario: A missing prerequisite returns control to the same Agent

- **WHEN** 一次写章工具发现本章的必需主体没有说明
- **THEN** 向当前 Agent 返回目标章和缺失主体，不自动发主体生成请求；仅在 Agent 根据作者允许的范围另行调用工具后才补资料，之后任何写章调用重新核对现稿

#### Scenario: Draft uses bounded readback without consuming the outer history budget

- **WHEN** 主 Agent 的简短安排指向早期原文，而默认取材不能定位该证据
- **THEN** 写章工具能在本次 Run 内进行有界的只读取材，正文请求使用经核对的结果；取材不启动独立 Agent，会话不自动接收选材请求和原文，普通目录会话不注册这些写作能力

#### Scenario: A short multi-chapter creation request preserves the whole-work intent

- **WHEN** 在绑定作品中作者本轮只说「生成10章内容」，且没有把交付限制到指定章节或局部增补
- **THEN** 同一主 Agent SHALL 检索／加载适用整书指导，并通过现有 `book_task_scope` 为完整十章作品登记 `novel.register`、随后激活完整有序目标；不得将其规划成十个局部章节任务或在整书目标前开始写作。显式「只写第十章」仍按局部路径处理

#### Scenario: An existing note and a genuine missing note lead to different next actions

- **WHEN** 本章缺项核对遇到已存在但目前没有可核验摘录的说明，或另一条说明确实为空
- **THEN** 回执分别指出真实原因及适用的下一步，不引导对非空说明调用 fill、不诱导通用写入绕过该章前提；主 Agent 可以在同一 Run 选择取一段已保存的证据、修正引用、补真正的空卡或改合法安排，不需要切换用户模式

### Requirement: Task completion is independent of the run lifecycle

对已确定的执行任务，Harness SHALL 以有效目标、实际提交回执和必要的现稿核对区分完成、已满足无需写入、部分完成和未完成；取消及中断仍可单独辨识。业务进度 SHALL 在有效范围已确定或实际工作开始后发布，以已核对结果为依据，不把计划、工具次数、未落盘候选或 Run 正常结束记为完成。恢复时 SHALL 保留已提交内容并指出仍可定位的遗留或阻碍。

对复合任务，Harness SHALL 区分可分别核对的子目标，即使它们使用同一动作并作用于同一章。只有相关子目标都已提交或经现稿核对已满足，才能将该任务标为完成。单次正文提交、章节目录或大纲更新 MUST NOT 被当作其余子目标完成的证据。

同会话收尾 SHALL 分别核对实际待办中的正文和资料，已满足或已提交且仍有效的项不重做。精确资料登记只因匹配的真实提交与当前修订一致才计为写入完成；已有当前证据可按原语义计为无需写入。不能安全写入的已知资料待办仍 SHALL 计入目标，不能因未生成候选、登记为只待办或定点写入被拒而从任务结果消失。只满足部分目标仍为 `partial`；全未满足时为 `incomplete`，均不由 Run 正常结束覆盖。

同一 Run 有已登记的整书执行和有独立交付的局部目标时，Harness SHALL 从同一当前稿件分别核对整书目标及范围内的局部动作和必要同步。有效整书登记尚未激活 SHALL 保持未完成。整书章数与局部项数 MUST NOT 相加，也不能以一类已齐证明另一类完成；即使交付涉及同一文档，也 SHALL 分别以匹配当前修订的动作回执或有效的当前证据核对。`novelGoal.check` 只报告整书进度，不代表全轮业务结果。Harness SHALL 在混合进度中分别展示两类结果和可定位的剩余项，保持原有整书阻碍、取消及中断语义。

整书已达成但局部有剩余时，Harness SHALL 独立结清整书续接状态，将本轮报告为 `partial`，并保留有界、可定位的局部剩余项。后续同作品同会话中，仅当前作者指向该待办时才可按现有范围和读稿要求继续；上一轮核对摘要是参考数据，不延续旧登记的写权限，也 MUST NOT 重放参数或重写仍有效的已保存内容。

#### Scenario: A normally finished run can leave work incomplete

- **WHEN** 主 Agent 正常结束，但所有预期写入被拒且核对发现问题仍在；或只部分成功
- **THEN** 前者显示任务未完成及实际阻碍，后者明确已处理和剩余项，均不以运行结束或虚假的满进度表示任务成功

#### Scenario: A relocation remains partial after only the source edit commits

- **WHEN** 同章搬移分步提交时，旧位置删除已保存，但新位置未补入或后续补丁未通过
- **THEN** 保留已提交的修改，标为部分完成并列出剩余子目标；不会因一次正文提交或 Run 正常结束显示 `fulfilled`。新位置也经提交或读回核实已满足后，才将该搬移计为完成

#### Scenario: Current evidence makes a second write unnecessary

- **WHEN** 续办前作者已修好目标，或此前提交仍满足该目标
- **THEN** 以当前读回或仍有效的提交证据标明已满足，不再次写入，不把无写入误记为一次提交

#### Scenario: A same-session cleanup completes only the documented remaining work

- **WHEN** 上轮增补已有真实回执和可见待办，当前作者要求收尾；本轮正文补丁与定点资料替换均获得实际提交，另有此前已满足的增补
- **THEN** 回执与当前文件证明两个续办项均已完成，不重复增补、不把其中一次提交当成另一次，按实际结果完成任务

#### Scenario: A blocked asset is still counted after a chapter commits

- **WHEN** 正文收尾实际提交，资料定点操作被拒，或资料目标已知但只能登记为待办，主 Agent 随后正常结束
- **THEN** 正文提交保留，资料没有虚假写入或满进度，仍报告资料剩余项和 `partial`，无权用全文工具清掉这一项

#### Scenario: A complete whole-book goal does not hide a blocked scoped edit

- **WHEN** 本轮已激活整书目标，并登记了两项独立局部工作。整书核对通过，局部正文已实际提交，伏笔短文目标的定点调用因现有整书路由被拒（或该目标仅登记为待办）；同一伏笔另有一次不匹配定点要求的提交
- **THEN** 保留整书已齐和局部 `1/2` 的独立记录，被拒的调用零提交，另一调用也不能抵销这项待办。正常运行结束时仍为 `partial` 且全轮进度不完整，显示待处理的伏笔，不为结项改用其他资料写入口

#### Scenario: Local success does not relax incomplete whole-book requirements

- **WHEN** 本轮独立的局部修订均已满足，活动整书目标章数虽齐但仍缺必需资料或有效关联
- **THEN** 局部仍显示已满足，整书保存的章数与阻碍如实显示，保留整书续接记录和原有未完成结果，不标为全轮完成

#### Scenario: Resume only the local work left after a mixed run

- **WHEN** 混合 Run 已结清整书目标、保存了局部正文且留有可定位的局部资料待办，即使上轮模型自报全部完成，作者下一轮只要求完成剩余局部事项
- **THEN** 可依据上轮宿主摘要、回执及本轮读回重建有效局部范围，不恢复旧整书或重做正文；只有此次匹配的资料提交或经核对的当前证据才计为完成，旧参数或已失效修订不重放
