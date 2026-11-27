## Context

The source analysis is `design/20261127/harness-whole-book-intent-and-independent-generation.md`; this change deliberately narrows its implementation scope to existing MCP tools and Skills. The whole-book workflow, its goal registration and completion checks, UI, memory, and the top-level `worker.ts` routing prompt remain outside this change.

The current generation paths are asymmetric:

- `book_generate_assets` delegates subject/clue creation and uses `story-assets.ts` to collect a combined context for all requested targets. It already selects outline, asset, and chapter evidence, but associated empty notes can be treated as required and a batch can share evidence across targets.
- Outline prose is composed by the Agent after `book_get_context`, then committed through `book_apply_changes`. The ordinary write path currently requires broad outline/subject/clue reads and revision guards, even when updating only the outline.
- `book_generate_chapter` generates one chapter per call. `chapter-context.ts` discovers context from the outline, chapter text, references, and clue timing, but discovery can become a hard precondition for generation.
- Existing tests cover portions of asset and chapter context behavior. They do not constitute the requested independent empty-book and single-versus-batch material matrix.

The existing stable-ID, actual-write, revision, reference, chapter-boundary, and foreshadowing visibility protections remain authoritative.

## Goals / Non-Goals

**Goals:**

- Generate each of subject, unanchored clue, outline, and chapter prose without first generating another material category.
- Include relevant existing sources in the actual model request for both single-target and batch generation.
- Keep context attributable to the target it supports; distinguish optional evidence from evidence the author explicitly made necessary.
- Avoid conflicts caused only by unrelated material changing, while keeping optimistic concurrency for the target and sources actually used.
- Verify the behavior through tool-level tests and a deterministic Harness IPC fixture that observes generation requests and persisted results.

**Non-Goals:**

- Change which natural-language requests the top-level Agent classifies as whole-book work; alter `worker.ts` or add a routing model, keyword router, or approval step.
- Change the whole-book goal contract or use whole-book progress as the completion test for a local request.
- Add four new MCP endpoints, a mixed-kind asset batch endpoint, a chapter batch endpoint, a new workflow state machine, or UI.
- Make every discovered link mandatory, remove validation for explicit IDs, weaken saved-document revision checks, reveal future clue facts, or claim scripted fixtures prove real-model quality.

## Decisions

### Reuse the existing tool surfaces; keep orchestration in Skills

The existing tool boundaries already represent the four output types: `book_generate_assets` for subject/clue descriptions, `book_apply_changes` for outline text, and `book_generate_chapter` for one chapter at a time. Clarify their descriptions and execution behavior, and align `generate-novel`, `write-chapter`, and where useful `story-consistency`. Skills guide selection and sequencing; tools remain the authority for write scope, valid identities, required evidence, and commit outcomes. This avoids a second API surface with parallel validation rules.

**Alternative rejected:** introduce one generation tool per artifact or a generic mixed-artifact generator. That duplicates existing contracts and makes write receipts and scope harder to interpret.

### Build context per target and preserve provenance

For each generated target, select only related, usable material using existing workspace relationships, IDs, outline anchors, chapter anchors, and bounded textual relevance. Represent selected context with source type, ID, revision, and any excerpt range, and associate it with the target it supports. Asset batches remain same-kind and within the existing limit; each target gets its own source association inside the existing model call. A later chapter call in a multi-chapter Run may use an earlier chapter only after the earlier tool call actually commits it.

A source is not considered “used” merely because it exists in `book_get_context` or appeared in an index. The integration fixture must observe it in the actual asset lane or Agent request that composes the outline, then verify the saved target. Do not add an eager whole-book pre-read solely to prove linkage.

**Alternative rejected:** pass one union of every batch member's evidence to every target. It is simpler but increases cross-target contamination and makes per-target context assertions impossible.

### Separate optional discovery from author-required evidence

