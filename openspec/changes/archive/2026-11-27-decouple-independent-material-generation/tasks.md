## 1. MCP tool context and write boundaries

- [x] 1.1 Align the existing subject/clue, outline, and chapter tool descriptions with independent generation, optional versus author-required evidence, and actual-write result semantics; do not add endpoints or change top-level Agent routing.
- [x] 1.2 Refine asset context selection so single and same-kind batch generation associate relevant, usable, versioned sources with each target instead of treating the batch-wide context union as applicable to every target.
- [x] 1.3 Separate chapter-context discovery from mandatory evidence checks; omit missing, blank, unrelated, or stage-unsafe optional references while preserving explicit author constraints, clue visibility, and target/source revision protection.
- [x] 1.4 Narrow independent outline reads and commit guards to the outline target and source revisions actually used; retain stable-reference and current-target validation.

## 2. Align writing Skills

- [x] 2.1 Update the relevant Skills to explain how to independently generate each requested material type, find and reuse relevant existing sources, avoid generating prerequisites, and verify the saved result.
- [x] 2.2 Clarify native batch boundaries: same-kind subject/clue batches remain bounded, outline remains one document, and chapter prose uses sequential one-chapter tool calls; preserve separate whole-book guidance.

## 3. Add independent, linked, and batch regression coverage

- [x] 3.1 Add empty-book Harness scenarios for subject, unanchored clue, outline, and chapter prose; verify actual tool dispatch and only the requested target writes, allowing only the chapter catalog prerequisite for a new chapter.
- [x] 3.2 Add seeded single-target cases for each output type; capture the actual generation request and assert relevant subject, clue, outline, or prose evidence is included with current provenance, while unrelated and unsafe content is omitted.
- [x] 3.3 Add same-kind subject and clue batch cases with distinct target-source relationships; assert target-specific context, no cross-target evidence substitution, valid references, and per-target saved revisions.
- [x] 3.4 Add an authorized sequential multi-chapter case; assert each call writes its own chapter and later calls use only earlier prose that was actually committed.
- [x] 3.5 Add negative cases for blank optional sources, an unavailable explicitly required source, included-source revision changes, unrelated-source changes, invalid references, and unrevealed clue payoff; verify correct continuation, blocking, conflict, or redaction without false completion.
- [x] 3.6 Verify the local IPC path records Skill application only when dispatched, correlates tool call receipts with committed documents and current disk revisions, and does not activate a whole-book goal for local generation; retain existing whole-book suites as independent regression coverage.

## 4. Validate

- [x] 4.1 Run focused unit tests, the new or affected Harness IPC E2E tests, `npm run typecheck`, `npm test`, Prettier checks for touched files, and `openspec validate --all --strict`.
