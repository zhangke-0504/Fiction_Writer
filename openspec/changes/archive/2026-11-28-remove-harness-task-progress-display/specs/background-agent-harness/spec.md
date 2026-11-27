## MODIFIED Requirements

### Requirement: Task completion is independent of the run lifecycle

对已确定的执行任务，Harness SHALL 以有效目标、实际提交回执和必要的现稿核对区分完成、已满足无需写入、部分完成和未完成。失败、取消及中断 SHALL 可单独辨识。后台 SHALL 在有效范围已确定或实际工作开始后，依据已核对结果更新内部业务进度。计划、工具次数、未落盘候选及 Run 正常结束均 MUST NOT 计为完成。恢复时 SHALL 保留已提交内容并指出仍可定位的遗留或阻碍。

Harness SHALL 在现有运行状态中呈现可用的终态核对结果与已知的可定位待办或阻碍，并保留适用的诊断编号。Harness MUST NOT 渲染任务进度卡、进度条或其他任务进度面板。此规则覆盖全部请求，包括资料准备、单章、局部增补、整书和混合请求，适用于运行中、运行结束及旧会话重开。新生成的系统状态和错误文案 MUST NOT 展示固定的任务完成比例，包括已保存整书正文的 `X/N` 章数。已有会话 SHALL 保持可读，无需迁移或重写会话记录。

对复合任务，Harness SHALL 区分可分别核对的子目标，即使它们使用同一动作并作用于同一章。只有相关子目标都已提交或经现稿核对已满足，才能将该任务标为完成。单次正文提交、章节目录或大纲更新 MUST NOT 被当作其余子目标完成的证据。

同会话收尾 SHALL 分别核对实际待办中的正文和资料。已满足或已提交且仍有效的项 SHALL 跳过重做。精确资料登记只因匹配的真实提交与当前修订一致才计为写入完成。已有当前证据可按原语义计为无需写入。不能安全写入的已知资料待办仍 SHALL 计入目标，不能因未生成候选、登记为只待办或定点写入被拒而从任务结果消失。只满足部分目标仍为 `partial`。全未满足时为 `incomplete`。Run 正常结束 MUST NOT 覆盖两种结果。

同一 Run 有已登记的整书执行和有独立交付的局部目标时，Harness SHALL 从同一当前稿件分别核对整书目标及范围内的局部动作和必要同步。有效整书登记尚未激活 SHALL 保持未完成。整书章数与局部项数 MUST NOT 相加，也不能以一类已齐证明另一类完成。即使交付涉及同一文档，也 SHALL 分别以匹配当前修订的动作回执或有效的当前证据核对。`novelGoal.check` SHALL 仅核对整书目标。整书阻碍、取消及中断按实际结果报告。

整书已达成但局部有剩余时，Harness SHALL 独立结清整书续接状态，将本轮报告为 `partial`，并保留有界、可定位的局部剩余项。后续同作品同会话中，仅当前作者指向该待办时才可按现有范围和读稿要求继续。上一轮核对摘要是参考数据。Harness MUST NOT 延续旧登记的写权限、重放参数或重写仍有效的已保存内容。

#### Scenario: Writing tasks have no task progress display

- **WHEN** Harness 运行或收尾资料准备、单章、局部增补、整书或混合请求，且本轮已有后台核对计数
- **THEN** 作者可以查看工具活动和运行状态，运行中可停止。收尾呈现已有核对结果及可定位的待办或阻碍。任何请求都不渲染任务进度卡或替代面板，包括已激活的整书目标

#### Scenario: A failed whole-book delivery reports the blocker without a tally

- **WHEN** 整书目标未激活，或本轮整书交付因缺章、资料缺失、关联不满足或写入失败而未完成
- **THEN** 运行状态呈现可用的具体阻碍与适用诊断编号。新生成的系统状态和错误文本不拼接已保存的章数比例

#### Scenario: Reopen a session with saved writing progress

- **WHEN** 作者重开保存有旧进度数据的会话，包括只记录了通用计数的旧会话
- **THEN** 会话显示已有对话、工具活动、运行状态和适用的诊断信息。旧进度数据不渲染成卡片或比例，新 Run 的界面也不沿用上一轮的结果。同会话续办仍可使用上轮剩余事项，历史记录无需迁移

#### Scenario: A cancelled or interrupted run retains its lifecycle status

- **WHEN** 作者停止当前 Run，或应用退出导致 Run 中断，且此前已有部分内容提交
- **THEN** 运行状态分别显示取消或中断。已提交内容保留，可用的核对信息和适用诊断编号仍可查看，已提交部分不使本轮显示为完成

