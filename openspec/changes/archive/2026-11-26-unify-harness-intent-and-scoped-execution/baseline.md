# Harness 迁移基线

2026-11-25 本地诊断和同会话回执：

| 受控复现目标 | 观察 | 代码调用点 |
| --- | --- | --- |
| 增补原句和同义句 | `0e70a5b9…` 的 `#2737` 在 `#2741` 首个主模型请求前先发 `0/5`，无发现调用。对 `chapter-intent` 传原句及仅改写登场时机的字符串，分别得到 `(staged=true,min=2)` 和 `(staged=false,min=0)`。 | `worker.startSession` → `NovelTools.prepareEdit`；`stagedEntry`、`connectedEntry`、`chapterStage` 控制提示、章节候选、工具门禁、进度/同步和 `assertFinished`。 |
| 清晰的同会话续办 | `34b91132…`：11 次成功读稿、两次 `patch_not_authorized`、一次 `insert_not_authorized`、两次资料更新 `invalid_options`，零提交但 `#1700 ok/complete`。向纯函数传同一句及十章索引不能得到 patch、insert 或确认许可。 | `worker.ts` 只给 `NovelTools` 当前 `authorPrompt`；`loop.ts` 给模型会话历史；`patchChapter`、`generate`、`story-assets.authorized` 分别匹配单句，`runs.ts` 仅根据回调返回定生命周期。 |

现有受控夹具可复用，而不是让新实现继续期望旧错误：`tests/edit-continuation.test.ts` 的直接增补、已确认方案、版本冲突与新资料同步；`tests/chapter-patch.test.ts` 的已读短原文、来源锚点、改版及同 Run 勘误；`tests/e2e/workflow.spec.ts` 的多轮 IPC／真实文件校验。新的受控回归应使用相同的上下文及同义输入，断言任务前提与提交，而非断言固定工具顺序。

- `worker.ts` / `loop.ts`：迁移提示路由和能力暴露；保留书绑定、预算、真实 tool result、取消、脱敏回执和供应商协议校验。
- `chapter-intent.ts` / `edit-proposal.ts`：迁移自然语言的猜测；可复用显式语法、方案身份和历史来源。保留锚点、原章 ID、已显示的方案绑定、作者后续约束。
- `novel-tools.ts` / `story-assets.ts`：迁移 `prepareEdit`、patch/insert/replace、资料范围和进度判定。保留版本、引用、重复防护、有限改动、已写片段证据、保留稳定资料与同步规则。
- `novel-goal.ts`：迁移从原话抓取的章数/续接授权；保留书内目标清单、持续检查、非空章复用和新稿事实勘误。
