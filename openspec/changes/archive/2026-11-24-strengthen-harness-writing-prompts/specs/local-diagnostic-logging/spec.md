## ADDED Requirements

### Requirement: Delivered writing context is distinguishable from selected sources
写作工具 SHALL 用受限诊断区分构造请求、缺失或预算阻塞、资料裁减与实际派发，使用现有 Run／模型请求关联。派发记录 SHALL 来自最终送交传输层的资料而不是预筛选结果，标记任务类别、内置模板标识或指纹，以及实际纳入和裁减的必需／可选分组计数及有界的脱敏引用；不把派发当成模型已阅读或遵循。有限的阻塞元数据 SHALL 区分阶段（候选生成／写章取材／输入预算等）和结果（无文件、空说明、结构不符、确有披露限制无法取用、引用／衔接问题或预算），与目标及有界的脱敏来源或计数关联；有效的已存说明不得只因过滤或投影而被记作空说明。未派发 MUST NOT 产生该请求带资料的证据。原始 System、作者要求、提示词、文档和摘录内容、原始工具输入输出及未经脱敏的标识 MUST NOT 写入诊断。

#### Scenario: Context diagnostics match the final writing request
- **WHEN** 写章请求保留了必需人物说明而裁掉一条次要证据，然后实际派发；另一次请求因缺少必要说明被阻塞
- **THEN** 可以按 `runId` 与 `spanId` 核对前一请求实际包含的资料组和裁减结果，后一次只有阻塞诊断、没有派发记录；诊断不含植入作品与提示词的敏感测试标记


#### Scenario: A blocked request distinguishes a private excerpt from an empty asset
- **WHEN** 一次选材无法使用非空说明中唯一受保护的事实，而另一次缺的确是空说明，并且两次均未发正文请求
- **THEN** 可在同一 Run 或不同 Run 分辨阶段、实际原因以及受影响资料类别；都没有正文派发记录，日志不包含被保护命题或用来判断它的稿件原文。正常共用词不触发缺资料诊断
