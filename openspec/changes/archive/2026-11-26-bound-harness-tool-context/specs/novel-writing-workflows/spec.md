## ADDED Requirements

### Requirement: Locate and page bound-book manuscript evidence on demand

绑定小说的主 Agent SHALL 能按需发现当前作品的索引、限量文本搜索和定向原文分页能力。目录和索引默认只给有界元数据；完整资料需要显式请求分批取得。文本搜索 SHALL 给有界、可翻页的命中预览与来源，不将未完成的搜索报成确定无命中。查询只使用当前绑定作品，不把普通目录会话变成书稿会话，也不按作者措辞自动预取、查章或把书稿预先注入首个模型请求。

原文分页 SHALL 告知文档类型及 ID、修订、精确原文和实际范围；限量读是默认行为，显式请求大长度仍须受页预算约束。下一页从实际展示范围之后继续；部分结果、末页和预算不足未携带原文 SHALL 可区分，不能跳过未送达文本或把预算不足伪装成空末页。版本变化时 SHALL 有足够的修订信息让主 Agent 重新定位，不能把不同版本拼成同一版原文。搜索命中只供定位，不代表原文锚点或全文已读。

#### Scenario: Find evidence without reading entire chapters by default

- **WHEN** 绑定小说的主 Agent 请求索引或搜索现有材料，再按真实文档 ID 定向取原文且省略长度
- **THEN** 索引不附带大段正文，搜索仅给可定位的有限结果，定向读取只带有限原文及当前修订和范围；未返回的部分可继续读，不混入其他作品或写入状态

#### Scenario: Continue from the page actually shown to the model

- **WHEN** 长原文页因单条或同轮预算缩短，主 Agent 使同一修订继续翻页；对照变体中作者已在两页间修改稿件
- **THEN** 同版续页从实际已携带原文结束处连续读取，边界不破坏字符；预算未携带原文时可单独重读同一位置；更新版被标示为不同修订，不能与旧页合并用于修改

#### Scenario: Read required long assets in bounded pages

- **WHEN** 现有资料更新动作仍要求阅读当前大纲及故事资料，有短资料、超长资料和未读页
- **THEN** 主 Agent 可以显式分页取得完整的短资料，并按 ID 分段取得长资料，未读项仍可定位；目录、部分页或结果引用不被承认为完整阅读，现有写入前提及实际落盘核对不变

### Requirement: Count only dispatched manuscript ranges as read evidence

对依赖模型已读原文的既有工具行为，Harness SHALL 仅把实际交给模型请求传输层的同文档、同修订原文范围记为本 Run 已读。准备但未派发的页、预算隐藏部分、搜索预览、目录或历史引用不能补记为正文；已有合法的目录与修订元数据用途不受影响。后续投影压缩不撤回先前已派发的同版范围，也不把旧版范围转记为新版。本要求不替代现有 `BookTaskScope`、唯一锚点、修订一致性、提交与取消检查，也不授予任何新的写入权限。

#### Scenario: A reduced or undispatched page does not cover a patch anchor

- **WHEN** 定点原文在工具内部已读出，但相应片段没有进入实际出站请求，或当轮在派发前取消
- **THEN** 仅引用、预览及被省略部分都不满足该短原文的既有已读前提；有权限的同版局部写入仍可通过定向补读推进，不自动执行或登记修改

#### Scenario: Already delivered evidence is not lost when history is reduced

- **WHEN** 本 Run 已发送范围内的同版原文，之后其历史工具结果退为引用；另一变体中磁盘版本已更改
- **THEN** 同版且能准确引用的短原文仍满足既有已读前提，不强制重读；旧证据不覆盖更新版本，冲突时由现有规则要求定位当前原文并保持未授权内容不变
