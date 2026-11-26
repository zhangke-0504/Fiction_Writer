# Fiction Writer

[简体中文](README.md) · English

Fiction Writer is a local Markdown editor for writing novels on Windows. You can write offline without setting up an AI model.

## Features

- **Novel library:** Manage multiple novels and organize characters, objects, scenes, foreshadowing notes, and outlines.
- **Chapter editor:** Write in Markdown one chapter at a time. Your manuscript is saved as local files.
- **Optional AI writing assistant (Harness):** Discuss plot ideas, organize story details, or draft chapters and entire novels. Each novel has its own sessions and memory.

## Quick Start (Windows)

Install Node.js 24, then run these commands from the project directory:

```powershell
npm ci
npm run dev
```

This builds and launches the Electron desktop app. No separate web server is needed. In the library, click **New Novel** (`新建小说`), enter a title and synopsis, then click **Edit** (`编辑`) to open the workspace. Create a chapter to start writing, and press `Ctrl+S` to save.

**Want to try the AI assistant?** In **Settings** (`设置`), add a model profile with a name, API key, provider base URL, and model ID. Do not include a specific endpoint path such as `/chat/completions` in the base URL. Save the profile, open a novel's workspace, and press `Ctrl+Alt+I` to open Harness. Try asking, “Draft chapter one from the outline.”

Your novels are stored under `Fiction_Writer/library` in your Windows Documents folder. To back up or move a novel, copy its entire folder. Model profiles and session history are stored separately and do not transfer with the novel.

See [AGENTS.md](AGENTS.md) for development and contribution guidelines.

## Acknowledgments

Thanks to the maintainers and contributors of these open-source projects:

- [Pi](https://github.com/earendil-works/pi): The Harness agent loop uses the Pi SDK. We also took cues from how Pi summarizes older context while keeping recent messages and skips truncated tool calls.
- [OpenCode](https://github.com/anomalyco/opencode): Its separation of run state from events informed the early Harness design.
- [Hermes Agent](https://github.com/NousResearch/hermes-agent): Its use of memory size limits and atomic writes informed how we store book-scoped memory.
- [OpenClaw](https://github.com/openclaw/openclaw): Its separation of candidate evidence from established long-term memory informed book-scoped memory. Its distinction between bounded continuation and resending the same request also informed output-limit recovery.
- [OpenAI Codex](https://github.com/openai/codex): Harness took cues from how Codex distinguishes incomplete model responses from transport retries, budgets tool results separately, and waits for delegated tasks when needed.
- [CC Switch](https://github.com/farion1231/cc-switch): Its provider grouping and two-step flow informed how we add model profiles: choose a preset or the custom option, then fill in the settings.

## Buy me a coffee

If you enjoy using Fiction Writer, feel free to scan the WeChat Pay QR code below and buy me a coffee. Thanks for your support!

<p align="center">
  <img src="docs/assets/wechat-pay.png" alt="WeChat Pay QR code to buy me a coffee" width="360" />
</p>
