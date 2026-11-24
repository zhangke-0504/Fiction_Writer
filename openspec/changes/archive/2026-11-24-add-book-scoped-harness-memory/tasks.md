## 1. Editor scope and profile reuse

- [x] 1.1 Scope editor RPC snapshots, visible sessions, and keyboard/panel lifecycle by book ID; derive stable titles from persisted author input without interrupting runs.
- [x] 1.2 Exercise one application-level profile in multiple books and across desktop restart; exercise editor/library/settings and session ownership in the desktop suite.

## 2. Persistent book memory

- [x] 2.1 Implement bounded, atomic book-local storage and revision-aware lexical recall, including timeline boundaries and invalidation after manual/external writes or deletion.
- [x] 2.2 Wire automatic and explicit recall plus author-controlled convention updates into the Agent, and evidence with revision guards into actual prose generation.
- [x] 2.3 Verify deep historical recall in a new session, isolation, edit/delete invalidation, future chapter exclusion, and cancellation with fixtures.

## 3. Session compaction and tool receipts

- [x] 3.1 Add append-only private journal entries for compaction checkpoints and bounded actual-execution results, preserving existing history and continuation offsets.
- [x] 3.2 Project bounded provider history; compact past messages and old tool cycles while retaining author constraints, skill/progress information and recent native call/result pairs. Bound failures without replay.
- [x] 3.3 Force compaction in fixtures and verify restart, native protocol round-trips, and accurate receipts for success/failure/commits.

## 4. Delivery

- [x] 4.1 Document operator behavior, memory limits and local manual verification. Build the desktop app and run type checking, tests and strict OpenSpec validation.
