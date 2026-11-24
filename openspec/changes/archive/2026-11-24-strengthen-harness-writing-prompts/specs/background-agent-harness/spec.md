## ADDED Requirements

### Requirement: Tool-scoped writing requests in a single Harness loop
绑定小说会话 SHALL 由同一个主 Agent 分析作者意图、选择 Skill、读取所需资料、提出本次创作安排并选择下一工具。系统 MUST NOT 根据作者措辞切换外层 System 的任务角色，不得引入专用 UI 模式、小说阶段机、生成子 Agent 或额外会话。工具前提不满足时 SHALL 把可定位结果交回同一 Agent，而不是自动调用其他生成工具；作者只讨论时不得启动生成或写入。就绪采用可复用的书内规则，不新增必须经过的固定预检或补资料阶段；现稿无变化时，反馈 SHALL 足以引导 Agent 而不重复全库读取。Agent 仍可自行重查、选择另一个合法方案或请求澄清，不得以封禁正常重查、调大循环上限或放宽写权限掩盖错误。

主体、伏笔和章节生成工具 SHALL 在校验任务范围后，按工具和动作选择内置模板，从绑定作品取得本次资料，组装独立模型请求。生成请求 SHALL 使用本轮作者要求与适用的显式续接约束；主 Agent 的安排作为另标的提议，不是授权或事实。工具请求 MUST NOT 继承完整的外层会话、外层 System 或通用工具。代码组装模板无需模型另写 System；定位证据确有需要时 SHALL 支持独立、有限的只读取材，结果仅用于该任务，不产生写入或额外 Agent 循环。

主 Agent 主动读取的资料按现有预算进入其上下文。工具 SHALL 只把有界的提交、缺项或冲突回执返回外层，不默认回传其 System、完整取材包或生成全文；主 Agent 可通过正常的作品读取工具进一步取用。取材与生成 SHALL 遵循发起 Run 的取消和作品绑定。

#### Scenario: Generate one subject without starting a book pipeline
- **WHEN** 在已有小说中仅要求为指定主体补说明，且已有足够资料
- **THEN** 主 Agent 可按需要读取和执行该主体工具；实际生成请求只有主体任务模板和此次资料，未启动伏笔、写章、取材子 Agent 或整书任务；回执不含完整说明或请求，之后仅在显式读取时取得保存内容

#### Scenario: A missing prerequisite returns control to the same Agent
- **WHEN** 一次写章工具发现本章的必需主体没有说明
- **THEN** 向当前 Agent 返回目标章和缺失主体，不自动发主体生成请求；仅在 Agent 根据作者允许的范围另行调用工具后才补资料，之后任何写章调用重新核对现稿

#### Scenario: Draft uses bounded readback without consuming the outer history budget
- **WHEN** 主 Agent 的简短安排指向早期原文，而默认取材不能定位该证据
- **THEN** 写章工具能在本次 Run 内进行有界的只读取材，正文请求使用经核对的结果；没有独立 Agent，会话不自动接收选材请求和原文，普通目录会话不注册这些能力


#### Scenario: An existing note and a genuine missing note lead to different next actions
- **WHEN** 本章缺项核对遇到已存在但目前没有可核验摘录的说明，或另一条说明确实为空
- **THEN** 回执分别指出真实原因及适用的下一步，不引导对非空说明调用 fill、不诱导通用写入绕过该章前提；主 Agent 可以在同一 Run 选择取一段已保存的证据、修正引用、补真正的空卡或改合法安排，不需要切换用户模式
