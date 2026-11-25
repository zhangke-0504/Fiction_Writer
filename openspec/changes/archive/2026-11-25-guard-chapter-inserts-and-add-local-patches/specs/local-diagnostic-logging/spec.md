## ADDED Requirements

### Requirement: Trace insertion validation and local prose patch outcomes without content
默认诊断 SHALL 以现有 Run、调用、章标识和允许的版本引用关联插入候选校验结果、失败类别、是否发起了定向更正及最终实际提交。质量不合格 SHALL 与断流、上限、冲突和取消分别可识别；可区分跨标点的边界重叠与已有整句回声。实际执行的正文定点调用 SHALL 区分授权拒绝、证据不足或不可核验、锚点／范围不符、版本冲突与实际提交；通用资料工具不支持正文也 SHALL 给出可识别的安全原因。同 Run 插入回声清理 SHALL 能关联实际插入回执，区分范围或授权拒绝、版本／回执过期、没有可证实的安全删除区间、实际新提交及同步复核结果。拒绝结果无提交，成功必须有实际提交证据。仅允许记录已注册标识、原因、状态和计数等安全字段，MUST NOT 记录候选、原文锚点、被删除或替换的文本、归一化重叠串、片段内容摘要、来源摘录、提示词、工具原始参数或输出。

#### Scenario: Tell a rejected insert and a successful patch apart from persistence
- **WHEN** 使用含独特测试标记的候选和补丁参数运行一次重试后仍被拒绝的插入、一次被拒绝的局部修订和一次成功的局部修订
- **THEN** 日志能关联各自结果、一次更正尝试和最终磁盘是否写入；回执只记实际提交，诊断中没有测试文本标记或工具原始内容，修订拒绝不误记为通用网络或供应商失败

#### Scenario: Correlate a committed insert with one bounded echo cleanup
- **WHEN** 合成用例有一次因边界重叠拒绝的候选，以及另一个带真实回执、在活动 Run 成功清理并需要重核同步的片段
- **THEN** 诊断能区分候选拒绝、插入提交、清理新提交及同步状态，不把清理当作另一处插入；注入陷阱标记的重复文本或证据不进入诊断日志
