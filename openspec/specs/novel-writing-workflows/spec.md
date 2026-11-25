# Novel Writing Workflows Specification

## Purpose

规范小说专用工具与写作技能，包含关联资料维护、基于前文的单章写作，以及由 Skill 驱动、可明确继续的全书生成。

## Requirements

### Requirement: Story consistency skill and project tools
小说工作区 SHALL 提供可读取大纲、主体、伏笔和正文的上下文工具、可应用受校验变更的小说工具，以及指导剧情一致性的内置 Skill。Agent 增删改主体或伏笔时 SHALL 检查大纲和相关资产；增删改大纲时 SHALL 反向检查主体和伏笔。确定需要的联动变更 SHALL 通过共享写入路径应用并报告；无影响的内容 SHALL 保留，系统不能把格式正确等同于剧情一致。普通目录会话不依赖这组工具和规则。

#### Scenario: A subject fact changes across related story assets
- **WHEN** 用户要求 Agent 把留给主角钥匙的人从父亲改为母亲，夹具大纲和回收伏笔也明确使用原事实
- **THEN** Skill 读取大纲和相关主体、伏笔，Agent 对受影响的事实应用对应变更，明确引用仍有效，未相关的章节不被重写

#### Scenario: An outline change affects a related subject or foreshadowing
- **WHEN** 用户要求删掉大纲中某个情节点的安排，并且该安排关联人物与一条伏笔
- **THEN** Skill 反向读取人物与伏笔，Agent 检查并报告所需调整，经同一工具路径保存确定的修改或报告待确认的不一致，不靠匹配名字删除无关资产

### Requirement: Contextual single-chapter drafting and continuation
用户 SHALL 能在同一 Harness 输入框以自然语言要求生成或续写指定章节，不需要选择任务模式。写章 Skill SHALL 提供作品基本信息、风格、全书大纲／目标章定位、此前章节正文、相关主体和伏笔作为上下文；较长项目允许用有依据的早期摘要；每次实际生成正文的模型请求（包括整书任务逐章生成） SHALL 取回有效且相关的本书记忆，标记正文事实和计划的差异，并使用召回原文的版本作为提交前提；有省略时，模型 SHALL 能在输出正文前按章节 ID 只读补取有限的原文，并使用其版本作为提交前提。续写 SHALL 保留已有章节正文，只追加内容；普通生成 SHALL 不覆盖已有正文，重写须由本轮作者明确要求且作用于指明的目标章，不能仅由 Skill、历史或模型动作参数推断。写章 SHALL 共用后台实时预览、取消和最终 Markdown 提交流程。

#### Scenario: Continue using previous text and an unresolved clue
- **WHEN** 用户续写含有已有正文的章节，前章交代引线且关联伏笔尚未回收
- **THEN** 生成请求能看到原章正文、前章上下文、相关主体与伏笔，增量预览保留原文，提交后只有追加内容改变该章

#### Scenario: Cancel a draft without partial prose
- **WHEN** 用户在新章或续写的预览完成前取消
- **THEN** 不将生成到一半的文本写入正文，已保存的旧稿保持原样

#### Scenario: Retrieve an omitted passage before streaming a chapter
- **WHEN** 前章摘录省略了写作所需的事实，模型按章节 ID 和关键词或范围请求补读
- **THEN** 正文生成使用真实原文片段，不把取材阶段的文字当作正文预览；如果补读的来源已变化，不提交基于旧来源写成的正文

#### Scenario: A request for one chapter does not expand scope
- **WHEN** 用户在已有目录的小说里发送「只写第三章」且该章正文为空
- **THEN** 只调用写章能力补写第三章，不启用整书生成，也不创建其他资产或改写其他章节

#### Scenario: An existing chapter is replaced only on explicit current authorization
- **WHEN** 当前作者消息明确要求从头重写指定的已有章，或只要求查看该章且明确禁止重写
- **THEN** 只有明确要求重写的请求可在版本检查通过后覆盖指定章；禁止重写的请求即使模型给出重写参数，也不修改已保存正文

#### Scenario: Use cross-session evidence in the prose request
- **WHEN** 在新 Session 生成后续章节，作者要求延续超出近期上下文的早期线索
- **THEN** 独立正文请求（而非仅路由 Agent）收到已保存的相关证据和约定；若该证据写作期间变了，不将本次生成稿提交为正文

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

