# Pi SDK probe

Verified on Windows with Node 24, `@earendil-works/pi-coding-agent@1.6.0` and a loopback SSE fixture. The SDK used `/gateway/v1/chat/completions` unchanged, executed only the supplied tool, emitted stream/tool events, returned `reasoning_content` on continuation, and independently aborted a second session. Reproduce by copying `pi-sdk.mjs` into an isolated npm directory that has the specified coding-agent package installed and running `node pi-sdk.mjs`. The fixture does not use a real key or execute shell commands.

The application embeds `pi-agent-core` rather than the coding-agent SDK's resource loader, CLI built-ins, model catalog or session storage. The host owns the model protocol adapters and feeds completed calls into the core. This preserves one application write path, per-run provider state, and independently durable sessions.
