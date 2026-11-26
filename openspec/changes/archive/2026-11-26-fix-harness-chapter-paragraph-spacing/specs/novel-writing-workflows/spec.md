## ADDED Requirements

### Requirement: Shorten one paragraph gap within a scoped chapter patch

已有本 Run 的有效 `chapter.patch` 登记、且存在已登记子目标时匹配其 `part`，`book_patch_chapter` SHALL 支持只收尾一处由当前作者要求或明确承接的段间空白。主 Agent SHALL 能以当前章节修订、前段末尾和后段开头的精确单行短文、目标为一个空行来表达，不必提供原分隔符或替换正文。该动作一次只处理一处，不得和普通文字修订或新稿事实勘误的来源章证据混用。需要同时提交的改动仍使用原有精确补丁批次，不得为了使用此动作而拆开。

工具 SHALL 在同一稿件修订上仅定位一对直接相邻的顶层 Markdown 正文段落。两侧锚点、整个分隔符 SHALL 属于本 Run 已实际派发给主 Agent 的同修订原文范围。展开后的短原文仍须恰好命中一次并满足既有局部补丁限制。只将定位后的、至少 3 个连续 LF 的纯分隔符缩为 2 个 LF；不得改动段落内容、其他空白、章节字段或其他文档。目标分隔符含 CR、空格或制表符时不得修改（包括 CRLF 和混合行尾）；不得做模糊匹配或全章归一化。

展开后的实际补丁 SHALL 走现有 `submit_chapter_patch_review` 裁决及共享工作区提交流程，不跳过审校、不新增审校或审批。既有授权、修订、取消、原子提交和通知规则不变。明确否决或不可用裁决 MUST NOT 提交，也不得自动重试同一候选。成功结果 SHALL 以实际提交回执及新修订为准；定位、读取或范围失败 SHALL 提供可定位原因，不泄露稿件到日志。无实际变更时不得返回已修订或作为一次提交记账；已满足项可按既有读回证据核对。

#### Scenario: Save one exact paragraph separator during a same-session follow-up

- **WHEN** 作者明确承接同会话的一处段间空白待办，主 Agent 已登记对应目标和子目标、回读同一现稿修订，工具通过锚点确定唯一位置，该处有 6 个 LF，既有审校批准实际补丁
- **THEN** 一次提交只删除该处的 4 个 LF，两侧文字、同章另一处空白、章节字段和其他文档不变；工具回执的新修订与磁盘一致，正常发出变更通知

#### Scenario: Refuse to infer a location or expand the edit

- **WHEN** 两侧短文未唯一定位同一对相邻正文段落（包括分别出现在间隔不同的两对段落），或目标实际位于嵌套块、代码块、含横向空白或 CR 的分隔中，或调用把段间动作混入普通补丁批次
- **THEN** 该调用零提交，返回对应参数、锚点或范围原因；不按空行数猜位置，不改写其他空白，也不提交批次的一部分

#### Scenario: Require the existing scope and delivered revisioned source

- **WHEN** 主 Agent 没有当前 `chapter.patch` 权限、使用不匹配的 `part`、只获得预览／有缺口的原文页，或当前章节修订已变化
- **THEN** 不把定位本身当授权或已读，不提交；按既有原因反馈，不使用旧读稿记录对新版本自动重放

#### Scenario: Preserve the existing veto, conflict and cancellation behavior

- **WHEN** 一个合格的段间补丁被现有审校明确否决或未得到可用裁决，或在审校期间作者保存了更新版、或尚未提交时 Run 取消
- **THEN** 补丁无提交，现稿不被覆盖，不追加审校重试，不把正常结束当作写入或任务完成

#### Scenario: An already-correct paragraph gap does not create a write

- **WHEN** 已定位并读回的段间分隔已经是 2 个 LF
- **THEN** 反馈该处无需改动，文件和修订不变，工具回执的提交数为 0，不计为成功修改
