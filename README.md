# Fiction Writer

Windows 优先的本地小说编辑器，附带按作品组织会话与记忆的 Agent Harness。不开启 Harness，也不配置模型，就能写作。

## Windows 启动

安装 Node.js 24 后，在项目目录运行：

```powershell
npm ci
npm run dev
```

`npm run dev` 构建并启动 Electron 桌面窗口，不需要另起 Web 服务。也可以先运行 `npm run build`，再用 `npm start` 打开已构建的应用。首次安装／启动可能需要联网获取 Electron；编辑小说不需要联网。

## 写作与协作

1. **书库**：新建小说填小说名和简介，题材与文风选填。「编辑」进入工作区，可以再修改这些字段。搜索匹配小说名及作品文件中已有的作者元数据，不搜索题材。
2. **工作区**：左栏可管理人物、物品、场景、伏笔、全书大纲和章节。点中章节直接编辑 Markdown，使用「保存」或 `Ctrl+S`。基本信息和正文的未保存草稿在应用内切页时保留；收到同一文件的新版本时会提示冲突，可复制自己的文字或重载已保存文件。
3. **设置**：可以新增多条模型配置，每条填写名称、API Key、基地址、一个模型 ID。高级选项选择 Chat Completions、Responses 或 Anthropic Messages。地址保留供应商的前缀，由应用追加 `/chat/completions`、`/responses` 或 `/messages`；例如官方 DeepSeek 可用 `https://api.deepseek.com`、`deepseek-v4-flash` 和 Chat Completions。不要填写已包含操作名的 URL。「测试连接与工具」只发合成数据，分别报告是否连通、能否完成工具往返。
4. **Harness**：先进入一本小说的编辑页，再按 `Ctrl+Alt+I` 或点右上角按钮。书库和设置页不提供入口。侧栏只显示当前作品的 Session（同名小说也分开）；第一条已保存的作者输入会成为会话标题。离开编辑页会关闭侧栏，不会中断后台任务，回来可从历史选回该会话。发送前可选配置、思考等级和 UTF-8 参考文件；默认 `high`，无法映射时显示采用模型默认思考设置。
5. **直接发送任务**：同一输入框可讨论剧情、维护资料、写一章或写整本，不必选模式。例如「将希腊神话故事奥德赛写成小说，大概写10章左右。记得生成主体，伏笔和大纲和章节正文」。Agent 会按意图找到写作 Skill，用作品工具逐章保存；预览标为「生成中 · 未保存」，取消、断流或输出触限不会写半章。中断后可在同一 Session 发送「接着写完」：先核对现稿，保留已有正文，不自动启动。可在新消息里明确变更创作方向；需要参考文件时请重新添加。

小说会话沿用 `book_get_context`、`book_apply_changes`、`book_generate_chapter` 和 `skill_search`／`skill_load`。工具在应用内注册，不需要启动 MCP 服务。旧普通目录会话及其后台能力仍保留，但不在小说侧栏里列出或新建。

## 作品与应用数据

Windows 的作品库在系统「文档」文件夹下的 `Fiction_Writer/library`。每个作品以稳定 ID 命名，其中包含 `book.md`、`outline.md`、`subjects/`、`foreshadowing/`、`chapters/`。资源名称与关联记录在 Markdown 的 YAML frontmatter 或链接里；编辑器可以单凭这些文件重建作品。备份或迁移作品时复制整个作品目录。外部编辑的保存会触发重读；不能解析的文件保留原样并显示诊断。

模型配置、加密的 API Key 和 Session JSONL（包括未完成整书任务的续接信息）在当前用户的 Electron 应用数据目录下（Windows 通常是 `%APPDATA%\fiction-writer`），不在作品库中。**同一个已保存配置供所有小说使用，新建小说不需要重新输入 Key。**API Key 由操作系统保护，不随稿件导出。不要把真实 Key 放进项目文件、参考文件或命令。单独复制 `profiles.json` 不会迁移本地解密环境；更换 Windows 用户或应用数据目录后，如提示无法解密，请在新环境的设置里重新填写 API Key。这类错误发生在发送模型请求之前，不是服务端返回的鉴权失败。

