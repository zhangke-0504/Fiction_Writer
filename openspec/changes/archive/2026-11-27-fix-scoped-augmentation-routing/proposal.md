## Why

[2026 年 11 月 27 日的验证记录](../../../../design/20261127/harness-scoped-augmentation-routing.md)显示：十章整书已完成，后续增补也正确走了局部路线，但一个获准的资料定点补丁被推往同步入口，而同步入口也不接受这类登记。文档缺失的反馈没有说明建章顺序，新增过渡又走了替换旧文的补丁；Run 正常结束时仍有未落盘的事项。

## What Changes

- 让范围登记和执行共用资料路由语义。用本轮资料创建、关联场景实际提交及当前修订，支持对本次新建的主体／伏笔做有证据的状态与计划同步。将这些事实送进既有范围核对，并返回匹配当前授权的工具路径。精确补丁、只待办和开放式更新不互相授予权限，补丁提交也不自动结清同步。
- 新增章节仍是作者允许的选项，不是固定交付项。选用时先登记 `chapter.catalog` 并用 `book_apply_changes` 提交目录，再登记 `chapter.draft` 并写正文；对不存在章节的正文登记指出这个下一步，不要求作者手动创建，不自动补建或跳过登记。
- 给已有章新增过渡、线索或登场用 `book_generate_chapter(mode=insert)`；只有确实需要改动授权的旧文本才用 `book_patch_chapter` 和原有审校。保留现有版本、锚点、回声和写入约束。
- 不重开 `separate-harness-local-and-whole-goals`，不改变整书资格、完成核算、`output_limit`、预算、重试或审校强度。不新增审批、验证关卡、工具沙箱、工具入口或自动执行流程。

## Capabilities

### New Capabilities

无；修正现有局部写作能力。

### Modified Capabilities

- `background-agent-harness`: 让范围登记区分资料同步与其他更新，并为待建章的正文登记返回可执行的依赖提示。
- `novel-writing-workflows`: 让关联资料同步与已登记的精确替换各走可执行的路径，明确新剧情插入和旧文修订的边界，并分别核对写入与待办。

## Impact

- 涉及 `electron/agent/` 的范围登记、故事资料同步、写作工具描述及回执，以及 `electron/worker.ts` 的主 Agent 指引和 `skills/story-consistency/`。不变更桌面 IPC、文件格式或依赖。
- 用十章隔离书稿和本地协议夹具走正常 Harness IPC，按 `runId`、`callId`、工具回执和磁盘修订核对实际提交与拒绝后的零提交。受控回归不代表真实模型已重测；实盘需另行启用。
