## ADDED Requirements

### Requirement: Explicitly delegate read-only tasks within one Run

绑定小说与普通目录会话 SHALL 共用通用任务委派。主 Agent SHALL 能通过现有工具发现查看委派与等待能力，按需显式调用启动工具，传入有界任务说明、预期产物及可选来源引用。启动工具 SHALL 返回本 Run 的任务 ID 而不等待子模型；主 Agent 可继续执行独立工作或再启动任务。主工具执行顺序不变。后台 MUST NOT 根据作者措辞、书名、Skill、读取结果或模型触限自动委派，不要求作者另行选择委派模式或再审批。

子任务 SHALL 继承当前 Run 的作品或目录绑定与模型配置，维护独立模型上下文、工具往返和工具目录，不继承父或兄弟任务的历史、原生状态或未显式传入的附件内容。子工具目录 SHALL 只提供适用当前会话的纯查询和任务本地报告能力，不提供业务写入、记忆持久化、命令执行、范围登记、整书激活、递归委派或创建会话；子任务 MUST NOT 改动作品、工作区文件、父会话或进度。允许以有界报告返回查证、审阅、比较结果或候选文字，不视为保存。子任务 MUST NOT 获得 Messages 主 Agent 的逐项续接资格。

#### Scenario: Start independent tasks and make parent progress before waiting

- **WHEN** 主 Agent 发现委派工具，显式启动两个独立任务，且夹具保持两条子模型请求在途
- **THEN** 两个启动回执不等子模型完成，实际子模型请求有重叠，父 Agent 仍可发出下一条模型请求并执行不依赖结果的工作；没有改变普通父工具的执行顺序

#### Scenario: Keep discovery, inputs and output in the task's own context

- **WHEN** 子任务在带有父会话历史的小说或普通目录 Run 中多轮搜索并定向读取，或尝试发现父写入或委派能力
- **THEN** 子请求只含明确交付的任务输入及自己的往返，结果不泄漏到兄弟任务或父流与会话记录；只呈现当前绑定的纯查询，不能调用父写入或委派工具，普通目录不出现小说工具；父只按需取得有界报告

#### Scenario: No implicit delegation or fallback on a truncated parent response

- **WHEN** 主 Agent 未显式调用启动工具，或未登记范围时其含委派候选的回复因输出触限而截断
- **THEN** 不创建子任务、不执行截断批次，不猜写入参数；符合资格的已登记父续接仍只按既有逐项规则处理，不重放已执行调用

### Requirement: Bound delegated task resources and finish them with the parent Run

Harness SHALL 至多同时运行两个子任务，并设置每任务及本 Run 子任务合计的模型请求、读取、结果体积和耗时上限，以及本 Run 接受任务总数上限。启动容量不足或累计预算耗尽 SHALL 返回可区分结果，不排队、不启动超额工作。失败、截止和取消保持可区分；一项失败 MUST NOT 清除其他任务的结果，也不自动重试整项任务。父 Run 取消、失败或正常结束时 SHALL 停止新子工作、取消未完成子任务并等待其退出，然后才完成 Run 的收口。任务 ID、子状态和报告 MUST NOT 跨 Run 可用或在重启后自动恢复；不会产生额外活跃 Run，也不占用额外会话。

#### Scenario: Refuse capacity and stop an exhausted child without discarding another result

- **WHEN** 两个子任务在途时尝试启动第三个，且随后一项达到自己的资源上限而另一项正常提交报告
- **THEN** 第三个明确未启动；超额任务停止新增派发或读取，另一项的结果仍可独立交付。已取得完整的阶段报告可标为部分结果，没有可用报告则明确终止原因，不猜补截断数据

#### Scenario: Join children before stopping or releasing the Run

- **WHEN** 父 Run 被停止、因错误或正常结束，尚有子模型或受管理的读取在途
- **THEN** 父停止或结束前取消并等待子任务退出，受管理的停止、删除工作区或会话操作不留下子任务；下一 Run 不能查询前一 Run 的 ID，重启也不恢复它

### Requirement: Deliver bounded delegated reports on demand

等待工具 SHALL 只查询指定的本 Run 任务，有新终态时返回，不启动或重跑任务。SHALL 区分完成、部分结果、失败、任务超时和取消，及本次等待到时仍在运行的 ID；等待到时 MUST NOT 取消任务。单个未知 ID 不丢弃其他已知任务的状态、报告或终止原因。阶段报告必须来自此前完整接受的内容，不使用截断工具参数、半截文字或原生流。