### Requirement: Generated foreshadowing uses canonical workspace references
管理式作品工具 SHALL 提供可查询的稳定章节、主体和已由校验器识别的情节点 ID，不要求模型从截断的大纲文本猜测。新整书伏笔的计划埋设和回收 SHALL 使用已存在的目标章节 ID，而非依赖待绑定的情节点占位；旧稿中有效的情节点关系 SHALL 继续可读取与校验。任何新增无效引用 MUST NOT 落盘；工具 SHALL 把可定位的无效引用和实际提交结果返回给当前 Agent。Agent SHALL 先重查事实再有限次修正；无法解析时报告未完成，不虚构目标、删除所需关联或绕过校验来继续写正文。

#### Scenario: Repair an invalid beat reference supplied by the model
- **WHEN** 模型尝试把 `clue/hint-troy-embers` 的埋设点指向校验器不存在的 `beat/beat-departure`，而工作区有真实的可对应章节
- **THEN** 不保存该无效伏笔；模型收到结构化的拒绝结果，能读到真实 ID，改用对应章节后重新提交，并在写受影响的正文前验证关联有效

#### Scenario: Unresolvable associations are not dropped to claim success
- **WHEN** 模型尝试保存带未找到的必要埋设或回收关系的伏笔，且有限次检索与修正仍无法定位真实目标
- **THEN** 保留已经有效提交的稿件，明确指出待修复的伏笔关系，不提交无效关联或将缺少必要关系的整书标成成功

### Requirement: Streamed chapter failures are distinguishable and non-committable
写章工具 SHALL 在收到协议认可的完整正文结果并通过取消、版本和写入校验之后才提交。Messages 缺少有效终止与完整终止但达到输出上限 SHALL 产生可区分的失败结果。中断或触限的部分预览 MUST NOT 写入正文或计入完成。暂态不完整流只有在未取消、未提交且版本前提仍成立时，才允许在同一 Run 对该章自动重试一次；达到输出上限不得用相同参数自动重试。终止失败 SHALL 指出具体章节和原因，保留其他已保存正文。

#### Scenario: Chapter three stream closes without a terminal event
- **WHEN** 在前两章已保存后，Messages 的第三章流返回部分文本但缺少正常终止事件
- **THEN** 第三章报不完整流，不提交半章；如允许重试，最多一次且从未写入状态重新生成。若再次失败，前两章字节保持不变，第三章仍未完成，后续章节不被提前生成

#### Scenario: Chapter three reaches the model output limit
- **WHEN** 第三章生成流带有终止事件，且停止原因是 `max_tokens`
- **THEN** 可见结果与诊断明确显示输出上限而非断流；不提交部分正文、不以原参数自动重试，已保存章节保持不变

### Requirement: Durable progress and explicit continuation
整书运行 SHALL 维护已约定目标、失败位置和基于实际产物的完成章数，在中断后仍足以定位未完成项。失败、取消或应用退出 SHALL 保留已落盘的产物。用户 SHALL 能在同一 Session 通过自然语言明确继续；续写 SHALL 先核对现有 Markdown，仅补缺失项，不自动执行，不重建已有目录或重复写入已完成章节。没有新创作方向时 SHALL 沿用原整书指令；有明确的新指令时以新要求为准。参考文件仅用于当次请求，不随续写信息复制。

#### Scenario: Resume after chapter three fails and the application restarts
- **WHEN** 前两章已提交，第三章未提交且任务失败，作者重启应用后在同一 Session 发送「接着写完」
- **THEN** 重启本身不写文件；新请求使用同一 Agent 和 Skill 入口，核对现稿后从第三章继续，前两章及目录的稳定 ID 与原正文保留

#### Scenario: Continue with the original direction unless changed by the author
- **WHEN** 原指令包含可验证的题材、视角或风格约束，中断后仅请求继续，或继续时给出明确的新方向
- **THEN** 仅请求继续时下一章沿用原约束，明确的变更以当前消息为准；不改写已有正文，不恢复未重新附加的参考文件内容

#### Scenario: A changed prerequisite makes the previous plan invalid
- **WHEN** 作者在中断后修改作品，导致原任务的目标章或关联前提不再有效，再请求继续
- **THEN** 依据磁盘上的最新作品指出不满足的前提，不按旧计划覆盖作者改动或错误宣称完成

