## MODIFIED Requirements

### Requirement: Count only dispatched manuscript ranges as read evidence

对依赖主 Agent 已读原文的既有工具行为，Harness SHALL 仅把实际交给本 Run 主 Agent 请求传输层的同文档、同修订原文范围记为其已读。准备但未派发的页、预算隐藏部分、搜索预览、目录或历史引用不能补记为正文；已有合法的目录与修订元数据用途不受影响。后续投影压缩不撤回先前已派发的同版范围，也不把旧版范围转记为新版。本要求不替代现有 `BookTaskScope`、唯一锚点、修订一致性、提交与取消检查，也不授予任何新的写入权限。

子任务仅把定位引用和发现交给主 Agent，不共享主工具的已读记录。已定位的书稿片段出处 SHALL 携带文档类型、ID、修订和范围；不能定位时标出未查项，不虚构来源。子任务已读或报告里的引文 MUST NOT 自动成为主 Agent 的原文证据、授权登记或写入回执。涉及既有原文前提时，主 Agent SHALL 按现有只读工具和规则取得所用证据；已经实际派发给主 Agent 且未变化的同版原文不必重读。引用修订变化时重新定位所用出处，不把不同修订拼成同一版，也不因单一引用过期重读整书。

#### Scenario: A reduced or undispatched page does not cover a patch anchor

- **WHEN** 定点原文在工具内部已读出，但相应片段没有进入实际出站请求，或当轮在派发前取消
- **THEN** 仅引用、预览及被省略部分都不满足该短原文的既有已读前提；有权限的同版局部写入仍可通过定向补读推进，不自动执行或登记修改

#### Scenario: Already delivered evidence is not lost when history is reduced

- **WHEN** 本 Run 已发送范围内的同版原文，之后其历史工具结果退为引用；另一变体中磁盘版本已更改
- **THEN** 同版且能准确引用的短原文仍满足既有已读前提，不强制重读；旧证据不覆盖更新版本，冲突时由现有规则要求定位当前原文并保持未授权内容不变

#### Scenario: A delegated report locates an anchor without satisfying the parent's read prerequisite

- **WHEN** 一个子任务回读章节锚点并报告出处，主 Agent 取得报告但尚未通过自己的读取获得该范围；对照变体中引用修订已变化
- **THEN** 报告不满足原文前提，也不登记范围；父 Agent 按需定向读当前版本的相关出处后，才能按既有授权、范围和提交规则使用。查证同版时以引用修订为准，不混用旧页和新页，不因此强制重读无关资料或修改未经授权的内容
