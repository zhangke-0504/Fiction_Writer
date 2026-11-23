## Why

Session 历史只能看到对话和粗略的工具结果，界面的内存通知也无法在重启后复查。迭代需要能用本地记录还原一轮操作：界面发起、Agent 选用 Skill、模型和工具往返、文件变更落盘，以及界面最终有没有刷新。

## What Changes

- 在 Electron 用户数据目录下新增 `logs/`，按本地自然日分别追加 `frontend-YYYY-MM-DD.jsonl` 和 `backend-YYYY-MM-DD.jsonl`。同日重启不覆盖，跨日自动切换，正常时钟下只保留今天及前 29 天。
- 前端记录有排障意义的操作、界面错误、通知缺口和重读结果；后端记录主进程和后台进程的启动、退出、IPC 结果、Run、模型、loop 轮次、每次工具调用、Skill 实际使用、文件提交和工作流恢复。单章、只读回读和整书流程也记录，不局限于通用 loop。
- 通过请求、运行、轮次、工具和文件通知的标识将事件串联。Harness 运行失败时提供可复制的排障编号；README 记录本地目录、保留策略及按编号查两份文件的方法。
- 详细记录动作和结果，但不写入 API Key、原始 IPC 或模型响应、提示词、稿件、附件、命令原文与输出。诊断文件独立于 Session 历史和作品，不自动上传。日志写入失败不阻塞应用主功能。
- 不引入日志平台、数据库、后台守护进程、可视化仪表盘、用量统计或会话副本。

## Capabilities

### New Capabilities

- `local-diagnostic-logging`: 本地前后端日文件、留痕与关联、内容最小化、故障隔离和排障说明。

### Modified Capabilities

## Impact

- 涉及 Electron 主进程、preload、后台 worker、渲染器、模型/工具/Skill 和写作流程的诊断接入点。增加独立日志文件，不改变现有小说格式、工具行为、模型请求协议或 Session 持久化格式。
- README 补充 Windows 默认目录 `%APPDATA%\fiction-writer\logs` 和实际路径的确定方式；自动化使用临时用户目录和合成内容，不需要真实凭据。