### Requirement: Task-scoped generation of story asset descriptions
小说工具 SHALL 提供单项或有界小批的主体／伏笔说明生成，适用于作者直接要求或经同一会话明确确认的方案中的新增、补空或更新。单独请求与整书 SHALL 共用这项能力；生成工具 SHALL 为当前类别使用对应的内置 System 模板与本书的版本化资料，不同类的模板不混入此次请求。主体模板 SHALL 区分人物、物品和场景，要求能指导写作的身份／动机／关系、功能或约束，区分长期设定、已发生的变化和计划。伏笔模板 SHALL 分开产出可见线索与埋设动作、回收真相与方式，使其能分别取用；关联 SHALL 使用当前工作区已有的稳定 ID 并保留有效旧关系。

AI 生成的说明 SHALL 有非空 Markdown 正文，不得只含元数据或明确占位。工具 SHALL 在提交前校验候选范围、正文、类型、引用和版本。补空只改空白或明确占位的说明；更新有内容的资产 SHALL 位于本 Run 有效的作者范围，保留不受影响的资料。已确认方案内的新增 SHALL 直接使用该范围，不要求确认句再次写出资产名称、ID 或创建动作；未确认提案本身不形成执行范围。不符合权限或校验的候选 MUST NOT 落盘；回执 SHALL 区分实际提交与失败。手工创建占位、历史资料读取及其有效引用仍受支持。候选在提交前 SHALL 通过与章节取材共用的可用段落及阶段校验，确保生成主体的稳定设定和生成伏笔的单独可用埋设／回收段落能被写章能力识别。必要时只规范化本次尚未保存的候选结构；已有非空说明的可见读视图修复 MUST NOT 改写源文件或扩大授权。

#### Scenario: Repair an existing empty subject using the current manuscript
- **WHEN** 已写完的小说存在空说明，作者只要求补指定主体
- **THEN** 主体请求可读取与该主体有关的现稿依据，保存说明并保持其 ID；不把原稿未证实的设想写成已发生事实，不改动已有正文或无关资产

#### Scenario: Generated fields without a description are rejected
- **WHEN** 资产模型为授权的目标只给名称和类型、留空，或用「待补」当说明
- **THEN** 未保存该无效结果，回执指出需补的资产；取消、过期版本和无效新增引用也不得出现成功提交证据

#### Scenario: Add a reveal after the rest of the book already exists
- **WHEN** 作者要求新增一条与已有物品和已保存章节相关的伏笔
- **THEN** 伏笔生成请求带关联主体说明、真实章节锚点和相关现稿；生成可见线索与回收内容，按请求仅提交该伏笔，不擅自改写关联章节

#### Scenario: An asset result is validated for the writer before it is saved
- **WHEN** 本次候选非空但缺少书写工具能使用的稳定设定，或伏笔把真正回收结果混在唯一的埋设段落中
- **THEN** 提交前指出缺失的可用部分或在候选内明确分开；合格才可保存，不产生「生成成功但写章无法识别」的结构错误，也不要求为尚未确定的章节补逐章说明

#### Scenario: Create the assets for an approved antagonist proposal
- **WHEN** 绑定作品的会话已展示有明确关联范围的反派和伏笔方案，作者回复「嗯，就按这个来改」而未列资产名称或 ID
- **THEN** 使用同一会话确认的范围及已有主体的真实 ID 走资产模型请求，合格结果真实提交；不得仅因确认句缺少创建关键词而在派发前拒绝，也不得生成方案外资产

### Requirement: Required writing context is actually included in chapter requests
单章和整书 SHALL 共用一项写章内容构建能力。正文 System SHALL 规定本章场景目标、视角、连贯性、伏笔披露、语言／格式与动作限制；实际作者方向、章安排和作品资料作为独立数据。章节请求 SHALL 以当前目标章和目录顺序定位参与主体、已确立的章前状态和到期的伏笔，按显式引用、与本章关联的情节点及明确写作义务挑选必需资料。系统 SHALL 在实际派发前检查必需主体的非空说明或能代表本章关键设定的有效摘录，以及到期伏笔的本章可用内容已包含在请求。预算裁减 SHALL 优先裁可选资料，不能把必需资料变成仅有名称或 ID；不足时 SHALL 返回可定位的缺失、冲突或预算结果，不派发不满足前提的正文请求。

