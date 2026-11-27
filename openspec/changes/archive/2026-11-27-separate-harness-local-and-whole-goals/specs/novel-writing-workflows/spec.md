## MODIFIED Requirements

### Requirement: Skill-driven whole-novel generation

对绑定小说会话中明确要求完成整本小说的自然语言指令，Agent SHALL 在同一 Run 按需检索、加载 `generate-novel`，根据用户的目标和现有作品决定要生成或补齐的产物，通过小说工具保存。Harness MUST NOT 固定实现「大纲 → 主体 → 伏笔 → 目录 → 正文」的阶段调度。正文 SHALL 逐章使用单章流式能力；默认复用已有资料和非空正文。正常整书 Run SHALL 支持按「Fact-only correction of newly drafted chapters in the same run」的范围按需纠正其自身新稿的明确矛盾，不因生成或续接授权修改原有或复用的非空正文，也不增加强制审校阶段。整书中由 AI 新增或补空的主体和伏笔说明 SHALL 使用专用生成能力，不通过通用资料写入绕过生成校验。

作者要求创作一部由明确 N 章组成的完整故事、且没有限定章节子集时，即使未使用“整书／完整小说”等固定词语，也 SHALL 被视为完整作品意图。整书执行 SHALL 以本 Run 针对当前作品、会话和作者消息的有效 `novel.register` 或 `novel.resume` 范围登记为依据。Agent SHALL 复用既有核对，区分作者明确要求整书交付、明确指向原整书的续接与单章生成、局部增补或局部续办。仅检索或实际加载、送达 Skill、存在旧整书记录、已有章节数量或先前的局部写入，均 MUST NOT 授予整书执行权限、要求激活目标或自动恢复旧目标。本轮只做局部写作时 SHALL 保留原有局部范围、章级前提和选档，不受本章或本动作无关的整书产物约束。

已登记的整书执行 SHALL 通过现有工具核对和激活完整有序的整书目标。激活须有本轮匹配的范围登记和实际送达的整书指南；加载 Skill 或登记若干单章动作不等同于激活目标。当前整书范围已登记但尚无活动目标时，MUST NOT 以普通单章请求派发正文；工具 SHALL 返回可操作的缺目标反馈，Agent 仍可读取现稿并按已核对的范围激活目标。与活动整书目标绑定的正文子请求 SHALL 使用既有 `long-writing` 用途并受已保存供应商能力约束。不更改任何档位的策略上限。

同书同会话作者明确续写时，已有有效整书记录 SHALL 沿用原目标、章节顺序和所需资料，仅对照现稿与回执补缺；若此前未成功登记而原整书要求、章数、目标章和现稿均可核对，Agent SHALL 能通过现有工具补登记完整目标并复用已落盘正文，不伪造恢复记录，也不把剩余章节拆成新目标。缺证据或存在冲突时 SHALL 明确指出，不猜测或覆盖现稿。续写不依赖特定作者措辞。

整书完成状态 SHALL 以本次约定的产物及目标章节 ID 为准，核对实际落盘和引用：有非空大纲、带说明的主体、有说明且有效绑定埋设与回收的伏笔，以及所有目标章正文。本次约定、生成或明确供目标章使用的主体／伏笔 SHALL 按具体身份核对非空说明和相关引用，不得以存在另一份完整资产代替；与本次无关的旧占位不得阻塞。整书续接 SHALL 保留已确认的资产范围，不得为宣称完成而缩减。目录、计划、摘要或模型自称完成不足以记为已完成；缺失项 SHALL 可定位，即使执行结果是全部目标章均已保存。

#### Scenario: Generate the Odyssey from one natural-language request

