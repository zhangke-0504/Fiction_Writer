## MODIFIED Requirements

### Requirement: Multiple model profiles and protocol adapters
模型设置 SHALL 支持新增、编辑和保存多条具名配置；每条需要名称、API Key、请求地址和一个手输的模型 ID，协议置于可展开区。新建配置 SHALL 先展示一个供应商选择页；首版「模型厂商」仅提供 DeepSeek，另有独立的「自定义配置」入口，两者复用同一表单。已保存配置 SHALL 直接打开编辑。供应商标识与协议 SHALL 分开保存，协议仍可选择 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages。不代理拦截、不提供账号登录、远程模型选择或用量展示；保存时仅允许已适配的供应商查询选定模型的能力。各协议须支持流式文本、完整工具调用与结果回传，并提供不读取作品的连接测试。配置密钥 SHALL 由应用侧单独保护，不出现在应用返回的配置详情、工具环境、Session 历史、日志或仓库。

#### Scenario: Configure and select distinct profiles
- **WHEN** 用户在设置中保存两条地址和协议不同的配置并重新打开应用
- **THEN** 两者仍可在 Harness 选择，设置展示名称、地址、模型、协议及适用的额度信息，不回传密钥明文

#### Scenario: Complete a tool round-trip per protocol
- **WHEN** 针对每种协议的受控端点分块返回工具调用参数
- **THEN** 适配器使用该配置的端点和鉴权，收齐并校验参数后调用工具，以该协议的调用身份提交结果，并接收后续流式回复

#### Scenario: Preserve requested DeepSeek continuation fields
- **WHEN** DeepSeek Chat Completions 端点在启用思考的工具轮次要求接续所需的推理字段
- **THEN** 同一轮的后续请求包含要求的原生状态，跨协议 Session 历史和应用日志不记录该原生字段

#### Scenario: Report tool incompatibility separately from basic connectivity
- **WHEN** 测试地址能返回普通文本但经工具往返检测不能完成调用
- **THEN** 测试结果分别给出连接成功、工具验证未通过的状态，而不自动改用其他协议或向其他地址发送密钥

#### Scenario: Reuse one saved profile across novels
- **WHEN** 作者保存一次有效配置，在两本新建的小说发起请求，重启应用后再次发送
- **THEN** 所有请求复用该应用级配置及已保存的模型能力，不需按小说重新填写密钥或识别额度；小说目录不写入供应商凭据

#### Scenario: Pick a vendor before setting up a profile
- **WHEN** 用户打开「新建配置」并选择 DeepSeek，或返回选「自定义配置」
- **THEN** 厂商列表只有 DeepSeek，没有账号登录；两条路径使用同一配置表单，DeepSeek 路径预填对应默认地址和协议，模型仍手填，选择与返回不联网；已有配置不经过选择页即可编辑

### Requirement: Bounded session context and append-only checkpoints
Harness SHALL 为实际模型请求估算输入预算，对旧文本和完整的历史工具往返按需压缩。压缩 SHALL 保留当前指令、关键作者约束、继续任务需要的进度、近期工具的匹配调用及协议所需原生状态。旧消息和整书任务的索引不因压缩改变。检查点 SHALL 私有且追加写入 Session；摘要失败 SHALL 有有限回退，不无限重试。每次开始新的 Run 时，Harness SHALL 仅为同一会话的近期旧对话原文计算配额：从首条主 Agent 请求的规划输入预算扣除系统指令、当前消息和工具定义的输入估算，取非负剩余空间的 `43%`（向下取整）作为一项约束。若配置能力来源为供应商声明，另一项约束为规划输入预算的 `5%`（向下取整）；若使用厂商兜底、通用兜底或无已确认额度，另一项约束为 `9,800`。SHALL 取两者较小值，从最近开始保留完整的旧对话分组。此配额不增加总输入预算，不改变作品记忆、摘要请求预算或当前 Run 工具往返的裁剪规则。

#### Scenario: Compact a long session with intact tool exchanges
- **WHEN** 长对话和多次工具调用超过保留预算
- **THEN** 实际的后续请求缩小，仍有当前方向、最早的已保留方向和足以继续的状态；近期 call/result 成对，所需原生字段原样透传

#### Scenario: Reopen a session after a checkpoint
- **WHEN** 产生压缩检查点之后重启应用或摘要端点失败
- **THEN** 原始会话可完整读取；重启后可用检查点和未压缩尾部继续，既不自动执行任务也不回放旧工具

#### Scenario: Scale retained dialogue with the confirmed input budget
- **WHEN** 同一会话开始新的普通请求，配置中的 DeepSeek 能力来自供应商声明，规划输入预算为 `1,039,184` 且剩余空间约束允许
- **THEN** 近期旧对话原文的预算为 `51,959` 个估算 token；实际发出的原文仅来自同会话可用的完整分组，不为填满配额回读既有检查点前的原文或其他会话

