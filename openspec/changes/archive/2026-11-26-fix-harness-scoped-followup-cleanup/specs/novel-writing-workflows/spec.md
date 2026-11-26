## MODIFIED Requirements

### Requirement: Apply explicitly scoped local edits to chapter prose

绑定小说的 Harness SHALL 支持当前作者明确要求的正文定点修订。同一主 Agent SHALL 能从当前作品定向取得目标章的当前修订及短原文，调用专用局部正文工具一次修改一章的少量片段。目标章和改动范围 SHALL 从本轮作者指令确定，可以由其对同作品、同会话已有方案或待办的明确指代确定。模型参数、计划、工具结果和历史均不能独立授予写权限。仅讨论、禁止改稿、只要求续写或插入、仅确认不含修订的增补或普通目录会话时 MUST NOT 以此执行修订。通用资料工具仍不得覆盖正文，整章重写仍须明确的本轮重写授权。

工具 SHALL 以本 Run 读取过的目标修订为前提，在同一现稿上校验每个非空旧文恰好命中一次，片段互不交叠且合计不超出局部修改范围；增补本身不授予改动旧稿的权限；对旧稿定点修订须另有本轮有效的修订范围，已提交插入片段的回声清理仅适用独立的同 Run 规则。所有项通过后才通过共享工作区路径一次提交，重新核对目标及实际所用来源的版本和取消状态。缺失、歧义、超范围、无修改、冲突或取消不得写入这一批任何片段；不得以多次拆分拟装整章替换。目标片段外正文、章节元数据、其他章和相关资料保持不变。结果 SHALL 给出可定位的拒绝原因，或实际提交身份与新版本，不回传整章正文或将无写入记为成功修改。

同一 Run 中，Agent 重新读取更新后的现稿版本后，工具 SHALL 允许继续提交符合局部范围的修订，MUST NOT 仅因同章已有成功补丁而拒绝，也不要求作者再次确认。对于搬移等相互依赖的局部改动，在可用一个合格批次表示时 SHALL 支持将删除与补入一起保存；确需分步时，须分别核对各子目标，不得将只提交其一计为整个搬移完成。

对于本轮经 `BookTaskScope` 登记且使用既有语义审校的正文补丁，审校 SHALL 仅核对登记范围和实际候选，不得另行授予写权限。请求正常完成且未取消时，只有恰好一个 `submit_chapter_patch_review` 工具调用、参数符合既有 schema 且 `allowed: true` 才能进入提交检查；附带可见文字 MUST NOT 单独推翻合法裁决，也不构成授权、稿件内容或发给主 Agent 的解释。合法 `allowed: false` SHALL 拒绝；缺少裁决、额外工具调用、非法裁决、超时、中断或取消 MUST NOT 提交。拒绝后只能收窄到可独立核对的已登记项，MUST NOT 自动重试同一候选或拆开必须一起提交的动作。确定性精确比对、同 Run 新稿事实勘误及插入回声清理的规则不变。

#### Scenario: Correct only the author's specified passage in an existing chapter

- **WHEN** 作者明确要求定点改第十章的一句话，主 Agent 定向读取当前版并给出唯一匹配的短原文与替换文本
- **THEN** 不用整章重写或再次确认，只提交第十章指定片段；章节字段、其他正文和相关大纲与资料不变，回执能核对新版本并触发正常变更通知

#### Scenario: Reject an invalid batch or concurrent change without a partial patch

- **WHEN** 一批修订中有一个旧文多义、找不到、范围交叠或越界，或者作者在读稿与提交之间保存了更新版
- **THEN** 整批零提交并返回对应的范围、锚点或版本原因；既不基于更新版自动重放，也不覆盖人工稿件

#### Scenario: Relocate a passage in one validated local batch

- **WHEN** 作者要求把同章对话从旧位置移到新位置，Agent 基于同一修订提交删除旧段和在新锚点补入对话两项编辑
- **THEN** 两项都通过校验才一起生效；若任一处锚点无效或版本冲突，整批不写，不能单独保存删除

#### Scenario: Continue a local edit in the same chapter after rereading

- **WHEN** 同一 Run 已保存第七章一处局部修改，Agent 读到当前新版本后又提交有效的后续局部修订
- **THEN** 后续补丁照常核对当前版本、唯一锚点和局部范围并保存；重发旧版本或失效锚点仍返回实际问题，不会因「本章已改过」拦下合法修改

