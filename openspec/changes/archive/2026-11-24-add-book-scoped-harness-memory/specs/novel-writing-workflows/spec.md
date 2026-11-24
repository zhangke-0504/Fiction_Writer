## MODIFIED Requirements

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
