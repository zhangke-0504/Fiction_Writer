## ADDED Requirements

### Requirement: Skill dispatch and novel writing results are traceable
默认诊断 SHALL 能按同一 Run 和工具调用区分内置 Skill 检索、资源读取或加载、所选指令进入实际模型请求、小说工具执行以及磁盘结果。日志 SHALL 仅记录已注册能力标识、资源指纹、候选数、安全状态和关联标识；请求发出不表示模型遵循 Skill。单章工具内部的只读取材与正文流 SHALL 保留各自的请求、预览和提交诊断。续写 SHALL 记录目标章和跳过已有内容的原因，不依赖固定阶段或检查点事件。

#### Scenario: Trace discovery and use without confusing loaded resources with execution
- **WHEN** Agent 检索写作 Skill，候选不止一个，选择 `generate-novel` 后调用作品工具
- **THEN** 日志可串起候选与选中的标识、选中资源指纹、其实际发往模型的请求、后续工具执行与文件提交；不把其他候选记为已激活，不保存搜索词、生成指令或工具内容

#### Scenario: Trace rejected references and distinct chapter stream failures
- **WHEN** 合成场景触发不存在的伏笔目标、前两章落盘后第三章提前结束，或者第三章返回终止事件但达到输出上限
- **THEN** 日志能区分写入前的无效引用拒绝、未完成流和达到输出上限，关联发生失败的工具、请求或安全章节引用；不保存用户文档的原始 ID、异常正文、流事件或稿件片段

#### Scenario: Readback and drafting inside the chapter tool have separate evidence
- **WHEN** 写章工具先只读取材再流式生成正文，部分补读命中或没有匹配，随后提交或者取消
- **THEN** 日志能区分两类请求、补读命中/缺失、预览开始/结束及最终提交结果，不写查询关键词、引用片段或生成正文

#### Scenario: Whole-book continuation reports why existing chapters were skipped
- **WHEN** 第三章未成功保存而整书中断，用户重启后通过同一输入框明确继续
- **THEN** 日志可查核对现稿后的目标章、已保存章被跳过和目标章重新生成的结果，不把可继续状态当作已有提交

## REMOVED Requirements

### Requirement: Skill application and novel workflow stages are traceable
**Reason**: 整书与单章任务不再由专用模式及固定阶段启动。
**Migration**: 用 `Skill dispatch and novel writing results are traceable` 追踪新的 Agent 和写章工具路径；既有诊断文件保持原样。
