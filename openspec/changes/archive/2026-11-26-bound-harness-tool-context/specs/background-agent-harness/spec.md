## ADDED Requirements

### Requirement: Bound rereadable tool results before model dispatch

Harness SHALL 对主 Agent 实际出站的可重读工具资料分别应用单条结果、同一回复触发的整批新结果、历史各轮保留原文的预算，即使整次模型请求仍能装入硬输入窗口也要生效。结果预算 SHALL 以实际序列化的资料体积估算，并服从原有输入预算；不改变模型输出计划、原生往返结构、旧对话原文配额或主循环执行顺序。

新的结果不能完全装入时 SHALL 使用有效分页或明示未携带的可回读引用；旧的可重读资料 SHALL 能去重或退为可定位引用，不能把引用或预览当原文。保留的工具往返 SHALL 保持调用与结果成对、原调用身份与顺序以及协议要求的原生块；需要丢弃旧往返时 SHALL 按完整往返处理。Harness SHALL 优先保留当前作者输入、有效目标及范围、可续办待办、必要 Skill 和能核对已完成工作的提交回执；不能靠把必要控制状态截成不完整片段来装入请求。必要状态仍装不下时沿用原有上下文不足行为，不伪造已送达或重做旧写入。投影 MUST NOT 改写作品、会话原记录或持久回执，不新增原始工具结果留存。

#### Scenario: Cap a large read batch well below the provider context limit

- **WHEN** 大窗口主 Agent 在一个回复中请求多个长资料页，每条本可单独装入模型窗口，后续还要继续取材
- **THEN** 实际出站的单条与同批可重读部分都在其配额之内；工具结果仍与原调用匹配并保持顺序，未携带的内容可定位回读而不是伪造完整数据，模型实发输出上限不因为投影改变

#### Scenario: Retain useful state without accumulating old rereadable text

- **WHEN** 多轮取得大段原文并产生可核对的写入回执，同版同范围被重复读取，后续请求仍远小于模型硬输入窗口
- **THEN** 历史保留的可重读原文合计受历史配额约束；旧正文可退为含文档、修订、范围的引用，近期原生往返和继续工作所需的任务状态仍有效；原稿、会话记录与真实回执未被投影改写，已完成的写入不重放

#### Scenario: Preserve first whole-book skill dispatch under read pressure

- **WHEN** 合格的首次整书 Skill 结果和若干大读取结果同轮装配，或因必要资料无法装入而没有派发
- **THEN** 能装入时必要指南完整携带、原生往返匹配，仍按已有首个整书 Skill 的预算规划；未派发时不生成已应用 Skill、已送达结果或实际派发预算的证据
