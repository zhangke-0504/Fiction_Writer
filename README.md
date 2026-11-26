# Fiction Writer

简体中文 · [English](README.en.md)

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

开发与贡献说明见 [AGENTS.md](AGENTS.md)。

## 致谢

感谢以下开源项目的维护者和贡献者：

- [Pi](https://github.com/earendil-works/pi)：Harness 的 Agent 循环使用 Pi SDK；也参考了它用摘要衔接旧会话上下文、保留近期消息，以及不执行被截断的工具调用的做法。
- [OpenCode](https://github.com/anomalyco/opencode)：早期 Harness 设计参考了它对运行状态和事件的划分。
- [Hermes Agent](https://github.com/NousResearch/hermes-agent)：书级记忆参考了它为记忆设定容量上限、用原子写入保存记忆的做法。
- [OpenClaw](https://github.com/openclaw/openclaw)：书级记忆参考了它把候选证据与已确认的长期记忆分开处理的做法；输出触限恢复也参考了它对有限续接和原样重发的区分。
- [OpenAI Codex](https://github.com/openai/codex)：Harness 参考了它区分未完成的模型响应与传输失败重试、为工具结果单独分配上下文预算，以及按需等待子任务的做法。
- [CC Switch](https://github.com/farion1231/cc-switch)：新增模型配置的界面参考了它的供应商分组和两步流程：先选预设或自定义，再填写配置。

## 请我喝杯咖啡

如果你觉得 Fiction Writer 还不错，欢迎扫下方的微信支付二维码，请我喝杯咖啡。谢谢支持！

<p align="center">
  <img src="docs/assets/wechat-pay.png" alt="请我喝杯咖啡的微信支付二维码" width="360" />
</p>