## 记忆与上下文

- **作品记忆**：每本书的 `.fiction-writer/memory.json` 保存本书的定位索引和作者约定，首次使用时建立。故事依据仍是已保存的 Markdown；每次召回按当前版本取原文片段，外部修改或删除后不再引用旧证据。新会话可按人物、物件或关键语句找回早期线索；实际写章请求也使用本书证据。写早章时不把后章正文当成已发生事实；大纲和伏笔作为计划。未保存预览、临时聊天和其他书的记忆不参与召回。
- **长期约定**：可对 Harness 说「请记住：全书一律用第三人称有限视角」，也可以要求列出、更正或忘掉某条约定。每本书最多 16 条、共 3,000 字符，本轮明确指令优先。备份约定时一起保留侧车文件；索引本身可从现稿重建。
- **会话压缩**：模型请求用保守的输入预算（计入中文、工具参数与协议块并预留输出），优先保留当前作者要求、近期完整工具往返和任务进度。会话过长时，在该 Session JSONL 追加私有摘要及边界；摘要服务失败则使用有限历史摘录。原聊天不改写、不串到其他会话。工具回执记录实际执行及已确认的写入、版本或失败，不保留原始工具参数或输出、隐藏思考和附件，也不会在重启后重放。
- **边界**：作品召回使用本地关键词与原文索引，不依赖额外模型、向量库或定时 Dreaming。含糊查询可能找不到相关段落，补充线索名称或请求按原句查找更可靠。未知兼容端点的预算是估算，不是精确 tokenizer。

### 手动验证

先关闭旧窗口，在已构建的项目目录运行 `npm start`。进一本书，在较早章节中段保存一个独特线索（例如「灰珍珠的三道裂纹拼成渡港图」），另开一个 Session，请 Agent 找出灰珍珠的线索，或用它续写后续章。切换到另一本同名小说重复查询，应看不到前一本的线索。也可更改原段落再查询，确认不再引用旧值。整个过程复用设置中同一个供应商配置，不用再填 Key。

## 本地诊断日志

日志默认开启，只写本机，不上传。实际目录是 Electron 的 `app.getPath('userData')` 下的 `logs`，Windows 默认是 **`%APPDATA%\fiction-writer\logs`**。应用启动过后，在 PowerShell 打开它：

```powershell
$logDir = Join-Path $env:APPDATA 'fiction-writer\logs'
explorer.exe $logDir
```

- `frontend-YYYY-MM-DD.jsonl` 记录界面启动、关键操作、通知序号缺口、重读文档及显示新修订或保留草稿的结果。
- `backend-YYYY-MM-DD.jsonl` 记录主进程和后台生命周期、模型请求、Agent 轮次、工具校验与实际执行、Skill 检索、加载及实际发往模型的结果、整书目标核对和文件提交。工具结果已回传指交给下一次请求的传输层，不代表模型确认；Skill 已采用不代表模型遵循了规则。`context.checkpoint` 和 `context.compacted` 分别记录会话检查点及本轮工具历史裁减，只含计数和结果类别，不含摘要或稿件。

两份日志都是 UTF-8，每行一个 JSON 对象。按电脑的**本地日历日期**分文件，同日重启追加到原文件，跨午夜自动切换。启动时和运行中清理，保留今天和之前 29 天的应用日志。临时清理失败时，同一天最多再尝试两次，重试至少间隔一分钟；应用关闭期间不清理，下次启动再处理。日志异步写入，正常退出给日志最多 750 毫秒收尾；硬崩溃、磁盘写入失败或队列溢出可能缺记录。一份日志拒写时，其他可写文件继续写入；可在后台日志恢复可写后查 `diagnostics.loss`。崩溃留下的破损行可跳过，不影响读取后续记录。

### 按 Harness 诊断编号排查