写章取材 SHALL 区分作品级设定、已保存的前文证据、本章计划和本章允许披露的内容。尚未到回收点的伏笔 SHALL 只提供适用的可见线索与写作动作，不把可辨认且受保护的具体回收事实提前注入；同一限制适用于取进的大纲、主体说明、记忆和补读。披露资格 SHALL 由来源、事实范围及目标章决定；实体名、普通引号词及共享局部文字的重叠 MUST NOT 单独将阶段允许的设定或线索标成缺失。遮蔽已识别的受保护事实时 SHALL 保留其余经核验的可用内容；旧资料不能确定边界时只用可核对的安全摘录或报告缺口，不以整段混合旧稿兜底。不得将经过埋设／回收排期当成已发生。正文请求使用的关键资料版本 SHALL 纳入提交保护。

遇到被阻塞的必需项时 SHALL 向 Agent 区分没有资产、没有说明、结构不符、已有说明但缺当前章可核验段落、引用或衔接冲突及预算不足，并给出实际受影响章／资产和适用的修复信息。不得将已存在的说明或未受影响的依赖对象列为待补空；同一修订下可用已知原文恢复就绪时不要求改写资料或扩写逐章卡片。

#### Scenario: Essential subject notes survive a tight input budget
- **WHEN** 本章明确要使用某人物和埋设某线索，同时有大量无关卡片和前文，且模型预算能放下必需块
- **THEN** 捕获到的正文请求包含该人物说明中的关键设定和线索可见内容，而不是只有名称；次要资料可裁减，另一个无关的空主体不会阻塞本章

#### Scenario: Do not dispatch when a required note cannot be included
- **WHEN** 本章必需主体说明空白、必要资料无有效出处，或最小可用资料和作者要求超出输入预算
- **THEN** 返回受影响目标及原因，不发送正文请求、不提交正文、不略过该必需资料

#### Scenario: Hide the answer from the setup chapter across context sources
- **WHEN** 第五章回收的答案也出现在伏笔全文、未来大纲或记忆计划里，当前要写第三章的埋设
- **THEN** 第三章实际正文请求收到可见线索和应做动作，但没有上述来源中的回收真相；生成第五章时可获得回收所需的真相和有效前文。未分类的混合旧稿不能作为规避披露规则的备用输入

#### Scenario: Shared terms do not remove a usable opening-chapter setting
- **WHEN** 已有主体说明、首章埋设段落和后续回收段都使用「人证」等普通引号词、相同角色名或相同的道具前提，而真正回收的身份或事件在后章
- **THEN** 有效主体说明和可见线索随首章请求派发，不报告空说明；后章受保护事实未出现在该请求。拆分同段的已标明私有事实时保留剩余有出处的设定，不因引号或共享短句丢整张卡

#### Scenario: A continuation reuses existing notes after a projection error
- **WHEN** 上次运行已有可用的主体、伏笔和目录，旧过滤规则把首章误报为资料缺失；作者发送「继续」
- **THEN** 重新从现稿解析阶段所需信息并实际发出首章生成请求，不要求用 fill 或未经授权的 update 替换非空说明，也不丢弃已登记目标和正常关联

#### Scenario: A source note changes while the draft is streamed
- **WHEN** 发送请求后，作者改动一份实际纳入的主体或伏笔资料
- **THEN** 基于旧版资料的结果不得提交，报告需重新取材；已有稿件不变

### Requirement: Writing inside existing chapters respects both continuity boundaries
对新增于已写章节之间的目标章，或对后方已有正文的旧章进行授权的续写或重写时，取材 SHALL 按当前章节顺序及稳定 ID 分别构造章前依据和后接章节必须成立的衔接条件。后接条件 SHALL 有可定位来源，并仅包含该任务所需的衔接事实；后章正文或事件不得作为早章已发生的记忆送入。已识别的衔接条件与写作安排发生明确冲突时 SHALL 返回可定位冲突，不得自行改动邻章、伏笔锚点或扩大改写范围。不可确认的必要衔接条件 SHALL 标明缺口。提交 SHALL 复核所用旧稿与本章位置是否仍然有效；授权在旧章锚点追加片段时，锚点两侧已写正文也 SHALL 作为衔接和保护边界。

