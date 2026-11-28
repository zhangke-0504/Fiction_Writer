## Why

Writers need to verify current and historical details from public sources while working in a Harness session. Today they need to collect those references separately and paste or attach them.

## What Changes

- Add discoverable `web_search` and `web_fetch` tools for the main Agent.
- Use DuckDuckGo for searches without requiring an API key. Read a given public page directly.
- Return source links and excerpts so the Agent can give a sourced answer in the session.

## Capabilities

### New Capabilities

### Modified Capabilities

- `background-agent-harness` gains public web search and page reading in the existing tool loop.

## Impact

The Electron worker executes the network requests and makes bounded results available to the model. Authors use the existing Harness composer and model configuration.
