## ADDED Requirements

### Requirement: Task-scoped generation of story asset descriptions
小说工具 SHALL 提供单项或有界小批的主体／伏笔说明生成，适用于明确请求的新增、补空或更新。单独请求与整书 SHALL 共用这项能力；生成工具 SHALL 为当前类别使用对应的内置 System 模板与本书的版本化资料，不同类的模板不混入此次请求。主体模板 SHALL 区分人物、物品和场景，要求能指导写作的身份／动机／关系、功能或约束，区分长期设定、已发生的变化和计划。伏笔模板 SHALL 分开产出可见线索与埋设动作、回收真相与方式，使其能分别取用；关联 SHALL 使用当前工作区已有的稳定 ID 并保留有效旧关系。

AI 生成的说明 SHALL 有非空 Markdown 正文，不得只含元数据或明确占位。工具 SHALL 在提交前校验候选范围、正文、类型、引用和版本。补空只改空白或明确占位的说明；更新有内容的资产 SHALL 有本轮授权，保留不受影响的资料。不符合权限或校验的候选 MUST NOT 落盘；回执 SHALL 区分实际提交与失败。手工创建占位、历史资料读取及其有效引用仍受支持。候选在提交前 SHALL 通过与章节取材共用的可用段落及阶段校验，确保生成主体的稳定设定和生成伏笔的单独可用埋设／回收段落能被写章能力识别。必要时只规范化本次尚未保存的候选结构；已有非空说明的可见读视图修复 MUST NOT 改写源文件或扩大授权。

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
在已完成的作品内，若作者明确要求新增角色及伏笔并指定其在剧情中登场，小说工具 SHALL 支持同一自然语言请求内的关联增补。主 Agent SHALL 用真实的既有主体和当前章节顺序选择合法位置；新角色说明用稳定 ID 关联作者要求数量的不同既有主体，伏笔绑定新角色及相关既有主体和有效章节锚点，大纲对应目标章／情节点记录该安排。正文生成 SHALL 使用相互一致的这些资料，并让角色实际登场、呈现伏笔可见线索；不能以只写资料或计划为完成。尚未在正文回收的伏笔 SHALL 仍属计划，不能报为已回收。

对于已存在正文的目标章，系统 SHALL 支持受限的新增片段动作：先核验作者本轮允许正文增补、明确的单章 ID、当前修订和可唯一定位的原文锚点，利用前后衔接生成只需插入的内容。自动提交 MUST NOT 修改原文锚点两侧的既有字节、外溢到其他章节或取得整章替换权。仅要求资料、禁止正文改动、讨论请求或锚点过期不允许写入；明确冲突或依赖缺失 SHALL 可定位地返还同一个主 Agent。

#### Scenario: A completed Odyssey gets a related antagonist who appears in the middle
- **WHEN** 完成上一条十章整书任务后，作者在同一作品发送「增加一个跟2个以上已有主体有关联的反派及他的伏笔，在故事中期登场」
- **THEN** 同轮保存一个反派说明及与至少两个不同旧主体的稳定关系、相关伏笔和对应大纲更新；实际在十章目录的中段（受控验收第 4–7 章）增补登场及埋设段落。原有十章 ID、顺序、非目标正文及目标锚点两侧未改，不借新增请求重写后续章节或把预定回收说成已发生

#### Scenario: An old chapter is not overwritten when only notes or an invalid anchor are supplied
- **WHEN** 本轮只允许补说明，或准备插入时锚点不唯一、已有版本变化或与后续明确冲突
- **THEN** 不派发或不提交不可安全执行的段落，不回落到整章覆盖；主 Agent 仍能读现稿、修正授权范围内的安排或报告冲突

## MODIFIED Requirements

### Requirement: Skill-driven whole-novel generation
对绑定小说会话中明确要求完成整本小说的自然语言指令，Agent SHALL 在同一 Run 按需检索、加载 `generate-novel`，根据用户的目标和现有作品决定要生成或补齐的产物，通过小说工具保存。Harness MUST NOT 固定实现「大纲 → 主体 → 伏笔 → 目录 → 正文」的阶段调度。正文 SHALL 逐章使用单章流式能力；默认复用已有资料和非空正文。整书中由 AI 新增或补空的主体和伏笔说明 SHALL 使用专用生成能力，不通过通用资料写入绕过生成校验。

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
