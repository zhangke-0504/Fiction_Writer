## Context

The worker already gives the main Agent a session-specific tool catalog with on-demand discovery. A public web query can use that catalog and return through the existing tool loop.

## Goals / Non-Goals

**Goals**

- Search with DuckDuckGo and read a public URL during a Harness session.
- Give the main Agent bounded source text and links for a final answer.

**Non-Goals**

- User-provided search credentials, search-provider settings, and changes to chapter generation.

## Decisions

- Run both tools in the worker using Electron's network stack so requests follow the operating system's proxy settings. Search uses DuckDuckGo's HTML form. Page reads take a URL from the model and request that page directly.
- Parse HTML and return compact text with source metadata. Reuse the tool executor, turn history, and result limits.
- Keep web research discoverable as read-only and use the existing Session input. The main Agent chooses search, page reading, or both based on the author request.

## Risks / Trade-offs

- DuckDuckGo can limit requests or return a challenge. Return a tool error the Agent can explain. A successful search can also return no matches.
- Some sources rely on scripts, authentication, or formats the reader cannot extract. Return a bounded result or an actionable tool error.