#### Scenario: Insert a setup before an existing later chapter
- **WHEN** 作者在原第四章和原第五章之间插入新章，新伏笔的回收关联原第八章的稳定 ID
- **THEN** 写章请求可以使用第四章末的事实与原第五章必须保持的开场条件，不能得到后章整段正文或回收答案；排序变化不迁移回收 ID，未授权的旧章字节保持不变

#### Scenario: The next authored chapter rules out the proposed setup
- **WHEN** 已有后接章节明确要求人物从未见过某物，而提议让同一人物在插章里看到它
- **THEN** 返回冲突与来源，交给当前 Agent 和作者处理，不发送基于该矛盾安排的正文、不改写后接章节

### Requirement: Incremental mid-story entry connects assets outline and actual prose
在已完成的作品内，若作者直接要求新增角色和伏笔并指定剧情目标，或在同一会话确认这样一份已展示方案，小说工具 SHALL 支持在一次执行 Run 内关联增补。范围可以是一章的登场，也可以是多个目标处的中期迹象和后期登场。主 Agent SHALL 用真实的既有主体和当前章节顺序选择合法位置；新角色说明用稳定 ID 关联作者要求数量的不同既有主体，伏笔绑定新角色及相关既有主体和有效章节锚点，大纲对应目标章／情节点记录该安排。正文生成 SHALL 使用相互一致的这些资料，并让角色实际登场、呈现伏笔可见线索；不能以只写资料或计划为完成。尚未在正文回收的伏笔 SHALL 仍属计划，不能报为已回收。

对于每处已存在正文的目标，系统 SHALL 核验本 Run 有效范围、单次调用的目标章 ID、当前修订及唯一原文锚点，用必要的前后衔接与当前章节可披露内容生成且仅插入新增段落。每处更新对应的大纲安排，保持旧正文锚点两侧与范围外章节、资料不变，不取得整章替换权。系统 SHALL 区分不同合法插入目标与重复提交同一处，不因已插入第一处而阻挡另一个有效目标。仅要求资料、禁止正文改动、未确认的讨论或无效锚点不允许写入；冲突或缺失 SHALL 可定位地返还同一个主 Agent。

关联正文提交后，主 Agent SHALL 能在同一执行范围内同步本次新建的主体或伏笔说明。工具 SHALL 根据同书、同会话、有效范围和成功创建回执识别目标，并核验资料和关联正文的当前修订。同步限于该资料与本次已提交片段相关的剧情事实与计划。主体保留稳定设定，伏笔区分可见线索和回收内容，既有的文档 ID、关系字段、章节锚点和无关段落保持原样。作者对资料或章节的限制优先，其他资料仍须具备明确授权。

同步 SHALL 用可定位的现有正文摘录支撑每项「已发生」状态，并区分迹象、登场、埋设和实际回收。计划中被实际剧情取代的安排 SHALL 在新建资料中对齐，尚未发生的内容保留为计划。实际回收按每条伏笔的正文证据核对。成功提交后 SHALL 记录同步所覆盖的关联正文版本及资料的提交结果。

执行结果 SHALL 以实际已提交的资料、大纲、逐处正文以及必要同步的有效回执为依据。正文或同步部分失败时，保留已提交内容并指出具体缺项。可承接的续接 SHALL 先核对现稿与提交记录，复用有效结果并处理缺项。

#### Scenario: A completed Odyssey gets a related antagonist who appears in the middle
- **WHEN** 完成上一条十章整书任务后，作者在同一作品发送「增加一个跟2个以上已有主体有关联的反派及他的伏笔，在故事中期登场」
- **THEN** 同轮保存一个反派说明及与至少两个不同旧主体的稳定关系、相关伏笔和对应大纲更新；实际在十章目录的中段（受控验收第 4–7 章）增补登场及埋设段落。原有十章 ID、顺序、非目标正文及目标锚点两侧未改，不借新增请求重写后续章节或把预定回收说成已发生

#### Scenario: An old chapter is not overwritten when only notes or an invalid anchor are supplied
- **WHEN** 本轮只允许补说明，或准备插入时锚点不唯一、已有版本变化或与后续明确冲突
- **THEN** 不派发或不提交不可安全执行的段落，不回落到整章覆盖；主 Agent 仍能读现稿、修正授权范围内的安排或报告冲突

