## ADDED Requirements

### Requirement: Story materials can be generated independently

For a bound book and an authorized local writing task, the Harness SHALL allow the author to generate a subject description, a clue description, an outline, or chapter prose without first creating another category of story material. A new chapter MAY require its chapter-catalog entry to be committed before prose generation because the entry identifies the target document; it MUST NOT require a subject, clue, or populated outline. An unanchored clue MUST be representable without fabricated chapter IDs or placeholder chapters. Local generation MUST NOT require whole-book goal activation or count its output against a whole-book completion target.

#### Scenario: Generate one subject in an empty book

- **WHEN** the author asks only for a new subject description and no other story assets or prose exist
- **THEN** the subject tool generates and commits that subject with a real stable ID, without creating a clue, outline content, chapter, or whole-book goal

#### Scenario: Generate an unanchored clue in an empty book

- **WHEN** the author asks only for a new clue and the book has no chapter catalog or established assets
- **THEN** the clue tool commits a non-empty description without inventing setup/payoff chapter IDs or creating placeholder chapters, and the local task is not reported as a whole-book task

#### Scenario: Generate an outline without populated assets

- **WHEN** the author asks only for an outline and the book has no populated subject, clue, or chapter prose
- **THEN** the Agent can compose and commit the outline through the existing outline write tool without generating those other materials or activating a whole-book goal

#### Scenario: Generate chapter prose without other story materials

- **WHEN** the author asks only for prose in a new chapter and the target chapter does not yet exist
- **THEN** the existing catalog-and-draft path creates and commits only the requested chapter entry and prose; no subject, clue, populated outline, or whole-book goal is a prerequisite

### Requirement: Relevant existing material informs independent generation

For each generated target, existing material that is relevant, usable, and safe SHALL be prioritized for inclusion in the actual generation request within the existing budget. Tool-side context selection MUST distinguish source discovery from source use and from author-required evidence: a missing, blank, unrelated, or unsafe optional source MUST NOT block an otherwise authorized independent generation. A source explicitly required by the current author MUST NOT be silently omitted while claiming that the requirement was satisfied. Sources used to generate a candidate SHALL retain enough type, ID, revision, and excerpt provenance to protect the write against changes to those sources. For outline composition in the main Agent, a stable source link and a delivered excerpt identify the source revision to guard; a link alone does not require reading the whole document. Unrelated source revisions MUST NOT by themselves invalidate the write.

#### Scenario: Generate a subject using related manuscript evidence

- **WHEN** a single subject is generated and the book contains related subject, clue, outline, and chapter evidence plus unrelated distractor material
- **THEN** the actual subject-generation request includes the relevant usable evidence with source identity and revision, excludes unrelated material, and only the requested subject changes

#### Scenario: Generate a clue using existing story materials without requiring anchors

- **WHEN** a single clue is generated in a book with related subjects, outline material, and relevant prose but the author has not assigned setup or payoff chapters
- **THEN** the actual clue-generation request uses available relevant evidence and commits the clue without requiring fabricated or pre-existing chapter anchors

#### Scenario: Generate an outline using existing materials

- **WHEN** the author requests an outline update and related subjects, clues, and saved chapter prose exist alongside unrelated or unread assets
- **THEN** the outline-composition request can use the relevant current material, the write checks the outline and sources actually used rather than requiring unrelated assets to be read, and valid existing references are preserved

#### Scenario: Generate a chapter using relevant and stage-safe context

- **WHEN** a chapter is generated with related outline, previous prose, subject notes, an optional blank asset, and a clue whose payoff belongs to a later chapter
- **THEN** the actual prose request includes relevant available context and the clue information visible at the target stage, omits the protected payoff and blank optional asset, and does not block solely because of the optional material

#### Scenario: Preserve an explicit author constraint when its evidence is unavailable

- **WHEN** the author explicitly requires a chapter to follow a specific saved subject fact but that fact is missing, blank, changed, or cannot be safely included
- **THEN** the tool reports the affected requirement and does not claim that the requested constraint was satisfied or commit prose as if it had been

#### Scenario: Guard only source revisions actually used

- **WHEN** a source included in the generation request changes before commit, or an unrelated source changes while generation is in progress
- **THEN** the candidate based on the changed included source is not committed, while an unrelated source change alone does not create a false conflict; the target's own revision remains protected

### Requirement: Batch generation preserves per-target context and write outcomes

Existing same-kind asset batches SHALL associate relevant source material with each target rather than treating all batch evidence as interchangeable. The asset request MUST label the supporting sources by target and MUST NOT present another target's unrelated evidence as shared context. Batch size and target validity SHALL remain bounded by the existing tool contract. When multiple chapter drafts are explicitly authorized in one Run, the existing one-chapter tool SHALL be called per target; a later chapter may rely on an earlier one only after its prose is actually committed. Results SHALL reflect actual per-target commits and failures, not candidate generation alone.

#### Scenario: Generate a batch of subjects with distinct source relationships

