## Why

新小说打开侧栏后先看到空历史，还要再点一次才能输入。侧栏重复显示「Harness」和新建入口，搜索框也仍提示可以按目录查找。

## What Changes

- 把小说编辑页的侧栏入口改为「AI」。移除侧栏顶部的「本地协作」和「Harness」，将历史、新建和关闭图标保留在右侧。
- 移除历史页的「当前小说会话」按钮。当前小说没有历史时，打开侧栏直接显示新会话输入界面。右上角 `+` 打开同一个界面，首次发送时才创建会话记录。
- 历史搜索只匹配当前小说的会话名称，占位文案改为「按会话名称查找」。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `background-agent-harness` 的侧栏入口、空历史时的打开行为、新会话创建时机和历史搜索。

## Impact

- 渲染层的 `src/main.tsx`、`src/Harness.tsx`、`src/runtime.ts` 和 `src/styles.css`。
- 新会话首次发送时复用现有 `session.create` 和 `session.start`。
- 桌面测试覆盖直接进入输入界面、首次发送、会话历史和按名称搜索，并更新受入口变化影响的测试。