- **WHEN** 用户在新建无正文和资产的小说会话，只发送「基于神话故事奥德赛来写10章内容」
- **THEN** 在同一 Run 内实际使用写作 Skill 和小说工具，不需要作者再发送继续或补充指令；保存非空大纲、带可用说明的主体、带说明且关联有效的伏笔和全部 10 章正文。实际写章请求含相关资料，不能因正常说明被误判而重复试探或耗尽往返。受控回归和使用实际供应商的程序化验收均核对磁盘产物与派发，不要求固定工具顺序或用调大往返上限替代取材修复。

#### Scenario: Fill a partial novel without replacing authored chapters

- **WHEN** 整书 Skill 处理一个已经保存了部分资料和正文、还有空白章的已有目录
- **THEN** 保留可用资料、现有章节的稳定 ID 和已保存正文，只补请求范围里的缺项，并按实际保存结果计数

#### Scenario: Empty chapter files do not count as a completed novel

- **WHEN** 受控模型建立整书目录后在目标章仍未提交正文时宣称已经生成全书
- **THEN** 后台核对 Markdown 后报告未完成和实际完成章数，不将空目录或模型消息标记为整书完成

#### Scenario: Ten saved chapters do not mask empty required subject descriptions

- **WHEN** 十章都已落盘，但本次要求的若干主体只有名称和类型，即使另有一张完整卡和有效伏笔
- **THEN** 整书核对保留真实的十章进度并列出未齐的主体说明，不能成功结项；补齐这些资料后重新核对，不重写非空章

#### Scenario: A registered whole-book request cannot draft before goal activation

- **WHEN** 本轮有效整书范围已经登记，Agent 在整书目标尚未激活时调用写章工具，即使另有该章的草稿登记
- **THEN** 返回 `novel_goal_required` 与登记或续接指引，不派发该正文请求，也不提交正文；Agent 经现有工具激活完整目标后可调用同一写章工具，实际请求使用 `long-writing` 并按供应商能力夹紧

#### Scenario: Continue a partial whole novel without repeating saved prose

- **WHEN** 作者在同作品同会话明确说「继续」或同义表达，指向上一个未完成的整书任务；一例已有有效目标记录，另一例从未登记但能核对原目标和现稿
- **THEN** 前者恢复原目标，后者补登记完整目标，两者均保留原有章节 ID、顺序、所需资料和已写章修订，只为剩余空白章派发受供应商能力约束的长写作请求；不要求再批准，不重放旧参数

#### Scenario: A separate single-chapter request keeps its own budget

- **WHEN** 作者明确只要求写指定一章；同会话有已完成的整书历史或尚存的整书续接记录，Agent 检索或实际加载并收到整书指南，但没有本轮有效整书登记
- **THEN** 按普通单章请求执行，不因历史或指南要求整书目标、不恢复或清除旧记录、不继承旧整书方向、不改用整书额度

#### Scenario: Add one chapter without redefining the whole book

- **WHEN** 已有十章实际保存，作者只要求补第十一章并更新该章大纲，整书记录中另有该章用不到的未齐资料
- **THEN** 在本轮现有局部范围内保存新章目录、正文及对应大纲，不登记或激活十一章整书目标；本章实际依赖仍须满足，已存十章和无关资料不改，不因无关整书资料报 `novel_incomplete`

#### Scenario: A denied whole-book candidate does not take over a local follow-up

- **WHEN** 作者明确承接一处局部待办，整书记录仍可供参考，Agent 在收到整书指南前后提出 `novel.resume`，该候选经既有范围核对被拒
- **THEN** 拒绝不激活整书、不影响已有或后来取得的合法局部范围；定向读稿后仍可按普通局部路由收尾，不为消除失败改用更大写入权限

#### Scenario: A concise ten-chapter request selects the whole-work goal

- **WHEN** 绑定作品中已有设定或待写章节，作者本轮只说「生成10章内容」，且没有限定只写某几章
- **THEN** 主 Agent SHALL 按十章完整作品交付理解，使用现有 Skill 和范围工具，登记 `novel.register`（`count: 10`）并核对完整有序目标，在激活前不写入大纲、章节目录、主体、伏笔或正文；不得用十个 `chapter.draft` 局部项替代整书目标。已有章节 ID 和正文按原规则保留

