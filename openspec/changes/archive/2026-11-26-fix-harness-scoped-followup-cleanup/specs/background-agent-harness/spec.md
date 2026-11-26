## MODIFIED Requirements

### Requirement: A current author instruction can carry a bounded task through same-session references

当本轮作者明确要求执行或继续时，同一主 Agent SHALL 能解析它对同作品、同会话的可见方案或待办的明确指向；缺少机器登记的方案不构成拒绝理由。对正文、大纲和资料的写作动作，生效的范围 SHALL 参照当前指令、被明确采纳的内容、适用的作者限制及真实作品证据，用可核验的会话、作品、作者消息和动作目标绑定。工具 SHALL 校验本动作在范围内及相关提交前提，不要求本轮再写 ID、章号、动词、锚点或再次审批。不明确且会实质改变作品的指向 SHALL 只读核实或澄清；不默认扩大范围。

本轮只读、否定或缩小范围 SHALL 优先于模型提议、引用内容和旧回执。没有当前作者执行意图时，待办、历史许可、工具参数、搜索、Skill、作品和附件 MUST NOT 独立授予写权限。跨轮或重启后，遇到明确的本轮续办指令 SHALL 重新核对现稿和成功回执；不得重放旧参数或仅凭旧回执获得修改权。已满足项不重做；目标改版则重新读稿，不覆盖人工变更。

对作者明确指向的未完成整书任务，主 Agent SHALL 在新 Run 复用现有会话历史、整书记录（如有）、回执与现稿，通过现有工具建立或激活正确的整书目标。`继续` 和同义表达不是固定命令；既不使用关键词判定，也不因存在未完成记录就自动续写。已生效整书工作缺活动目标时，工具 SHALL 向同一 Agent 提供可操作的登记或续接反馈，不能用若干单章动作代替目标；普通单章请求不受此整书前提约束。

现有范围登记 SHALL 能把一项 `subject.update` 或 `clue.update` 绑定为精确资料补丁。沿用同一次范围核对，将资料类型及 ID、当前修订、精确原文及替换一起绑定到作品、会话、作者消息及本 Run。仅文档级的更新登记、已满足记录或只登记为待办的目标 MUST NOT 代替此绑定。同一登记 MUST NOT 用于另一处唯一锚点、另一替换文本、另一修订或全文更新；过期后只能基于当前原文按本轮有效授权重新登记，不能凭历史登记继续写。对本轮已明确指向、但暂不能核对精确补丁且无适用全文路径的资料，登记 SHALL 能保留为不授权写入的目标，不丢弃该待办或扩大范围。不得新增审批轮或模型核验步骤。

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

### Requirement: Task completion is independent of the run lifecycle

对已确定的执行任务，Harness SHALL 以有效目标、实际提交回执和必要的现稿核对区分完成、已满足无需写入、部分完成和未完成；取消及中断仍可单独辨识。业务进度 SHALL 在有效范围已确定或实际工作开始后发布，以已核对结果为依据，不把计划、工具次数、未落盘候选或 Run 正常结束记为完成。恢复时 SHALL 保留已提交内容并指出仍可定位的遗留或阻碍。

对复合任务，Harness SHALL 区分可分别核对的子目标，即使它们使用同一动作并作用于同一章。只有相关子目标都已提交或经现稿核对已满足，才能将该任务标为完成。单次正文提交、章节目录或大纲更新 MUST NOT 被当作其余子目标完成的证据。

同会话收尾 SHALL 分别核对实际待办中的正文和资料，已满足或已提交且仍有效的项不重做。精确资料登记只因匹配的真实提交与当前修订一致才计为写入完成；已有当前证据可按原语义计为无需写入。不能安全写入的已知资料待办仍 SHALL 计入目标，不能因未生成候选、登记为只待办或定点写入被拒而从任务结果消失。只满足部分目标仍为 `partial`；全未满足时为 `incomplete`，均不由 Run 正常结束覆盖。

#### Scenario: A normally finished run can leave work incomplete

- **WHEN** 主 Agent 正常结束，但所有预期写入被拒且核对发现问题仍在；或只部分成功
- **THEN** 前者显示任务未完成及实际阻碍，后者明确已处理和剩余项，均不以运行结束或虚假的满进度表示任务成功

#### Scenario: A relocation remains partial after only the source edit commits

- **WHEN** 同章搬移分步提交时，旧位置删除已保存，但新位置未补入或后续补丁未通过
- **THEN** 保留已提交的修改，标为部分完成并列出剩余子目标；不会因一次正文提交或 Run 正常结束显示 `fulfilled`。新位置也经提交或读回核实已满足后，才将该搬移计为完成

#### Scenario: Current evidence makes a second write unnecessary

- **WHEN** 续办前作者已修好目标，或此前提交仍满足该目标
- **THEN** 以当前读回或仍有效的提交证据标明已满足，不再次写入，不把无写入误记为一次提交

#### Scenario: A same-session cleanup completes only the documented remaining work

- **WHEN** 上轮增补已有真实回执和可见待办，当前作者要求收尾；本轮正文补丁与定点资料替换均获得实际提交，另有此前已满足的增补
- **THEN** 回执与当前文件证明两个续办项均已完成，不重复增补、不把其中一次提交当成另一次，按实际结果完成任务

#### Scenario: A blocked asset is still counted after a chapter commits

- **WHEN** 正文收尾实际提交，资料定点操作被拒，或资料目标已知但只能登记为待办，主 Agent 随后正常结束
- **THEN** 正文提交保留，资料没有虚假写入或满进度，仍报告资料剩余项和 `partial`，无权用全文工具清掉这一项
