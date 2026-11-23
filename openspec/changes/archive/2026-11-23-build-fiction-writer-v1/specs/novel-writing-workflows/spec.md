## ADDED Requirements

### Requirement: Story consistency skill and project tools
小说工作区 SHALL 提供可读取大纲、主体、伏笔和正文的上下文工具、可应用受校验变更的小说工具，以及指导剧情一致性的内置 Skill。Agent 增删改主体或伏笔时 SHALL 检查大纲和相关资产；增删改大纲时 SHALL 反向检查主体和伏笔。确定需要的联动变更 SHALL 通过共享写入路径应用并报告；无影响的内容 SHALL 保留，系统不能把格式正确等同于剧情一致。普通目录会话不依赖这组工具和规则。

#### Scenario: A subject fact changes across related story assets
- **WHEN** 用户要求 Agent 把留给主角钥匙的人从父亲改为母亲，夹具大纲和回收伏笔也明确使用原事实
- **THEN** Skill 读取大纲和相关主体、伏笔，Agent 对受影响的事实应用对应变更，明确引用仍有效，未相关的章节不被重写

#### Scenario: An outline change affects a related subject or foreshadowing
- **WHEN** 用户要求删掉大纲中某个情节点的安排，并且该安排关联人物与一条伏笔
- **THEN** Skill 反向读取人物与伏笔，Agent 检查并报告所需调整，经同一工具路径保存确定的修改或报告待确认的不一致，不靠匹配名字删除无关资产

### Requirement: Contextual single-chapter drafting and continuation
用户 SHALL 能对一章启动生成或续写。写章 Skill SHALL 提供作品基本信息、风格、全书大纲／目标章定位、此前章节正文、相关主体和伏笔作为上下文；较长项目允许用有依据的早期摘要；有省略时，模型 SHALL 能在输出正文前按章节 ID 只读补取有限的原文，并使用其版本作为提交前提。续写 SHALL 保留已有章节正文，只追加内容；普通生成 SHALL 不覆盖已有正文，重写须由本轮明确请求。写章 SHALL 共用后台实时预览、取消和最终 Markdown 提交流程。

#### Scenario: Continue using previous text and an unresolved clue
- **WHEN** 用户续写含有已有正文的章节，前章交代引线且关联伏笔尚未回收
- **THEN** 生成请求能看到原章正文、前章上下文、相关主体与伏笔，增量预览保留原文，提交后只有追加内容改变该章

#### Scenario: Cancel a draft without partial prose
- **WHEN** 用户在新章或续写的预览完成前取消
- **THEN** 不将生成到一半的文本写入正文，已保存的旧稿保持原样

#### Scenario: Retrieve an omitted passage before streaming a chapter
- **WHEN** 前章摘录省略了写作所需的事实，模型按章节 ID 和关键词或范围请求补读
- **THEN** 正文生成使用真实原文片段，不把取材阶段的文字当作正文预览；如果补读的来源已变化，不提交基于旧来源写成的正文

### Requirement: One-action staged whole-novel generation
Harness SHALL 提供可单次发起的整书生成任务，由后台依次确定全书大纲、主体、伏笔、章节目录并逐章写正文。每个阶段 SHALL 验证预期 Markdown 是否实际提交而非仅由模型声称完成；伏笔阶段建立的情节点占位引用在开始写正文前 SHALL 绑定到章节或报告无法绑定。逐章正文 SHALL 复用单章写作能力。默认复用可用的既有资料，不覆盖作者已经保存的正文。

#### Scenario: Generate a fresh novel with two chapters
- **WHEN** 用户对有基本信息且无资产的作品发起整书生成，测试模型产生两个可验证的章节和一个有埋设、回收的伏笔
- **THEN** 任务按阶段落盘大纲、主体、伏笔、目录和两章 Markdown，写正文前落实伏笔对应的章节，过程中逐章可见预览

#### Scenario: Do not replace an existing chapter during whole-novel generation
- **WHEN** 整书任务处理一章有手写正文和一章正文为空的已有目录
- **THEN** 已写章节及其稳定 ID 保留，系统写作空白章并记录已完成项，不重建手写章节

### Requirement: Durable progress and explicit continuation
整书生成 SHALL 持久化阶段与产物状态，用户可看到当前阶段、失败点和已完成项。失败、取消或应用退出 SHALL 保留已落盘的产物；需用户明确继续，并在核对作品当前状态后从首个未完成的有效步骤继续，不自动覆盖或重复建章以填补中断。续跑未填写新指令时 SHALL 沿用检查点里的创作指令；参考文件只用于当次请求，不随检查点复制。

#### Scenario: Resume after a failure and application restart
- **WHEN** 第一章已提交，第二章生成失败，用户重启应用后明确选择继续
- **THEN** 任务能定位失败步骤并核对现有产物，续跑第二章，不重复生成第一章或重建已存在的目录

#### Scenario: Continue with the original direction after a blank restart
- **WHEN** 作者起初提供创作指令，整书任务中断后重启应用，并留空发起续跑
- **THEN** 下一章仍使用原指令，已经写成的章节不变；如果本轮明确填写新指令，则使用新值

#### Scenario: Prerequisite changed since the checkpoint
- **WHEN** 用户在中断后改变作为后续步骤前提的已完成产物，再请求继续
- **THEN** 系统指出哪些前提已变化，提示用户先处理，而不是根据旧检查点静默覆盖文件或错误宣称进度已完成