### Requirement: Advance a narrowed writing task one verified unit at a time

输出触限后的主 Agent 逐项处理 SHALL 使用当前 Run 通过 `BookTaskScope` 登记并仍有效的写作范围（含直接请求、明确引用同会话方案或续办待办）。整书小步须有本轮有效整书范围和仍有效的已派发整书指南；仅送达指南或存在历史目标 MUST NOT 产生整书候选，也不使已登记的普通局部候选失去资格。候选下一步 SHALL 依据有效范围中的剩余目标、最新现稿版本、真实提交回执及必要同步来确定；目录或大纲提交不替代正文证据，登记的文档 ID 不替代读稿证据。若缺少必要证据，SHALL 仅提供与该未完成目标直接相关的一个定向读取，不反复读取同一有效版本，也不猜写入参数。本轮整书范围已登记且指南已送达但目标尚未激活时，允许通过现有工具作必要的定向核查或激活完整目标；不得从半截模型响应猜测章节、生成授权或拆成多个整书目标。逐项处理 SHALL 一次只放行一个可独立核对的必要读取、登记、写入或同步动作；工具参数的估算长度 SHALL 不超过当次有效输出额度的 `1/8`（向下取整），不得裁截参数来通过。禁止多工具大批次、在单个调用中合并多个可独立完成的目标、无关重读、重复已完成的写入或绕过原有章序、版本、锚点和关联校验。需要一起提交的同章改动仍按现有工具原子边界完成。不得通过删减范围、跳过必要产物或把摘要当作正文交付来消除触限。

#### Scenario: Preserve the full goal when making a smaller whole-book step

- **WHEN** 《蝙蝠侠》式整书任务已通过本轮范围登记并收到指南，主 Agent 触限且有一个可核对的基础或待写步骤
- **THEN** 可用现有工具先核查、激活完整目标或完成单项缺失目标，随后按现稿继续；不重开整书、不重写已有章节、也不把一个小步骤成功当作整书完成

#### Scenario: Finish the next confirmed edit without replaying earlier commits

- **WHEN** 海贼王式跨章方案已被作者采纳并通过正式任务范围登记，至少一处修改实际落盘，后续主 Agent 大批次触限
- **THEN** 续接根据现稿、原确认范围和回执只处理一个未完成目标，例如一次受核验的同章插入或资产同步；首处现稿与有效回执不重做，后续仍有待处理的范围完整保留

#### Scenario: Stop when a smaller action cannot make verified progress

- **WHEN** 模型在逐项状态下仍返回多动作大批次、超出参数额度的单个动作、猜测未知目标、只声称完成、重复无变化的步骤，或下一步不能在原有工具边界下安全拆分
- **THEN** 不执行不合格批次、不继续无进展的自动请求；保留既有成果，在同一会话说明已保存和未完成的部分，只在全部适用的整书与局部交付均核对通过时报告全部完成

#### Scenario: Finish one pending asset sync or read the specific evidence needed

- **WHEN** 黄灯侠式增补已提交部分正文和大纲，后续 Run 已登记剩余资料同步；主 Agent 为此输出工具调用时明确触限
- **THEN** 有当前版本证据时，允许 Agent 通过现有工具只更新一条待同步资料；缺必要证据时，先用现有工具定向读所需文档或片段，然后依据结果逐项处理。既有正文、大纲和已满足的资料不重写；其余待办保留，只有实际提交或读回证明确实满足后才计为完成

#### Scenario: A delivered guide does not displace narrowed local work

- **WHEN** 本轮只登记了可继续的局部工作，Agent 实际收到整书指南，之后 Messages 主请求显式输出触限
- **THEN** 仍按局部现稿、回执和既有规则计算可继续的一项；不提示激活整书，不因指南替换原预算或丢掉已登记的剩余项