#### Scenario: An insert-only or read-only request cannot become a patch

- **WHEN** 作者只确认在指定锚点加一段，或只要求检查第十章的问题，模型仍通过普通定点工具提出替换已存章节中的一句
- **THEN** 拒绝未授权修订；具备有效锚点和范围的原增补能力仍可用，未授权的局部或整章覆盖均不发生

#### Scenario: An approved scoped patch can carry ancillary text

- **WHEN** 主 Agent 提交已登记范围内的当前修订补丁，既有审校正常返回唯一合法的 `allowed: true`，回复同时带有非空可见文字
- **THEN** 继续原有提交检查，合格补丁原子提交并给出实际新修订；附带文字不进入稿件、工具返回或诊断正文

#### Scenario: Prose cannot rescue a denied or unusable verdict

- **WHEN** 已登记的补丁审校明确否决，或返回零个、多个、错误工具／参数的裁决，或请求未正常完成；对照候选为无文字的明确否决
- **THEN** 无论可见文字写了什么，整批零提交；关联诊断可区分否决、无效裁决和未完成，必须一起提交的改动不得部分写入

## ADDED Requirements

### Requirement: Apply a registered exact edit to a story asset description

在绑定作品的普通 scoped 写作中，主 Agent SHALL 能按需发现 `book_patch_asset`，只对已有主体或伏笔的一处短说明文本执行确定性替换。调用只指定资料类型、稳定 ID、当前修订、精确短原文和替换文本，MUST NOT 接收全文、元数据修改或多文档批次。执行 SHALL 匹配本 Run 对同一目标和精确变更的范围登记。用于更新的事实 SHALL 基于可核对的现稿，不以历史计划或关键词代替证据；工具不得把短替换交给整份说明生成或另加模型审校。

原文锚点 SHALL 非空、符合单片段边界、在当前说明正文恰好命中一次，且命中的完整区间已在本 Run 按同一修订实际派发给主 Agent。无需读完整张卡；搜索预览、引用、未送达的页或旧修订 MUST NOT 充当原文。变更 SHALL 保留片段外正文、名称、ID、关系字段、已有引用和其他文件；不改、清空或整份替换说明不属于该动作。写入共享工作区路径时 SHALL 核对预期修订和取消，返回实际提交的目标和新修订而非原文或候选。版本变化、未读、锚点失败、未授权或取消时不提交；版本变化 SHALL 定向重读，MUST NOT 自动重放。

`book_apply_changes` 在普通 scoped 写作中 MUST NOT 接受主体或伏笔更新；对于有效参数走错入口的调用，反馈 SHALL 区分不支持的工具路由和格式错误，并提示定点与开放式更新的适用入口。开放式说明更新 SHALL 沿用有相应授权的 `book_generate_assets(update)`、当前读稿前提及原有全文候选审校。无法确定精确变更时不得改用更大的写权限；沿用有效的全文路径或保留待办。

#### Scenario: Replace a verified current sentence without regenerating the card

- **WHEN** 本轮作者指向同一会话尚未完成的一处资料更正，主 Agent 只读到当前修订的一页原文就能核对该处并登记精确替换
- **THEN** 主体或伏笔定点更新只改这一处；名称、ID、关系字段、原有引用、其他说明段落和文件不变，不发起全文生成或额外审校，成功回执与磁盘新修订一致

#### Scenario: Reject a preview, an invalid anchor or a changed revision

- **WHEN** 唯一短原文只出现在搜索预览或未实际派发的页段中，或另一次调用的原文不命中、重复命中、超出局部边界、无实际变化，或登记后资料被另存了新修订
- **THEN** 区分读稿不足、锚点／范围错误和版本冲突，原资料及其他文档不变；当前修订需定向回读，过期参数不得重放

#### Scenario: Route a scoped asset edit away from the generic tool

- **WHEN** 已登记资料目标且参数合规，主 Agent 试图用 `book_apply_changes` 更新主体或伏笔；另一场景有用原有生成工具更新说明的授权
- **THEN** 通用调用的整批不提交，并提示如何按范围使用定点或生成路径；原有生成工具仍执行其既有候选审校，未取得合格裁决时不提交
