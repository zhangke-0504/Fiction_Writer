# Fiction Writer

Fiction Writer 是一个面向 Windows 的本地 Markdown 小说编辑器。不配置模型，也能离线写作。

## 主要功能

- **小说书库**：管理多部作品，整理人物、物品、场景、伏笔和全书大纲。
- **章节编辑**：按章编写 Markdown 正文，稿件以本地文件保存。
- **可选的 AI 写作助手（Harness）**：讨论剧情、整理设定、起草章节或整本小说。会话和记忆按作品隔离。

## 快速开始（Windows）

安装 Node.js 24 后，在项目目录运行：

```powershell
npm ci
npm run dev
```

这会构建并启动 Electron 桌面窗口，无需另起 Web 服务。在书库点「新建小说」，填写小说名和简介，再点「编辑」进入工作区。新建章节即可写作，按 `Ctrl+S` 保存。

**想试用 AI 助手？** 在「设置」添加模型配置，填写名称、API Key、供应商基地址和模型 ID。基地址不要包含具体请求路径（如 `/chat/completions`）。保存后，进入小说编辑页，按 `Ctrl+Alt+I` 打开 Harness，例如输入「根据大纲写第一章」。

作品保存在系统「文档」文件夹下的 `Fiction_Writer/library`。备份或迁移时，复制整个作品目录；模型配置和会话历史不随作品目录迁移。

开发、测试和排障约定见 [AGENTS.md](AGENTS.md)。

<details>
<summary>按诊断编号查找本地日志</summary>

日志只写本机，位于 Electron 的 `app.getPath('userData')` 下的 `logs` 目录（Windows 默认 `%APPDATA%\fiction-writer\logs`）。每天分别写入 `frontend-YYYY-MM-DD.jsonl` 和 `backend-YYYY-MM-DD.jsonl`，保留本地当天及之前 29 天（共 30 天）。应用关闭时不清理，硬崩溃可能丢失尚未写入的记录。

复制 Harness 错误旁的诊断编号（运行已开始用 `runId`，启动被拒用 `requestId`），在 PowerShell 搜索两类日文件：

```powershell
$logDir = Join-Path $env:APPDATA 'fiction-writer\logs'
$id = '粘贴诊断编号'
Get-ChildItem -LiteralPath $logDir -File |
  Where-Object { $_.Name -match '^(frontend|backend)-\d{4}-\d{2}-\d{2}\.jsonl$' } |
  Select-String -SimpleMatch $id
```

用 `runId` 找到 `run.started` 后，还可用同一行的 `requestId` 查启动前的记录。核对作品记忆时，按 `runId` 找 `memory.recall.finished`，再按 `recallId` 找 `memory.context.dispatched`，用 `spanId` 对照 `memory.context.source`（实际带上的来源）和 `model.http`。召回不等于派发；派发只表示交给传输层，不代表供应商收到或模型采用。日志也可能缺失，不要仅凭缺少记录判断请求未发送。

检查长读稿时，用相同的 `runId` 和 `spanId` 对照 `model.budget_dispatched`（本地输入估算与实发输出上限）和 `context.projected`（本轮与历史保留的可重读体积估算、投影条数）。`tool.result_sent.delivery` 区分完整结果和投影，`tool.result_omitted` 表示未发送；派发不证明供应商已接收或模型已采用。Chat 的 `model.finished.providerStop: output_limit` 表示显式长度终态，未标记的 `incomplete_stream` 不据此推断触限。本地超时、取消另有原因，Chat 不因此进入 Messages 的续接路径。

排障时可提供诊断编号和核对过的必要事件，不要提交原始日志或粘贴密钥配置。

</details>
