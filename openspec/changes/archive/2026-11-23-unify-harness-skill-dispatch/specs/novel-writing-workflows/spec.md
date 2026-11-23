## ADDED Requirements

### Requirement: Skill-driven whole-novel generation
对绑定小说会话中明确要求完成整本小说的自然语言指令，Agent SHALL 在同一 Run 按需检索、加载 `generate-novel`，根据用户的目标和现有作品决定要生成或补齐的产物，通过小说工具保存。Harness MUST NOT 固定实现「大纲 → 主体 → 伏笔 → 目录 → 正文」的阶段调度。正文 SHALL 逐章使用单章流式能力；默认复用已有资料和非空正文。整书完成状态 SHALL 以本次约定的产物及目标章节 ID 为准，核对实际落盘和引用；目录、计划、摘要或模型自称完成不足以记为已完成。

#### Scenario: Generate the Odyssey from one natural-language request
- **WHEN** 用户新建无正文和资产的《奥德赛》，在 Harness 只发送一次「将希腊神话故事奥德赛写成小说，大概写10章左右。记得生成主体，伏笔和大纲和章节正文」
- **THEN** 用户未选择任务模式；实际发生 `skill_search`、`skill_load` 及后续小说工具的调用和结果往返。工作区有非空大纲、主体、引用有效且落实到章节的伏笔、有序目录和约十章完整正文，可逐章看到预览和保存结果；以十章为目标的受控端点须提交全部十章

#### Scenario: Fill a partial novel without replacing authored chapters
- **WHEN** 整书 Skill 处理一个已经保存了部分资料和正文、还有空白章的已有目录
- **THEN** 保留可用资料、现有章节的稳定 ID 和已保存正文，只补请求范围里的缺项，并按实际保存结果计数

#### Scenario: Empty chapter files do not count as a completed novel
- **WHEN** 受控模型建立整书目录后在目标章仍未提交正文时宣称已经生成全书
- **THEN** 后台核对 Markdown 后报告未完成和实际完成章数，不将空目录或模型消息标记为整书完成

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

## MODIFIED Requirements

### Requirement: Contextual single-chapter drafting and continuation
用户 SHALL 能在同一 Harness 输入框以自然语言要求生成或续写指定章节，不需要选择任务模式。写章 Skill SHALL 提供作品基本信息、风格、全书大纲／目标章定位、此前章节正文、相关主体和伏笔作为上下文；较长项目允许用有依据的早期摘要；有省略时，模型 SHALL 能在输出正文前按章节 ID 只读补取有限的原文，并使用其版本作为提交前提。续写 SHALL 保留已有章节正文，只追加内容；普通生成 SHALL 不覆盖已有正文，重写须由本轮作者明确要求且作用于指明的目标章，不能仅由 Skill、历史或模型动作参数推断。写章 SHALL 共用后台实时预览、取消和最终 Markdown 提交流程。

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

## REMOVED Requirements

### Requirement: One-action staged whole-novel generation
**Reason**: 固定阶段和专用入口阻止 Agent 按自然语言选用能力，并让伏笔生成依赖未绑定的临时引用。
**Migration**: 使用 `Skill-driven whole-novel generation` 和 `Durable progress and explicit continuation`；既有作品和历史保留，通过新的通用入口与当前 Markdown 续写，不重放旧阶段计划。