报告 SHALL 有界，包含可用发现、可回读出处和未查项；未知不得写成不存在。父请求只携带实际选中的报告和状态，不继承子提示、逐轮内容、调用或原生状态。Harness SHALL 仅在向父请求传输层交付完整报告时标记该报告送达；同一请求去重，限额所致的延期只返回明确状态并保持可再次获取。后续历史可在配额内保留近期报告或退为短引用；重复等待已派发报告只返回状态，不新增正文副本。配对和必要控制状态维持现有规则；一次合法的同轮请求重发不算再次交付或执行。

#### Scenario: Poll and wait without conflating wait timeout and task timeout

- **WHEN** A、B 都在运行，一次等待先到时，之后 A 完成而 B 仍运行；对照中 B 后来达到自己的截止
- **THEN** 首次等待不结束 A 或 B；后续等待可先交付 A 而不等 B，B 的任务超时单独报告；重复等待不启动 A 或 B 也不重复注入已派发报告

#### Scenario: Redeliver a report whose earlier wait only dispatched a reference

- **WHEN** 任务已有终态报告，但父模型请求预算只允许携带状态或未派发；随后父 Agent 在同 Run 再次等待该 ID
- **THEN** 第一次不记为报告送达，仍可在下一次装得下的派发中交付；同一父请求中多个等待结果指向同一报告时只携带一份，保持每个工具调用和结果配对

## MODIFIED Requirements

### Requirement: Bounded durable tool execution receipts

实际执行的主工具及其既有写作子请求工具 SHALL 写入有限的回执，包含调用身份、结果和可确认的提交证据。回执 MUST NOT 把未执行调用变成成功操作，也不得存模型原生思考、供应商密钥、附件内容和原始工具输出。主 Agent 的委派与等待调用只记调用结果，不是子任务完成或业务提交的证据；委派任务内部的查询和报告往返 MUST NOT 写入父会话历史或持久回执，不随重启重建。

#### Scenario: Inspect successes and failures after restarting

- **WHEN** 工具写入成功、部分成功或执行失败后打开同一 Session
- **THEN** 历史文件中的确认状态、实际落盘的文档身份及版本能区分已写和未写操作，且没有自动重放

#### Scenario: A successful start receipt does not prove completion or persistence

- **WHEN** 主 Agent 启动一个稍后失败的子任务并等待，之后重开 Session
- **THEN** 只保留主调用的有限回执且没有业务提交；子任务说明、报告和往返未存入父会话，打开历史不重建或执行任务

### Requirement: Tool-scoped writing requests in a single Harness loop

绑定小说会话 SHALL 由同一个主 Agent 分析作者意图、选择 Skill、读取所需资料、提出本次创作安排并选择下一工具。系统 MUST NOT 根据作者措辞切换外层 System 的任务角色，不得引入专用 UI 模式、小说阶段机、可调用写作工具的生成子 Agent 或额外会话。主 Agent 显式调用的本 Run 只读委派不改变上述职责。工具前提不满足时 SHALL 把可定位结果交回同一 Agent，而不是自动调用其他生成工具；作者只讨论时不得调用用于写入的生成工具或写入作品。就绪采用可复用的书内规则，不新增必须经过的固定预检或补资料阶段；现稿无变化时，反馈 SHALL 足以引导 Agent 而不重复全库读取。Agent 仍可自行重查、选择另一个合法方案或请求澄清，不得以封禁正常重查、调大循环上限或放宽写权限掩盖错误。

主体、伏笔和章节生成工具 SHALL 在校验任务范围后，按工具和动作选择内置模板，从绑定作品取得本次资料，组装独立模型请求。生成请求 SHALL 使用本轮作者要求和有效的逐动作范围，包括适用的续接约束及经核对的同会话指代；主 Agent 的安排作为另标的提议，不独立授予权限或替代事实。工具请求 MUST NOT 继承完整的外层会话、外层 System 或通用工具。代码组装模板无需模型另写 System；定位证据确有需要时 SHALL 支持独立、有限的只读取材，结果仅用于该任务，不产生写入或额外 Agent 循环。

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

#### Scenario: An existing note and a genuine missing note lead to different next actions

- **WHEN** 本章缺项核对遇到已存在但目前没有可核验摘录的说明，或另一条说明确实为空
- **THEN** 回执分别指出真实原因及适用的下一步，不引导对非空说明调用 fill、不诱导通用写入绕过该章前提；主 Agent 可以在同一 Run 选择取一段已保存的证据、修正引用、补真正的空卡或改合法安排，不需要切换用户模式
