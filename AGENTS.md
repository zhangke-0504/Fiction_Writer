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

Use the [README](README.md) to locate logs and the [logging spec](openspec/specs/local-diagnostic-logging/spec.md) and [event contract](electron/diagnostics/contract.ts) to interpret events. Keep diagnostics local and allowlisted; never attach raw logs, credentials, or manuscript text.

- Trace a rejected start by `requestId`, an accepted run by `runId`, a tool by `callId`, and a model request by `spanId`. A tool candidate or a finished run does not prove a write; verify the tool receipt and `workspace.document.committed`.
- For a stale editor view, match backend commits and frontend rereads within the same `workerId` using `changeId`, `journalSeq`, and revision fingerprints. A newer snapshot alone does not prove a dropped notification.
- For missing writing context or output limits, compare `writing.context.*`, `model.budget_dispatched`, and `model.finished` as applicable. Use `model.arguments_retry` or `model.output_limit_recovery` to link retries to their original request; retries have distinct `spanId` values. Dispatch is not proof of upstream receipt or model adoption.

## Commits and Pull Requests

Use short, imperative subjects without prefixes, matching `Fix first skill budget and narrow output-limit recovery`. In PRs, explain what changed and why, list validation run, link related issues or OpenSpec changes, and include screenshots for visible UI changes. Do not commit credentials, manuscripts, or raw diagnostics.