- **WHEN** one subject batch contains two targets with different relevant existing materials and a separate unrelated distractor
- **THEN** each target is generated using its own associated context, neither target inherits the other's unrelated facts, and each receipt corresponds to its actual saved revision

#### Scenario: Generate a batch of clues when one optional source is blank

- **WHEN** one authorized clue batch has multiple targets, one has usable related sources, and another has only a blank optional discovered source
- **THEN** the usable source informs its target, the blank optional source does not block the other target, each clue retains valid IDs and references, and incomplete or failed commits are not reported as saved

#### Scenario: Generate multiple chapter drafts sequentially

- **WHEN** an authorized Run requests more than one new chapter and the first chapter is committed before the next chapter tool call
- **THEN** each call writes only its target chapter, the later request may use the newly saved earlier prose, and no uncommitted candidate is treated as established story fact

#### Scenario: Preserve whole-book behavior as a separate regression

- **WHEN** a complete-novel request uses the existing whole-book goal flow
- **THEN** the existing goal activation, saved-material checks, chapter sequence, and completion result continue to follow the whole-book requirements independently of local-generation tests

## MODIFIED Requirements

### Requirement: Contextual single-chapter drafting and continuation

用户 SHALL 能在同一 Harness 输入框以自然语言要求生成或续写指定章节，不需要选择任务模式。写章 Skill SHALL 按目标章选取当前可用且相关的作品基本信息、风格、大纲、前文、主体和伏笔作为上下文；缺少可选材料不阻止生成；较长项目允许用有依据的早期摘要；每次实际生成正文的模型请求（包括整书任务逐章生成） SHALL 取回有效且相关的本书记忆，标记正文事实和计划的差异，并使用召回原文的版本作为提交前提；有省略时，模型 SHALL 能在输出正文前按章节 ID 只读补取有限的原文，并使用其版本作为提交前提。续写 SHALL 保留已有章节正文，只追加内容；普通生成 SHALL 不覆盖已有正文，重写须由本轮作者明确要求且作用于指明的目标章，不能仅由 Skill、历史或模型动作参数推断。写章 SHALL 共用后台实时预览、取消和最终 Markdown 提交流程。

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

### Requirement: Generated foreshadowing uses canonical workspace references

管理式作品工具 SHALL 提供可查询的稳定章节、主体和已由校验器识别的情节点 ID，不要求模型从截断的大纲文本猜测。伏笔可以先保存非空说明，尚未确定的埋设／回收章 SHALL 省略字段，不为生成而伪造引用或创建占位章。已确定的新伏笔排期 SHALL 使用已存在的目标章节 ID；只有实际绑定有效章节才满足整书的伏笔交付标准；旧稿中有效的情节点关系 SHALL 继续可读取与校验。任何新增无效引用 MUST NOT 落盘；工具 SHALL 把可定位的无效引用和实际提交结果返回给当前 Agent。Agent SHALL 先重查事实再有限次修正；无法解析时报告未完成，不虚构目标、删除所需关联或绕过校验来继续写正文。

#### Scenario: Repair an invalid beat reference supplied by the model

- **WHEN** 模型尝试把 `clue/hint-troy-embers` 的埋设点指向校验器不存在的 `beat/beat-departure`，而工作区有真实的可对应章节
- **THEN** 不保存该无效伏笔；模型收到结构化的拒绝结果，能读到真实 ID，改用对应章节后重新提交，并在写受影响的正文前验证关联有效

#### Scenario: Unresolvable associations are not dropped to claim success

- **WHEN** 模型尝试保存带未找到的必要埋设或回收关系的伏笔，且有限次检索与修正仍无法定位真实目标
- **THEN** 保留已经有效提交的稿件，明确指出待修复的伏笔关系，不提交无效关联或将缺少必要关系的整书标成成功

#### Scenario: An unscheduled clue can be bound after its description is saved

- **WHEN** 本轮整书生成的伏笔尚未确定埋设或回收章节
- **THEN** 可先保存说明，整书核对仍列出该伏笔的关联缺口；明确排期后可为同一份说明补上真实章节 ID，不重建卡片或重写已保存正文

### Requirement: Required writing context is actually included in chapter requests

单章和整书 SHALL 共用一项写章内容构建能力。正文 System SHALL 规定本章场景目标、视角、连贯性、伏笔披露、语言／格式与动作限制；实际作者方向、章安排和作品资料作为独立数据。章节请求 SHALL 以当前目标章和目录顺序按需取用参与主体、已确立的章前状态和阶段可见的伏笔。工具参数中的 ID、现稿关联、命中正文及到期伏笔本身不把资料升级为必需。只有本轮作者原文明确指定所依据的材料缺失、空白或在当前阶段不可用时，才因该材料停止生成。作者要求的非空说明或可核验摘录 SHALL 包含在实际请求中；已有正文的版本与衔接约束保持不变。预算裁减 SHALL 优先裁可选资料，不能把必需资料变成仅有名称或 ID；不足时 SHALL 返回可定位的缺失、冲突或预算结果，不派发不满足前提的正文请求。

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
