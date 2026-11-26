## Context

The Harness transcript renders each saved `ChatLine` directly. Tool execution currently adds separate text-only messages for tool start and completion. A multi-step run therefore fills the narrow 300–380 px side panel with rows that are useful for inspection but less important than the author and assistant conversation. Existing session logs persist these messages without tool call IDs, and the assistant's visible narration is saved as ordinary assistant messages.

The user selected a compact display of tool activity. Assistant-visible narration remains in the conversation at its chronological position. Provider-native reasoning is outside the scope of this change.

## Goals / Non-Goals

**Goals:**
- Reduce transcript height by collapsing consecutive tool activity messages into one compact summary.
- Keep individual tool activity and outcomes inspectable in chronological order.
- Render existing sessions without migration.
- Keep assistant and author messages, progress, run status, and errors visible in context.

**Non-Goals:**
- Hide or group assistant-visible narration.
- Change model reasoning or provider request handling.
- Change tool execution, persistence, task outcome, or progress semantics.
- Redesign the session header, composer, or overall Harness panel.

## Decisions

- Build a display projection from the existing ordered `ChatLine[]` in the renderer. Group consecutive entries with `role: 'tool'` and render every other message independently. This preserves the existing transcript sequence while keeping the change local to presentation.
- Use a native disclosure control, collapsed by default, with a concise summary that conveys the amount of tool activity and any available unsuccessful outcome. The expanded region renders the original tool messages in order.
- Do not add persisted IDs or migrate session logs. Older entries already identify tool activity by role, so consecutive tool messages can be grouped without interpreting their text as a new data schema.
- Keep progress, run status, errors, user messages, and assistant-visible text outside disclosures. They continue to occupy their current positions in the transcript.

## Risks / Trade-offs

- Consecutive tool messages may come from several calls, while the persisted format has no call IDs. Grouping them as one activity disclosure intentionally summarizes the contiguous block rather than claiming exact call boundaries.
- A collapsed row makes detailed outcomes less prominent. The summary must surface unsuccessful activity, and opening the disclosure must reveal all original entries.
- Activity currently in progress can have an unmatched start entry. The summary must not imply completion when the saved activity has no completion entry.

## Migration Plan

No data migration is required. The renderer reads both existing and new sessions from the existing message representation.

## Open Questions

None.
