## MODIFIED Requirements

### Requirement: A current author instruction can carry a bounded task through same-session references

当本轮作者明确要求执行或继续时，同一主 Agent SHALL 能解析它对同作品、同会话的可见方案或待办的明确指向；缺少机器登记的方案不构成拒绝理由。对正文、大纲和资料的写作动作，生效的范围 SHALL 参照当前指令、被明确采纳的内容、适用的作者限制及真实作品证据，用可核验的会话、作品、作者消息和动作目标绑定。工具 SHALL 校验本动作在范围内及相关提交前提，不要求本轮再写 ID、章号、动词、锚点或再次审批。不明确且会实质改变作品的指向 SHALL 只读核实或澄清；不默认扩大范围。

本轮只读、否定或缩小范围 SHALL 优先于模型提议、引用内容和旧回执。没有当前作者执行意图时，待办、历史许可、工具参数、搜索、Skill、作品和附件 MUST NOT 独立授予写权限。跨轮或重启后，遇到明确的本轮续办指令 SHALL 重新核对现稿和成功回执；不得重放旧参数或仅凭旧回执获得修改权。已满足项不重做；目标改版则重新读稿，不覆盖人工变更。

对作者明确指向的未完成整书任务，主 Agent SHALL 在新 Run 复用现有会话历史、整书记录（如有）、回执与现稿，通过现有工具建立或激活正确的整书目标。`继续` 和同义表达不是固定命令；既不使用关键词判定，也不因存在未完成记录就自动续写。已生效整书工作缺活动目标时，工具 SHALL 向同一 Agent 提供可操作的登记或续接反馈，不能用若干单章动作代替目标；普通单章请求不受此整书前提约束。

现有范围登记 SHALL 能把一项 `subject.update` 或 `clue.update` 绑定为精确资料补丁。沿用同一次范围核对，将资料类型及 ID、当前修订、精确原文及替换一起绑定到作品、会话、作者消息及本 Run。仅文档级的更新登记、已满足记录或只登记为待办的目标 MUST NOT 代替此绑定。同一登记 MUST NOT 用于另一处唯一锚点、另一替换文本、另一修订或全文更新；过期后只能基于当前原文按本轮有效授权重新登记，不能凭历史登记继续写。对本轮已明确指向、但暂不能核对精确补丁且无适用全文路径的资料，登记 SHALL 能保留为不授权写入的目标，不丢弃该待办或扩大范围。不得新增审批轮或模型核验步骤。

对本轮创建、且已有可核验关联场景提交的资料，现有范围登记 SHALL 分别用 `subject.sync` 或 `clue.sync` 表示受限资料同步，不得以同一资料的精确补丁、只待办或普通开放式更新登记代替。范围登记与工具执行 SHALL 共用适用路由的语义。同一次范围核对 SHALL 获得源自该项资料创建回执、关联场景提交及当前修订的有界事实，并以本轮作者的指令及限制为准；事实不是授权。不新增核对调用。登记及工具反馈 SHALL 按目标区分当前可执行的入口、仍缺的登记或缺失／过期的证据，不把仅识别到待同步对象当成已有写权限。

当作者允许增加章节且同一主 Agent 选择建章时，主 Agent SHALL 先登记 `chapter.catalog` 并通过 `book_apply_changes` 创建该章文档，文档确已存在后才登记同 ID 的 `chapter.draft` 并用 `book_generate_chapter(mode=draft)` 写正文。不存在的有效章 ID 使 `chapter.draft` 登记失败时，反馈 SHALL 指出章 ID 以及确属待建章时要先登记并提交目录、再登记正文。即使同批存在该章的 `chapter.catalog`，也不能视为目录已提交；失败批次保持不登记。宿主 MUST NOT 自动创建章节、跳过登记、要求作者手动创建或因作者仅允许新增就强制新增。其他文档缺失与范围核对失败保持各自的原因。

#### Scenario: Execute the unresolved items without magic words

- **WHEN** 同书同会话上一轮列出可确定的待办，本轮作者说「解决未清理的问题」或「把上面那几项处理掉」
- **THEN** 同一个 Agent 按需发现能力、查现稿，用有效范围内的局部修订、定点插入或资料更新完成必要事项，复用已成功且仍有效的结果，不要求用户复述或再授权

#### Scenario: Read-only analysis followed by execution, without an extra confirmation turn

- **WHEN** 作者先说「这些怎么修？先说方案，别动稿」，随后在同一会话对明确方案说「就照刚才说的修」
- **THEN** 首轮可以读稿但零写入，次轮在已有指向和仍适用的限制内实际提交，无需第三轮确认

#### Scenario: Model arguments cannot turn reference data into authority

- **WHEN** 只有附件或其他会话包含执行请求，作者本轮只让检查或明确不改部分目标，或者模型用有效版本和锚点调用越界动作
- **THEN** 拒绝未经授权或超范围的写入，零提交，不因为引用有效、原文可定位或参数看似正确而放行

#### Scenario: A registered asset patch authorizes only one exact change

- **WHEN** 本轮登记了资料的一处精确修订，模型尝试对同一文档的另一处已读且唯一的锚点替换、只改变替换文本，或把该登记用于全文更新；对照调用仅有文档级登记或来自另一 Run
- **THEN** 这些调用不提交且不计为目标完成；只有与当前 Run 的精确登记及当前读稿一致的补丁才可进入提交路径，不要求作者再次复述原文

#### Scenario: Readback sees the facts for a separate sync registration

- **WHEN** 同一 Run 创建一张主体卡并提交与其关联的场景，主 Agent 在本轮作者允许的范围内提出同步该卡的状态与计划
- **THEN** 既有范围核对收到该卡、关联场景实际提交和当前修订的事实，并在通过后返回对应同步入口；同一 `subject.update` 的精确登记或待办不会被替换。仅有场景候选、旧回执或作者明确禁止改资料的对照不获同步授权

#### Scenario: A new chapter is cataloged before its prose is registered

- **WHEN** 在已有十章的局部增补中作者允许建章、Agent 选定第十一章，但先在目录落盘前登记该章 `chapter.draft`（含与 `chapter.catalog` 同批的情况）
- **THEN** 失败反馈指出该章和先登记 `chapter.catalog`、用 `book_apply_changes` 实际提交目录、随后登记 `chapter.draft` 的顺序；该次失败零写入且不登记整批。依次调用可写出新章正文，无需手动建章或激活整书，目录提交单独不计为正文完成