#### Scenario: A normally finished run can leave work incomplete

- **WHEN** 主 Agent 正常结束，但所有预期写入被拒且核对发现问题仍在，或只部分成功
- **THEN** 前者在运行状态中报告任务未完成及已知阻碍，后者报告部分完成、可用的已处理结果及可定位的剩余项。两者按终态核对呈现，不以运行结束表示任务成功

#### Scenario: A relocation remains partial after only the source edit commits

- **WHEN** 同章搬移分步提交时，旧位置删除已保存，但新位置未补入或后续补丁未通过
- **THEN** 保留已提交的修改，标为部分完成并指出剩余子目标。新位置也经提交或读回核实已满足后，才将该搬移计为完成

#### Scenario: Current evidence makes a second write unnecessary

- **WHEN** 续办前作者已修好目标，或此前提交仍满足该目标
- **THEN** 以当前读回或仍有效的提交证据标明已满足，无需再次写入，也不产生新提交记录

#### Scenario: A same-session cleanup completes only the documented remaining work

- **WHEN** 上轮增补已有真实回执和可见待办，当前作者要求收尾，本轮正文补丁与定点资料替换均获得实际提交，另有此前已满足的增补
- **THEN** 回执与当前文件分别证明两个续办项均已完成，跳过此前已满足的增补，按实际结果完成任务

#### Scenario: A blocked asset is still counted after a chapter commits

- **WHEN** 正文收尾实际提交，资料定点操作被拒，或资料目标已知但只能登记为待办，主 Agent 随后正常结束
- **THEN** 正文提交保留，资料仍计入未完成目标，报告可定位的资料剩余项和 `partial`。该项不能通过无权使用的全文工具结清

#### Scenario: A complete whole-book goal does not hide a blocked scoped edit

- **WHEN** 本轮已激活整书目标，并登记了两项独立局部工作。整书核对通过，局部正文已实际提交，伏笔短文目标的定点调用因现有整书路由被拒，或该目标仅登记为待办。同一伏笔另有一次不匹配定点要求的提交
- **THEN** 保留整书核对结果、局部回执和伏笔待办的独立证据。被拒的调用零提交，另一调用也不能抵销待办。正常运行结束时仍为 `partial`，在现有运行状态中说明整书已齐及待处理的伏笔，不能为结项改用其他资料写入口

#### Scenario: Local success does not relax incomplete whole-book requirements

- **WHEN** 本轮独立的局部修订均已满足，活动整书目标章数虽齐但仍缺必需资料或有效关联
- **THEN** 运行状态说明局部已满足及整书仍缺的资料或关联。保留整书续接记录和原有未完成结果，不标为全轮完成

#### Scenario: Resume only the local work left after a mixed run

- **WHEN** 混合 Run 已结清整书目标、保存了局部正文且留有可定位的局部资料待办，即使上轮模型自报全部完成，作者下一轮只要求完成剩余局部事项
- **THEN** 可依据上轮宿主摘要、回执及本轮读回重建有效局部范围，只处理作者指向的剩余事项。此次匹配的资料提交或经核对的当前证据才计为完成，旧参数或已失效修订不重放

### Requirement: Compact tool activity in Harness conversations

Harness SHALL render each contiguous group of tool activity messages as one collapsed-by-default disclosure in the conversation. Expanding the disclosure SHALL show the individual tool activity messages and their outcomes in their original order. User messages, assistant-visible text, run status, and errors SHALL remain independently visible and in their original chronological positions. Older sessions containing text-only tool activity messages SHALL remain readable and eligible for grouping without a history migration.

#### Scenario: Review a run with consecutive tool activity

- **WHEN** a Harness conversation contains several consecutive tool activity messages followed by assistant-visible text
- **THEN** the tool activity appears as one collapsed summary, and the assistant text remains a separate visible message after it

#### Scenario: Expand tool activity details

- **WHEN** the author expands a grouped tool activity summary
- **THEN** the individual tool activity messages and success or failure outcomes are visible in their saved order

#### Scenario: Read an older session

- **WHEN** the author opens a session saved before grouped tool activity is introduced
- **THEN** existing text-only tool activity messages can be grouped and expanded without changing the saved session or hiding other messages

#### Scenario: Preserve non-tool conversation content

- **WHEN** tool activity is adjacent to run status, an error, a user message, or assistant-visible text
- **THEN** those items remain independently visible and retain their chronological positions relative to the tool activity group
