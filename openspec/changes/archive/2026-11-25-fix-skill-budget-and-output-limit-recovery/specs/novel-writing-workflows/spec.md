## ADDED Requirements

### Requirement: Advance a narrowed writing task one verified unit at a time
输出触限后的主 Agent 逐项处理 SHALL 仅使用仍有效的已派发整书 Skill 或同作品同会话已确认的跨章编辑方案。候选下一步 SHALL 依据原授权、已登记目标、最新现稿、真实工具提交与缺项来确定。若整书指南已送达而目标未登记，允许通过现有工具作必要的定向核查或登记完整目标；不得从半截模型响应猜测章节、生成授权或拆成多个整书目标。逐项处理 SHALL 一次只放行一个可独立核对的必要读取、登记、写入或同步动作；工具参数的估算长度 SHALL 不超过当次有效输出额度的 `1/8`（向下取整），不得裁截参数来通过。禁止多工具大批次、无关重读、重复已完成的写入或绕过原有章序、版本、锚点和关联校验。需要一起提交的同章改动仍按现有工具原子边界完成。不得通过删减范围、跳过必要产物或把摘要当作正文交付来消除触限。

#### Scenario: Preserve the full goal when making a smaller whole-book step
- **WHEN** 《蝙蝠侠》式整书任务的主 Agent 触限且有一个可核对的基础或待写步骤
- **THEN** 可用现有工具先核查、登记完整目标或完成单项缺失目标，随后按现稿继续；不重开整书、不重写已有章节、也不把一个小步骤成功当作整书完成

#### Scenario: Finish the next confirmed edit without replaying earlier commits
- **WHEN** 海贼王式跨章方案已经确认，至少一处修改实际落盘，后续主 Agent 大批次触限
- **THEN** 续接根据现稿、原确认范围和回执只处理一个未完成目标，例如一次受核验的同章插入或资产同步；首处现稿与有效回执不重做，后续仍有待处理的范围完整保留

#### Scenario: Stop when a smaller action cannot make verified progress
- **WHEN** 模型在逐项状态下仍返回多动作大批次、超出参数额度的单个动作、猜测未知目标、只声称完成、重复无变化的步骤，或下一步不能在原有工具边界下安全拆分
- **THEN** 不执行不合格批次、不继续无进展的自动请求；保留既有成果，在同一会话说明已保存和未完成的部分，只在实际交付核对通过时报告全部完成