复制 Harness 错误旁的诊断编号：**运行已开始**时是 `runId`，**尚未启动就被拒绝**时是 `requestId`。下面的命令跨日期查两类文件，并把 Run 对应的原始请求一并找出来：

```powershell
$logDir = Join-Path $env:APPDATA 'fiction-writer\logs'
$id = '粘贴诊断编号'
$rows = @(Get-ChildItem -LiteralPath $logDir -File |
  Where-Object { $_.Name -match '^(frontend|backend)-\d{4}-\d{2}-\d{2}\.jsonl$' } |
  ForEach-Object {
    Get-Content -LiteralPath $_.FullName -Encoding UTF8 | ForEach-Object {
      if ($_.Trim()) { try { $_ | ConvertFrom-Json -ErrorAction Stop } catch {} }
    }
  })
$requestIds = @($id; $rows | Where-Object { $_.fields.runId -eq $id } |
  ForEach-Object { if ($_.fields.requestId) { $_.fields.requestId } })
$rows | Where-Object { $_.fields.runId -eq $id -or $requestIds -contains $_.fields.requestId } |
  Sort-Object time, logSeq | Format-List time, bootId, logSeq, source, event, fields
```

追查工具时用 `callId` 和 `spanId` 看调用是哪一轮发起、是否执行以及结果进了哪次请求。追查界面没更新时，在同一个 `workerId` 下用 `changeId`、`journalSeq`、修订指纹对照后台落盘和前台重读；`via: snapshot` 表示快照比已收到的通知更新，并不单独证明掉包。整书续接可对照 `novel.goal` 的 `register`／`resume` 和同一 Session 的 Run，查看实际章数、`chapterIndex` 和 `novel.chapter.reused`。`incomplete_stream` 和 `output_limit` 分别表示没有完整结束与输出触限；新版不再重放旧工作流检查点。文档和普通路径的引用是同一次启动内可比对的短指纹，不是文件名。

日志不会保存 API Key、提示词、正文、附件、原始工具参数或输出、命令、隐藏推理和异常原文，也不替代作品备份或 Session 历史。排障优先提供诊断编号及核对过的必要事件，不要提交日志文件或粘贴密钥配置。

## V1 边界

- 书籍、资料、章节和 Session 的删除是硬删除，无撤销、归档或确认弹窗。删除运行中的 Session 或作品时先停止对应的后台任务；此前已经写成的其他内容不会回滚。
- 切页、关闭侧栏或重载界面不打断任务。退出整个应用不继续执行；重启后可看历史，整书任务需作者在会话中明确要求继续。应用内批量修改不是数据库事务，遇到部分写入会报告已提交与未提交项。
- 普通目录命令以当前 Windows 用户权限运行，没有额外沙箱或逐步审批。只在你信任的目录和任务上使用；不承诺撤回命令副作用。外部进程直接改稿时，应用只能核对磁盘并提示冲突，不能拦截它们。
- 长篇优先给模型近期前文和相关素材，可在生成正文前补读有限的原文证据。记忆改善取材和续写，不保证模型推理出的剧情一致，仍需作者核对。

## 验证

```powershell
npm run typecheck
npm test
npm run test:e2e
openspec validate --all --strict
```

回归测试使用临时库和本地合成端点，覆盖三种协议在压缩后继续工具往返、应用重启和两本书共用一个密钥、同名书隔离、第 25 章跨会话取回第 2 章线索、源稿修改／删除、切页后接回预览，以及自然语言驱动的整书 Skill 在断流或输出触限后的重启续接。诊断测试用合成敏感值核对两份日志，并回溯工具拒绝、文件通知缺口和整书实际提交。Windows 上另用 `deepseek-v4-flash` 验证了真实的 Chat Completions 流式工具往返；Responses 和 Anthropic Messages 的验证是本地协议夹具，不代表每个兼容网关都能工作。

可选真实 DeepSeek 验证（读取已被 Git 忽略的 `design/ds_config.txt`，只向官方端点发少量合成请求，不读取作品，也不打印 Key）：

```powershell
npm run test:deepseek -- --live
```
