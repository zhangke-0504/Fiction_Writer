## MODIFIED Requirements

### Requirement: Skill-driven whole-novel generation
对绑定小说会话中明确要求完成整本小说的自然语言指令，Agent SHALL 在同一 Run 按需检索、加载 `generate-novel`，根据用户的目标和现有作品决定要生成或补齐的产物，通过小说工具保存。Harness MUST NOT 固定实现「大纲 → 主体 → 伏笔 → 目录 → 正文」的阶段调度。正文 SHALL 逐章使用单章流式能力；默认复用已有资料和非空正文。正常整书 Run SHALL 支持按「Fact-only correction of newly drafted chapters in the same run」的范围按需纠正其自身新稿的明确矛盾，不因生成或续接授权修改原有或复用的非空正文，也不增加强制审校阶段。整书中由 AI 新增或补空的主体和伏笔说明 SHALL 使用专用生成能力，不通过通用资料写入绕过生成校验。

整书完成状态 SHALL 以本次约定的产物及目标章节 ID 为准，核对实际落盘和引用：有非空大纲、带说明的主体、有说明且有效绑定埋设与回收的伏笔，以及所有目标章正文。本次约定、生成或明确供目标章使用的主体／伏笔 SHALL 按具体身份核对非空说明和相关引用，不得以存在另一份完整资产代替；与本次无关的旧占位不得阻塞。整书续接 SHALL 保留已确认的资产范围，不得为宣称完成而缩减。目录、计划、摘要或模型自称完成不足以记为已完成；缺失项 SHALL 可定位，即使执行结果是全部目标章均已保存。

#### Scenario: Generate the Odyssey from one natural-language request
- **WHEN** 用户在新建无正文和资产的小说会话，只发送「基于神话故事奥德赛来写10章内容」
- **THEN** 在同一 Run 内实际使用写作 Skill 和小说工具，不需要作者再发送继续或补充指令；保存非空大纲、带可用说明的主体、带说明且关联有效的伏笔和全部 10 章正文。实际写章请求含相关资料，不能因正常说明被误判而重复试探或耗尽往返。受控回归和使用实际供应商的人工验收均核对磁盘产物与派发，不要求固定工具顺序或用调大往返上限替代取材修复。

#### Scenario: Fill a partial novel without replacing authored chapters
- **WHEN** 整书 Skill 处理一个已经保存了部分资料和正文、还有空白章的已有目录
- **THEN** 保留可用资料、现有章节的稳定 ID 和已保存正文，只补请求范围里的缺项，并按实际保存结果计数

#### Scenario: Empty chapter files do not count as a completed novel
- **WHEN** 受控模型建立整书目录后在目标章仍未提交正文时宣称已经生成全书
- **THEN** 后台核对 Markdown 后报告未完成和实际完成章数，不将空目录或模型消息标记为整书完成

#### Scenario: Ten saved chapters do not mask empty required subject descriptions
- **WHEN** 十章都已落盘，但本次要求的若干主体只有名称和类型，即使另有一张完整卡和有效伏笔
- **THEN** 整书核对保留真实的十章进度并列出未齐的主体说明，不能成功结项；补齐这些资料后重新核对，不重写非空章

## ADDED Requirements

### Requirement: Validate generated insertions before committing prose
任何局部正文 `insert` SHALL 在接收完整候选后、提交前校验候选。系统只自动剥离可以确定为紧邻旧段回声的首尾完整段落；对限定范围内复制邻段的句段、候选内部的明显连续重复，以及明确混入正文的工作说明或稿外章次回指，SHALL 给出可定位的质量问题。边界比对 SHALL 识别候选开头或结尾与紧邻旧正文的明显连续前后缀重叠，包括旧段开头被复述、短完整句连同下一句的一部分被复述且标点将其合并进新句；不能仅依赖相等的完整句、完整段落或调低全局长度门槛。单凭短词、寻常重复或在剧情内部引用章节编号 MUST NOT 删改正文。校验只作用于候选，锚点外原文与范围外文档 MUST NOT 因此改变。

工具 SHALL 对被拒候选最多定向更正生成一次，并在更正前重新核验取消、锚点和目标及来源版本；更正候选须通过同一完整性和质量检查。输出触限、中止或有版本冲突时 MUST NOT 走质量重试。同一 Run 不得用原样重发突破预算；一个失败位置不得阻止另一个仍合法的位置。最终拒绝 SHALL 返回给同一个主 Agent，且本处正文、随附大纲与同步进度均不写入；其他已经提交的工作保留。

