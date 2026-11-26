# Repository Guidelines

## Project Structure

Fiction Writer is a Windows-first Electron app for editing Markdown novels. The editor runs without a model configuration; the optional Harness handles AI-assisted writing.

- `src/`: React renderer, CodeMirror editor, and CSS. Use the typed bridge in `src/bridge.ts` for desktop operations.
- `electron/`: main process, preload, background worker, and local storage. Harness logic lives in `electron/agent/`; `shared/` defines cross-process contracts and RPC types.
- `skills/`: shipped writing prompts and workflows. `openspec/specs/` records expected behavior; `openspec/changes/` tracks changes and archives.
- `tests/`: Node regression tests and Playwright desktop tests under `tests/e2e/`. `design/` is ignored and contains local references, not shipped assets.

## Behavior References

Check the relevant OpenSpec before changing behavior:

- [Markdown novel workspace](openspec/specs/markdown-novel-workspace/spec.md): library storage, editing, and file changes.
- [Background Agent Harness](openspec/specs/background-agent-harness/spec.md): model profiles, sessions, tool execution, and request recovery.
- [Novel writing workflows](openspec/specs/novel-writing-workflows/spec.md) and [book-scoped memory](openspec/specs/book-scoped-memory/spec.md): generation, editing, resume behavior, and evidence from the current manuscript.

## MVP Scope: Writer MCP Tools

Keep the Harness loop moving: do not add validation gates, sandboxing, or human-in-the-loop (HITL) approvals to Writer MCP tools during the MVP. Revisit these measures no earlier than May 26, 2027.

## Build and Development

Use Node.js 24 as documented in the [README](README.md).

- `npm ci` installs locked dependencies.
- `npm run dev` builds and launches Electron; no separate web server is needed.
- `npm run build` compiles Electron to `dist-electron/` and bundles the renderer to `dist/`. `npm start` launches the existing build.
- `npm run typecheck` checks both TypeScript projects without emitting files.

## Coding Style

Use strict TypeScript, two-space indentation, single quotes, and LF line endings. Match `.prettierrc.json` (105-column print width); check touched files with `npx prettier --check <paths>`. Use PascalCase for React component filenames (`MarkdownEditor.tsx`) and kebab-case for multiword backend modules (`chapter-patch.ts`). Keep `.js` on relative imports in Electron's NodeNext modules.

## Testing

Add a regression test for changed behavior. Prefer temporary libraries and scripted providers or local protocol fixtures; fixture success does not verify a real gateway.

- `npm test` runs `tests/*.test.ts` with Node's test runner via `tsx`.
- `npm run test:e2e` builds and runs `tests/e2e/*.spec.ts` in isolated Electron instances. App windows are hidden by default; set `$env:FW_E2E_SHOW_WINDOW = '1'` in PowerShell only when you need to observe the UI.
- `openspec validate --all --strict` validates specs; run it when editing specs.
- `npm run test:deepseek -- --live` is an opt-in smoke test against the official DeepSeek API. It reads `design/ds_config.txt`, sends synthetic requests, and may incur charges. Do not run it as part of normal validation.

A backup provider configuration is available locally at `design/20261123/ds_config.txt`. Both provider configuration files are ignored by Git; do not commit them or copy their contents into issues, PRs, or logs.

## Harness Diagnostics

Search logs in the environment where the error occurred. Logs stay on the local machine, in `logs` under Electron's `app.getPath('userData')` (typically `%APPDATA%\fiction-writer\logs` on Windows). The app writes `frontend-YYYY-MM-DD.jsonl` and `backend-YYYY-MM-DD.jsonl` for each local day and keeps today plus the previous 29 days. It does not prune while closed; a hard crash can lose unflushed records.

Paste the diagnostic ID from the Harness error into this PowerShell query to search both daily log streams:

```powershell
$logDir = Join-Path $env:APPDATA 'fiction-writer\logs'
$id = 'paste-diagnostic-id-here'
Get-ChildItem -LiteralPath $logDir -File |
  Where-Object { $_.Name -match '^(frontend|backend)-\d{4}-\d{2}-\d{2}\.jsonl$' } |
  Select-String -SimpleMatch $id
```

Use the [logging spec](openspec/specs/local-diagnostic-logging/spec.md) and [event contract](electron/diagnostics/contract.ts) to interpret events. Share only the diagnostic ID and reviewed events needed for triage; do not post raw logs, credentials, provider configurations, or manuscript text.

- **Runs and writes:** A rejected start has a `requestId`; an accepted run has a `runId`. Use the `requestId` in `run.started` to find events preceding the accepted run. Follow a tool by `callId` and a model request by `spanId`. A tool candidate or a finished run does not prove a write; verify the tool receipt and `workspace.document.committed`.
- **Scoped follow-up:** Within the same `runId`, find the registration call and `writing.task_scope`. On each chapter patch `callId`, match `chapter.patch.review` and `model.finished` by review `spanId`; `hasVisibleText` describes the reply, not the verdict. No review event can mean the patch was blocked earlier. For asset writes, distinguish schema rejection (`tool.rejected`) from unsupported routing (`tool.finished` with `asset_update_route`) and inspect `asset.patch.finished` for scope, evidence, or revision failures. Compare same-call commit and result revision fingerprints, then check the tool receipt against the current document revision. `writing.task_result` can be `partial` even when the run ends normally.
- **Editor updates:** Match backend commits and frontend rereads within the same `workerId` using `changeId`, `journalSeq`, and revision fingerprints. A newer snapshot alone does not prove a dropped notification.
- **Book memory:** Find `memory.recall.finished` by `runId`, then `memory.context.dispatched` by `recallId`. Use `spanId` to compare `memory.context.source` with `model.http`. A recall is not a dispatch; dispatch means handoff to transport, not provider receipt or model adoption. Missing logs do not prove there was no dispatch.
- **Long manuscript reads:** Match `model.budget_dispatched` (estimated input and requested output limit) with `context.projected` (estimated reread size and projection counts for the current turn and retained history) by `runId` and `spanId`. The `delivery` field on `tool.result_sent` distinguishes full and projected results; `tool.result_omitted` means the result was not sent.
- **Request failures:** For missing writing context or output limits, compare `writing.context.*`, `model.budget_dispatched`, and `model.finished` as applicable. On Chat, `model.finished` with `providerStop: output_limit` is an explicit length stop; `incomplete_stream` alone is not. Local timeouts and cancellation have separate reasons. Chat does not use the Messages continuation path. Use `model.arguments_retry` or `model.output_limit_recovery` to link retries to the original request; each retry has a distinct `spanId`.

## Commits and Pull Requests

Use short, imperative subjects without prefixes, matching `Fix first skill budget and narrow output-limit recovery`. In PRs, explain what changed and why, list validation run, link related issues or OpenSpec changes, and include screenshots for visible UI changes. Do not commit credentials, manuscripts, or raw diagnostics.
