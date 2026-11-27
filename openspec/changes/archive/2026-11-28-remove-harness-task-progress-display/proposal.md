## Why

Harness 用同一张进度卡展示整书章数、局部动作和资料同步的核对计数。相同的 `X/N` 在不同请求里含义不同，容易让作者把固定规则算出的数字理解成本轮交付进度。

## What Changes

- 撤掉 Harness 的任务进度卡，覆盖资料准备、单章、局部增补、整书、混合请求及旧会话重开。去掉新生成的系统结果文案中的固定进度比例。
- 在现有运行状态中显示已核对的结果及可定位的待办或阻碍，继续提供工具活动、停止操作和适用的诊断编号。
- 保留内部目标核算、写入回执、`taskOutcome` 和同会话续办所需的剩余事项。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `background-agent-harness` 的任务结果和工具活动展示改为按终态报告已核对的结果，取消任务进度卡。

## Impact

- `src/Harness.tsx` 和 `src/styles.css` 负责移除卡片和呈现终态。
- `electron/agent/novel-tools.ts` 的新生成整书及旧确认方案兼容路径的失败文案改为直接报告阻碍。
- 桌面回归覆盖运行中、收尾、旧会话重开和同会话续办。变更范围为 Harness 展示及相关文案，整书意图误登记另行处理。