#### Scenario: One successful insertion request would otherwise duplicate an old sentence
- **WHEN** 增补模型把相邻旧段的一长句抄入候选内部，或在同一候选内连续写了两遍同一完整句段，而不是重复提交同一个锚点
- **THEN** 首个候选未写入；版本不变且修正通过时，只提交一次新段和随附大纲，旧正文两侧与其他章节保持不变；匹配判断不因 CRLF 或轻微标点、空白差异而漏掉此类复制

#### Scenario: A short sentence and the next partial sentence echo the adjacent paragraph
- **WHEN** 候选复述上一个正文段开头的一句短句和下一句前半段，并把旧文的句号换成逗号后接全新的动作；重复文本持续出现在唯一一次修正后的候选中
- **THEN** 两次候选均在提交前因边界回声被拒绝；该处正文和随附大纲版本不变，不生成有效插入回执或同步进度，其他合法位置仍可继续

#### Scenario: Work notes or persistent echo never advance the outline
- **WHEN** 首个候选含稿外回指（如「把第五章那笔……」）或重复，更正后仍含质量问题、只剩回声，或更正期间作者保存了新版本
- **THEN** 没有脏候选写入、没有本处大纲或同步进度变更，未保存预览被清除；工具分别报告质量或版本原因，不再重生成、不回落到整章重写，其他已提交位置保留

#### Scenario: Natural overlap and diegetic references survive
- **WHEN** 合格候选有短对白反复、共享少量词汇、角色在翻阅书内文件时提到「第五章」，可另外带可确定的首尾邻段回声
- **THEN** 去掉确定的首尾回声后仅保存新增内容，合格词句保留，无须再次调用模型，原有正文没有全局清理或换行重排

### Requirement: Apply explicitly scoped local edits to chapter prose
绑定小说的 Harness SHALL 支持当前作者明确要求的正文定点修订。同一主 Agent SHALL 能从当前作品定向取得目标章的当前修订及短原文，调用专用局部正文工具一次修改一章的少量片段。目标章和改动范围 SHALL 从本轮作者指令确定；模型的参数、计划、工具结果和历史均不是作者授权。仅讨论、禁止改稿、只要求续写或插入、仅有增补确认或普通目录会话时 MUST NOT 以此执行修订。通用资料工具仍不得覆盖正文，整章重写仍须明确的本轮重写授权。

工具 SHALL 以本 Run 读取过的目标修订为前提，在同一现稿上校验每个非空旧文恰好命中一次，片段互不交叠且合计不超出局部修改范围；本需求不授予增补 Run 改动旧稿的权限，已提交插入片段的回声清理仅适用独立的同 Run 规则。所有项通过后才通过共享工作区路径一次提交，重新核对目标及实际所用来源的版本和取消状态。缺失、歧义、超范围、无修改、冲突或取消不得写入这一批任何片段；不得以多次拆分拟装整章替换。目标片段外正文、章节元数据、其他章和相关资料保持不变。结果 SHALL 给出可定位的拒绝原因，或实际提交身份与新版本，不回传整章正文或将无写入记为成功修改。

#### Scenario: Correct only the author's specified passage in an existing chapter
- **WHEN** 作者明确要求定点改第十章的一句话，主 Agent 定向读取当前版并给出唯一匹配的短原文与替换文本
- **THEN** 不用整章重写或再次确认，只提交第十章指定片段；章节字段、其他正文和相关大纲与资料不变，回执能核对新版本并触发正常变更通知

#### Scenario: Reject an invalid batch or concurrent change without a partial patch
- **WHEN** 一批修订中有一个旧文多义、找不到、范围交叠或越界，或者作者在读稿与提交之间保存了更新版
- **THEN** 整批零提交并返回对应的范围、锚点或版本原因；既不基于更新版自动重放，也不覆盖人工稿件

#### Scenario: An insert-only or read-only request cannot become a patch
- **WHEN** 作者只确认在指定锚点加一段，或只要求检查第十章的问题，模型仍通过普通定点工具提出替换已存章节中的一句
- **THEN** 拒绝未授权修订；具备有效锚点和范围的原增补能力仍可用，未授权的局部或整章覆盖均不发生

### Requirement: Clean a proven echo only inside a same-run committed insertion
提交前候选验收仍是主路径。发现已落盘的相邻旧文回声时，绑定小说的 Harness SHALL 允许在同一活动 Run 的有效增补范围内，按实际成功的插入回执清理本 Run 写入的新增片段，无须另取普通定点修订授权。后端 SHALL 核验作品、会话、Run、活动位置、实际提交、新增片段范围和摘要、当前章修订及作者限制；有随附大纲时还须该次大纲提交成功。旧 Run、跨会话、重启、失效版本、作者禁止及已消费的回执 MUST NOT 授权隐式清理。仅讨论、无效或无实际提交回执不得写入。普通 `book_patch_chapter` 和整章重写授权不变。

