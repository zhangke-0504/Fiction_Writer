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