An automatically discovered relation, due clue, text hit, or tool-selected ID is a candidate source, not by itself an author requirement. Missing, empty, irrelevant, or unsafe optional material is omitted without blocking generation. If the current author explicitly requires a fact or source and that evidence cannot be verified or safely included, do not pretend the constraint was met; return the existing precise issue/failure. Determine this conservatively from a plainly named source in the current author text, not from the Agent’s proposed arrangement, scope purpose or history. Unclear intent stays optional; it is not a new classification request or preflight. Do not add a model-controlled `requiredIds` mechanism.

For chapter prose, apply the existing stage-aware clue visibility policy to all candidate sources, including outline excerpts, note excerpts, and recalled text. A setup chapter may receive the visible clue and action without the protected payoff proposition. Keep real invalid-reference and target-revision validation.

**Alternative rejected:** make all discovered dependencies optional by deleting context checks. That would hide genuine author constraints and could submit prose based on stale or invalid references.

### Narrow outline write dependencies to the actual target and selected sources

Keep outline composition in the normal Agent path and preserve `book_apply_changes` for the write. Its current outline planning and submit guards should require the outline target's current revision plus any source documents actually used for this candidate, rather than requiring every subject/clue to be read and guarding unrelated documents. The Agent cites the sources it used with existing Markdown links. The tool guards cited revisions actually delivered by `book_get_context` even if only a slice was read. An unread reference alone does not force a read or replace existing workspace reference handling, and the tool does not try to infer hidden dependencies from free text. Do not generate placeholder chapters just to make a link valid.

**Alternative rejected:** remove all pre-read and revision checks from `book_apply_changes`. That would allow stale overwrite of an existing outline or unchecked references.

### Verify independently at the tool and Harness layers

Use unit tests for source selection, optional-versus-required context, visibility, batch isolation, and revision guards. Add a local Harness IPC fixture using a scripted provider for four empty-book cases, seeded single-target cases for each output type, native asset batches, and a multi-call chapter sequence. Assert the actual request, target-specific sentinel usage, exact successful writes/revisions, unchanged unrelated documents, and no local whole-goal activation. Retain existing whole-book tests separately as non-regression coverage.

A scripted fixture proves deterministic routing, context delivery, tool receipts, and filesystem outcomes. It does not prove that an external model will obey arbitrary instructions; any live-provider quality smoke remains opt-in and is not a replacement for these tests.

## Risks / Trade-offs

- **[Batch evidence crosses targets]** → Keep an explicit target-to-source association in the internal request representation and test with two targets carrying distinct, non-overlapping sentinel sources.
- **[An optional source is mistaken for a hard prerequisite]** → Test absent and blank auto-discovered documents, alongside an explicit-author-constraint negative case that must remain blocked.
- **[Relaxed guards permit stale writes]** → Retain target revision checks and add guards only for source revisions actually included in the generated candidate; test an included-source change and an unrelated-source change separately.
- **[Chapter context reveals a future payoff]** → Keep stage-aware redaction as the last filter after context selection and assert protected sentinel absence in the actual chapter request.
- **[Tests pass without real model comprehension]** → Assert transport-level source delivery and deterministic fixture output separately; describe live quality as outside default CI.
- **[Top-level routing still has whole-book-specific guidance]** → This change does not edit `worker.ts`; keep natural-language route changes out of its acceptance claims. The MCP scope and goal tools must continue to reject unauthorized whole-goal writes and allow valid local operations.

## Migration Plan

No on-disk document migration is needed; tool parameter shapes and persisted Markdown formats are unchanged. A clue can be saved before its schedule is known. Whole-book settlement still requires valid anchors and can reuse that same saved clue after binding. Implement the tool-side context changes, align Skills, and add the regression matrix. If a regression appears, revert the changed tool/Skill behavior; existing documents remain readable and the existing whole-book path remains available.

## Open Questions

- The existing selector should be preserved as the initial relevance policy. If fixture results show that meaningful relations are missed, refine bounded relationship/text selection without turning all book contents into required context.
- `book_generate_chapter` has no batch endpoint. Acceptance should describe “batch chapters” as successive calls within one authorized Run, not as one atomic tool call.