后端 SHALL 独立验证相邻旧正文确实构成回声，确定新增片段首尾唯一、安全的原文删除范围，只删该范围内的连续重复文本及属于它的分隔标点或空白。必须保留非空新增内容和剩余内容的原样字节；MUST NOT 允许调用者提供任意范围或替换正文，也不得改原稿、其他插入片段、章节字段、大纲和其他资料。无法证明边界安全、范围不符、版本冲突、取消或重放时 SHALL 不写，结果将可定位原因交还同一主 Agent。

写入 SHALL 复用共享版本校验和写入通知，以真实新修订记录清理和片段索引，不重复计算插入进度。关联资料使用该片段时 SHALL 核对同步证据是否仍能在保留内容中定位：不受影响且版本可核验的证据可更新其核验依据；需要重新同步的受影响项目须保留为待同步，仍按既有授权执行；无权维持同步一致性则拒写。不将旧回执算作新版本的同步成功。可见结果 SHALL 区分原增补提交、实际清理提交、清理失败和待同步，不把总进度数字当作已清理证明。

#### Scenario: The same run can remove only the duplicate opening of a committed passage
- **WHEN** 一个已实际落盘的插入片段开头复述了邻段的短句及下一分句，且该片段在本 Run 的活动增补范围内，当前章修订与有效插入回执相同
- **THEN** 清理可在同一 Run 删除新增片段中的回声并保留新动作开头，不要求用户重写或授权普通补丁；旧段及范围外的正文、章节字段、大纲、其他资料不动，回执与实盘版本一致，重放不产生新写入

#### Scenario: A protected or stale insertion cannot be cleaned with insertion authority
- **WHEN** 清理拟触及锚点旧文，安全删除边界不唯一，回执来自另一 Run、正文随后改版、插入仅部分提交，或作者明确禁止修订
- **THEN** 后端按对应原因拒绝且零提交，不猜偏移、不回落为普通补丁或整章重写，保留已保存内容

#### Scenario: Never carry affected synchronization forward on a stale passage revision
- **WHEN** 某已同步资料引用被清理片段，或同章其他有效插入的记录因删除发生位移
- **THEN** 仅在版本和来源可核对时更新片段定位及不受影响的证据；受影响且仍获授权的资料保持待同步，重新核验后才计入完成；无权维持一致性时不写清理，不能假称已同步

### Requirement: Fact-only correction of newly drafted chapters in the same run
正常整书 Run 在汇报前 SHALL 可按需使用正文定点工具对本 Run 的新稿做事实勘误，不要求作者重新授权整章重写。后端 SHALL 核验：章在登记目标中、Run 开始时无正文、确由该 Run 从空白首次写入且有实际提交回执、当前修订仍等于该次提交、作者未禁止修订。复用的已有稿、另一个 Run 保存的稿、被人工或外部修改的稿 MUST NOT 获得该隐式权限。重启、跨会话或续跑只能在各自有效范围内重新判定，输出触限恢复不得扩大权限。

每项自修 SHALL 用本 Run 实际读取并核实的早先已保存章节证据，校验对应同一事件的明确矛盾及替代文本无新增无据剧情；提交时再次保护证据版本。证据缺失、含糊、不一致、过期或无法核验 MUST NOT 自动改。系统不强制对每章进行额外审校，不把补写结局或新情节当勘误。主 Agent SHALL 以实际回执区分「章已保存」「勘误已提交」与「问题待定」，并保持既有整书完成度统计与目标范围。

#### Scenario: Fix a late draft's conflicting reference without rewriting the book
- **WHEN** 本 Run 从空白写成第十章并发现该章把第八章已有明确场景中的液体伤害写成玻璃划伤，同一章还缺少不可从现稿核实的脱身经过
- **THEN** 在证据与修订均有效时只纠正第十章的伤因片段，其他九章、证据源与第十章其他内容保持不变；脱身经过仍待定，不因已保存十章而声称完成了这一项修订

#### Scenario: Do not claim authority from a resumed or modified draft
- **WHEN** 整书 Run 复用了已有第十章、同会话的后续 Run 只续写缺项，或作者已修改本 Run 保存过的第十章，模型给出有效或看似有效的勘误证据
- **THEN** 没有当前作者的独立定点授权就不写原稿，返回授权或版本原因；证据不扩大权限，目录和原有已保存进度不变
