## ADDED Requirements

### Requirement: Compact tool activity in Harness conversations

Harness SHALL render each contiguous group of tool activity messages as one collapsed-by-default disclosure in the conversation. Expanding the disclosure SHALL show the individual tool activity messages and their outcomes in their original order. User messages, assistant-visible text, progress, run status, and errors SHALL remain independently visible and in their original chronological positions. Older sessions containing text-only tool activity messages SHALL remain readable and eligible for grouping without a history migration.

#### Scenario: Review a run with consecutive tool activity
- **WHEN** a Harness conversation contains several consecutive tool activity messages followed by assistant-visible text
- **THEN** the tool activity appears as one collapsed summary, and the assistant text remains a separate visible message after it

#### Scenario: Expand tool activity details
- **WHEN** the author expands a grouped tool activity summary
- **THEN** the individual tool activity messages and success or failure outcomes are visible in their saved order

#### Scenario: Read an older session
- **WHEN** the author opens a session saved before grouped tool activity is introduced
- **THEN** existing text-only tool activity messages can be grouped and expanded without changing the saved session or hiding other messages

#### Scenario: Preserve non-tool conversation content
- **WHEN** tool activity is adjacent to progress, run status, an error, a user message, or assistant-visible text
- **THEN** those items remain independently visible and retain their chronological positions relative to the tool activity group