#### Scenario: Keep current input and unknown capability fallbacks bounded
- **WHEN** 当前系统指令、作者消息和工具定义使剩余空间约束低于原文上限，或能力来自厂商兜底、通用兜底或未确认的配置
- **THEN** 前者由剩余空间的 `43%`（向下取整且不为负）限制；后者按剩余空间约束与 `9,800` 中较小者规划，即便厂商兜底声明了 1M 窗口也不改用 `5%`；未纳入的旧对话按既有检查点机制处理，不删除原始记录

## ADDED Requirements

### Requirement: Persist model limits while saving a global model profile
保存已适配的模型配置 SHALL 使用该厂商的查询规则，在限定时间内为本次表单中的地址、协议和模型解析能力，校验数值后与配置原子持久化。首版只查询匹配的官方 DeepSeek 端点，不从自定义或中转端点的名称或协议推断官方能力；查询不得将凭据转发给不匹配的站点或跨源复用旧 Key，不发送作品、生成请求或原始供应商错误。能力缺失、无效或查询失败 SHALL 保存当前配置适用的兜底并显示来源，不要求另行点击检测；凭据保护或配置写入失败仍不得报告保存成功。既有无能力字段的配置 SHALL 可用本地兜底加载，不在启动、建书或运行时自动查询。活动 Run SHALL 继续用启动时解析的配置。

#### Scenario: Save provider-declared limits without a second action
- **WHEN** 已选 DeepSeek 且地址与协议匹配，用户手填模型 ID 并点「保存配置」，官方查询返回多条模型中的匹配条目及有效额度
- **THEN** 配置保存该模型的上下文窗口、最大输出及供应商来源并在设置页显示，不使用列表第一项替代、不生成正文、不额外要求测试连接

#### Scenario: Save with the appropriate fallback when capability discovery fails
- **WHEN** 已知官方 DeepSeek 模型查询超时、失败或返回不合法额度，或者配置是未识别的官方模型/自定义端点
- **THEN** 前者按适用的 DeepSeek 兜底 `1,048,576` 上下文和 `393,216` 最大输出保存；后者按通用兜底 `64,000` 和 `8,192` 保存；两者均标明降级，不宣称已测通写作请求

#### Scenario: Do not query official capabilities with a gateway credential
- **WHEN** 地址是中转网关、伪似官方域名，或其他与所选协议不匹配的路径，即使模型叫 `deepseek-flash`
- **THEN** Writer 不向官方查询端点发送该凭据，不因模型同名套用官方额度，也不阻止有效配置按通用兜底保存。若合规的官方查询返回重定向，Writer 不跟随也不转发凭据，视为查询失败并使用相应兜底

#### Scenario: Replace capability data when changing a profile
- **WHEN** 用户编辑配置并保存不同模型或端点，或在旧版留下的配置上首次保存
- **THEN** 新额度按更新后的配置身份解析，不能沿用不同身份的额度；保持配置 ID 与已有会话引用。同源留空 Key 使用已安全保存的 Key，切到不同来源时不得自动把旧 Key 用于新查询

### Requirement: Plan each model request within saved capability and context limits
Harness SHALL 用同一预算规则规划模型请求：输出由请求用途目标、保存的供应商最大输出、已知适用的协议或模式上限以及剩余上下文共同约束；输入按上下文窗口扣除本次输出和安全预留，并遵守已知独立输入上限。用于上下文装配的预算 MUST 与实际出站请求一致。必要输入装不下时 SHALL 走现有预算阻塞，不静默省略或发送无效额度。普通请求与显式小任务保留独立的用途预算；已有大写作预算选档在能力允许时 SHALL 使用 64 Ki tokens 的新策略目标而非 16,384 固定值。不得以预算变化改变整书 Skill 生效顺序、工具写入保护、轮数限制或 `output_limit` 的现有恢复边界。

#### Scenario: Calculate input using the applicable output target
- **WHEN** 配置声明 `1,048,576` 上下文、`393,216` 最大输出且没有更小适用上限，分别规划普通请求和已有资格提档的写作请求
- **THEN** 普通请求按 `8,192` 输出、`1,039,184` 输入规划，大预算请求按 `65,536` 输出、`981,840` 输入规划（均扣除 `1,200` 预留）；出站字段采用同一规划值，而不是每轮使用 `393,216`

#### Scenario: Clamp requests and keep mandatory input intact
- **WHEN** 受控端点配置的适用最大输出比请求用途目标更小，或必要上下文与安全余量无法在适用窗口内装入
- **THEN** 前者在装配上下文前以较小的输出预算计算输入空间，出站使用实际限额；后者标记 `context_limit`，不发出请求或截掉必需资料，也不改变已落盘内容

#### Scenario: Use the new budget without claiming the two follow-up fixes
- **WHEN** 首次携带整书 Skill 的请求尚未按既有时机进入大预算档，且后续请求可进入大预算档；另有一个请求明确报告 `output_limit`
- **THEN** 首条请求仍按现有时序选档，已提档请求使用新的预算规则；触限回复保持既有失败语义，不执行不完整工具批次、不新增重试或恢复