#### Scenario: A confirmed outline puts clues in the middle and the antagonist onstage later
- **WHEN** 在已经保存十章正文的海贼王设定书里，作者先要求规划与至少两个已有主体有关联的暗线反派，中期留多个迹象、后期登场，再回复「嗯，就按这个来改」
- **THEN** 执行 Run 实际新增具备有效关联的新反派和伏笔，对应大纲和多个中期章的埋设片段以及后期章的登场片段落盘；反派登场章可与伏笔计划回收章不同；未来真相不提前披露，未实际回收的仍仅为计划。原十章 ID、顺序、各处锚点两侧的旧正文和范围外内容不变

#### Scenario: A newly created antagonist note follows the actual scenes
- **WHEN** 作者直接要求新增相关反派、中期迹象和后期登场，反派和伏笔说明先按计划创建成功，后续第 5、6 章的实际埋设及第 10 章登场与计划不同
- **THEN** 同一个 Agent 在核对提交后的原文与修订后同步本次新建资料，使「已发生变化」能定位到写出的情节，「计划」与当前安排一致。分别核对两条伏笔的回收证据，尚未回收的一条继续标为计划。正文、大纲及必要同步均实际落盘后，该 Run 才显示完成

#### Scenario: A sync conflict leaves an explicit remaining item
- **WHEN** 本次正文及大纲已保存，但同步目标属于此前的作品资料、原文证据无法核验、资料或来源版本已变更，或作者缩小了范围
- **THEN** 工具拒绝越界或过期的同步并给出原因。仍属于范围的必要同步保持待处理，已提交正文、大纲和有效资料保留。对可承接的同会话确认方案，继续时按现稿与回执只处理有效缺项

#### Scenario: A later insertion conflicts after another one was saved
- **WHEN** 已成功插入一处，另一处锚点变更或不再唯一，或者主 Agent 试图重发已成功的插入
- **THEN** 不写冲突或重复段落、不用整章替换绕过检查；保留已成功落盘的部分，报告其余缺口。更新现稿中确实可用的另一处位置后仍可在有效范围内继续

### Requirement: Advance a narrowed writing task one verified unit at a time
输出触限后的主 Agent 逐项处理 SHALL 仅使用仍有效的已派发整书 Skill 或同作品同会话已确认的跨章编辑方案。候选下一步 SHALL 依据原授权、已登记目标、最新现稿、真实工具提交与缺项来确定。若整书指南已送达而目标未登记，允许通过现有工具作必要的定向核查或登记完整目标；不得从半截模型响应猜测章节、生成授权或拆成多个整书目标。逐项处理 SHALL 一次只放行一个可独立核对的必要读取、登记、写入或同步动作；工具参数的估算长度 SHALL 不超过当次有效输出额度的 `1/8`（向下取整），不得裁截参数来通过。禁止多工具大批次、无关重读、重复已完成的写入或绕过原有章序、版本、锚点和关联校验。需要一起提交的同章改动仍按现有工具原子边界完成。不得通过删减范围、跳过必要产物或把摘要当作正文交付来消除触限。

#### Scenario: Preserve the full goal when making a smaller whole-book step
- **WHEN** 《蝙蝠侠》式整书任务的主 Agent 触限且有一个可核对的基础或待写步骤
- **THEN** 可用现有工具先核查、登记完整目标或完成单项缺失目标，随后按现稿继续；不重开整书、不重写已有章节、也不把一个小步骤成功当作整书完成

#### Scenario: Finish the next confirmed edit without replaying earlier commits
- **WHEN** 海贼王式跨章方案已经确认，至少一处修改实际落盘，后续主 Agent 大批次触限
- **THEN** 续接根据现稿、原确认范围和回执只处理一个未完成目标，例如一次受核验的同章插入或资产同步；首处现稿与有效回执不重做，后续仍有待处理的范围完整保留

#### Scenario: Stop when a smaller action cannot make verified progress
- **WHEN** 模型在逐项状态下仍返回多动作大批次、超出参数额度的单个动作、猜测未知目标、只声称完成、重复无变化的步骤，或下一步不能在原有工具边界下安全拆分
- **THEN** 不执行不合格批次、不继续无进展的自动请求；保留既有成果，在同一会话说明已保存和未完成的部分，只在实际交付核对通过时报告全部完成

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
