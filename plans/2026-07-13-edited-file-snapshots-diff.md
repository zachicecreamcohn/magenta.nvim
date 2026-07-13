# Objective and Context

Verbatim request: "When the assistant uses an edl script to change a file during the assistant's turn, I'd like to record a previous snapshot of it. So when we display a 'files changed this turn' message, we can expand that message to show a diff of the change, and we can press <CR> on the message to bring up the snapshot and the current file in a nvim diffsplit (there's already helpers for this I believe)."

We already track `editedFilesThisTurn` and render a "Files edited this turn:" summary. We want, per edited file, to also retain the file's content as it was *before the turn's first edit* to that file. Then:

- Pressing `=` on a file row expands an inline unified diff (snapshot vs. current content).
- Pressing `<CR>` on a file row opens the snapshot and the live file side-by-side in a neovim diffsplit.

## Key entities and files

- `node/core/src/thread-core.ts` — holds `state.editedFilesThisTurn` (declared ~line 204, initialized ~266, populated in `onToolApplied` ~758-761, reset ~494 and ~993). The snapshot lives directly on the entries of this structure, since it is populated and reset in exactly the same places the snapshot needs to be.
- `node/core/src/capabilities/context-tracker.ts` — `ToolApplied` union; the `edl-edit` variant currently carries only `{ content }`. `OnToolApplied` signature.
- `node/core/src/tools/edl.ts` — `execute()` iterates `result.data.mutations` and fires `onToolApplied` with the final `content`.
- `node/core/src/edl/executor.ts` — `getOrLoadFile()` reads the original file content into a `Document`; `execute()` builds the `mutations`/`fileContents` maps returned from the run. Original content is available here but not currently surfaced.
- `node/core/src/edl/index.ts` — `runScript()` orchestrates and shapes `ScriptResult`/`mutations` returned to the tool.
- `node/chat/thread-view.ts` — `editedFilesSummaryView()` (~306) renders the summary and binds `<CR>` → `open-edit-file`.
- `node/chat/thread.ts` — `Thread.state` (root-layer view state), `Msg` union, and the message handler (`open-edit-file` at ~837).
- `node/nvim/openFileInNonMagentaWindow.ts` — `openFileInNonMagentaWindow`, `openScratchInNonMagentaWindow`, `findOrCreateNonMagentaWindow`.
- `node/nvim/nvim.ts` — `diffthis(nvim)` wrapper (currently unused).
- `node/core/src/context/context-manager.ts` — reference pattern: uses `diff.createPatch` and an expand/`=` + `<CR>` binding pattern in `renderContextUpdate` we can mirror.

# Design

## Capturing the snapshot

The snapshot we want is the file content immediately before the turn's first edit to that file. The EDL executor already reads the pre-edit content when it loads a file, but writes to disk during `execute()`, so by the time `onToolApplied` fires the on-disk "before" content is gone. Therefore the original content must be threaded out of the executor.

Data flow for the "before" content:

1. `executor.getOrLoadFile()` stores the initially-read text on `FileState` (e.g. `originalContent`). For a newly-created file this is `""`.
2. `executor.execute()` returns an additional per-file map of original contents (alongside `fileContents`).
3. `runScript()` (edl/index.ts) surfaces `previousContent` on each entry of `result.data.mutations`.
4. `tools/edl.ts` passes `previousContent` into the `edl-edit` `ToolApplied` variant.
5. `context-tracker.ts` `ToolApplied` `edl-edit` variant gains `previousContent: string`. `ContextManager.toolApplied` ignores it (no behavior change there).
6. `thread-core.ts` `onToolApplied`: change `editedFilesThisTurn` from `AbsFilePath[]` to `{ path: AbsFilePath; snapshot: string }[]`. On the first edit to a file this turn (the existing `!includes` check, now `!some(e => e.path === absFilePath)`), push `{ path: absFilePath, snapshot: previousContent }`. Subsequent edits to the same file are skipped, so the snapshot stays at pre-turn state. No separate map is introduced — the snapshot rides on the existing entry, inheriting its populate/reset lifecycle for free.

No new state structure is needed: the snapshot becomes a field on each `editedFilesThisTurn` entry. Its lifecycle is therefore identical to that array by construction — reset only in the two existing sites (`sendMessage` start ~993 for a new user turn, and `reset-after-compaction` ~494), and never on intra-turn handoffs such as tool-call → tool-response round-trips. Note this changes the element type, so every reader of `editedFilesThisTurn` (the view at `thread-view.ts:447` and tests in `thread-core.test.ts`) must be updated to read `.path` / `.snapshot`.

## Displaying the diff (expand with `=`)

Add root-layer view state `editedFilesExpanded: { [path: AbsFilePath]: boolean }` to `Thread.state` and a `toggle-edited-file-expanded` message. In `editedFilesSummaryView`, for each file:

- Bind `=` → toggle expansion; `<CR>` → new diffsplit message (below).
- When expanded, compute an inline unified diff with `diff.createPatch(displayPath, snapshot, currentContent)` and render it beneath the row, mirroring `renderContextUpdate`'s expandedBody. Current content is read from the live buffer/file; simplest is to read via existing file-read path in the view's context, or pass current content through. (Prefer reading current on-disk content lazily inside the handler/view helper; the snapshot comes from the matching `editedFilesThisTurn` entry's `.snapshot`.)
- Optionally show a `[ +N / -M ]` change indicator computed from the patch, matching the context-update style.

## Diffsplit on `<CR>`

This helper existed before and was deleted in commit `1cd61f04` as `displaySnapshotDiff` (was in `node/tools/display-snapshot-diff.ts`, alongside a `node/tools/file-snapshots.ts` snapshot store — both removed). Recover and adapt it rather than writing a new one. Its shape:

- Close all non-magenta windows (preserving magenta windows so their widths can be restored afterward).
- `bufadd` the real file and open it in a global `split: "right"` window, then `diffthis(nvim)`.
- Create a scratch buffer (`NvimBuffer.create(false, true, nvim)`, `bufhidden=wipe`), set its lines to `snapshot.split("\n")`, name it distinctively, open it in a `split: "left"` window relative to the file window, then `diffthis(nvim)`.
- Restore magenta window widths.

Adaptation needed: the original pulled content from a `FileSnapshots`/`Turn` store; here the snapshot string comes directly from the `editedFilesThisTurn` entry, so drop the `fileSnapshots`/`turn` params and pass the snapshot content in. Place it in a sensible module (e.g. next to `openFileInNonMagentaWindow.ts`).

Wire a new `Msg` variant (e.g. `open-edit-file-diff` carrying `filePath` and the snapshot string) dispatched from the summary view's `<CR>`, handled in `Thread`'s message switch by calling the recovered `displaySnapshotDiff`-style helper. Replace the current `open-edit-file` binding in `editedFilesSummaryView` with this.

Invariants:
- The snapshot is stored on the `editedFilesThisTurn` entry, so it is reset with it (new user turn / compaction only, never on tool-call→tool-response handoffs) and can never diverge from the tracked-file set.
- A snapshot for a file is written exactly once per turn (first edit), so it reflects pre-turn content even across multiple edits.
- New-file creations yield an empty-string snapshot, producing an all-additions diff.
- Threading `previousContent` through must not change `ContextManager` diffing behavior.
- The snapshot must be captured at the moment just *before* the edit is applied — i.e. the content `getOrLoadFile` reads before `execute()` writes to disk — not re-read afterward. This is the whole reason `previousContent` is threaded out of the executor rather than read from disk in `onToolApplied`.

Alternatives considered:
- Reading the "before" content from disk in `onToolApplied` — rejected because the executor has already written the file by then.
- Storing the snapshot in the root layer only — rejected; the edit tracking already lives in core (`editedFilesThisTurn`), so co-locating the snapshot keeps reset logic in one place.

# Stages

## Stage 1: Surface pre-edit content from the EDL executor

**Status: DONE.** `FileState` gained `originalContent` (set in `getOrLoadFile` to the read content; `""` for `newfile`). `Executor.execute()`'s `ScriptResult.fileContents` is now a single `Map<string, { content: string; previousContent: string }>` (per code-review: `content` and `previousContent` are fully parallel and always written together, so co-locating them prevents the two per-path fields from getting out of sync — the separate `originalContents` map was removed). `mutations` stays a separate map because its key set is semantically distinct (only files with actual insertions/deletions/replacements, excluding zero-mutation new files and failed files, which several `executor.test.ts` assertions rely on). `runScript` surfaces `previousContent` on each `EdlResultData.mutations` entry, reading both `content` and `previousContent` from the same `fileContents` entry. Added unit tests in `node/core/src/edl/index.test.ts` (edited existing file reports original content; new file reports `""`). New-file `originalContent` remains `""`; the `FileState.isNew` flag already distinguishes brand-new from empty-existing for any downstream consumer that needs it. Full typecheck, `node/core` tests, and biome all pass.

- Goal: `runScript` results expose each mutated file's `previousContent`; `getOrLoadFile` records original content; new-file case yields `""`.
- Verification (unit, `node/core/src/edl`):
  - Behavior: editing an existing file reports its original content as `previousContent`.
  - Setup: `InMemoryFileIO` seeded with a file; run a script that replaces text.
  - Actions: call `runScript`.
  - Expected: mutation entry's `previousContent` equals the seeded content; `content` equals the edited content. A `newfile` script yields `previousContent === ""`.
- Before moving on: `npx tsgo -b`, `npx vitest run node/core/`, `npx biome check .` pass.

## Stage 2: Thread previousContent into ToolApplied and record snapshots

**Status: DONE.** `ToolApplied` `edl-edit` variant gained `previousContent: string` (context-tracker.ts). `tools/edl.ts` passes `mutation.previousContent` through. `thread-core.ts` `editedFilesThisTurn` is now `{ path: AbsFilePath; snapshot: string }[]`, pushed on first edit per file (via `!some(e => e.path === absFilePath)`) with `snapshot: tool.previousContent`. Readers updated: `thread-view.ts` `editedFilesSummaryView` now takes `{ path; snapshot }[]` and destructures `.path` (the `<CR>` open-edit-file binding is untouched — that changes in Stage 3). Tests updated in `thread-core.test.ts` (snapshot equals pre-edit content; second edit to same file keeps the pre-turn snapshot) and `context-manager.test.ts` (added `previousContent: ""` to `edl-edit` fixtures). Full `tsgo -b`, `node/core` tests (615 passing), and biome all pass.

- Goal: `ToolApplied` `edl-edit` carries `previousContent`; `editedFilesThisTurn` entries become `{ path, snapshot }`, populated on first edit; all readers updated.
- Verification (unit, extend `thread-core.test.ts` "editedFilesThisTurn" block):
  - Behavior: after an edl edit, the entry's `snapshot` holds the pre-edit content; a second edit to the same file does not overwrite it; a new turn clears the array.
  - Behavior: a tool round-trip within the same turn does NOT clear `editedFilesThisTurn` or its snapshots.
  - Setup: existing test harness applying an edl edit.
  - Actions: apply edit(s), then start a new message.
  - Expected: snapshot equals original content; unchanged after second edit; `{}` after reset.
- Before moving on: type checks, tests, lint pass.

## Stage 3: Expand-to-diff and diffsplit in the view

**Status: DONE.** `editedFilesSummaryView` (thread-view.ts) now renders each edited-file row with a `▶`/`▼` marker and two bindings: `=` → `toggle-edited-file-expanded`, `<CR>` → `open-edit-file-diff`. Added `editedFilesExpanded: { [path]: { patch } }` to `Thread.state` and the two new `Msg` variants. The `toggle-edited-file-expanded` handler looks up the matching `editedFilesThisTurn` entry, reads current content (via `readCurrentFileContent`, which prefers an open buffer over disk), computes a unified diff with `diff.createPatch(displayPath, snapshot, current, "snapshot", "current", { context: 2 })`, stores it in state, and re-renders. `open-edit-file-diff` calls a recovered `displaySnapshotDiff` helper. The old `open-edit-file`/`openFileInNonMagentaWindow` binding on the row is replaced by these. Decisions: recovered helper placed at `node/nvim/displaySnapshotDiff.ts`, adapted to take a plain `snapshot` string instead of the removed `FileSnapshots`/`Turn` store. The inline patch is precomputed on toggle (async read) rather than in the sync view. Re-render after async read is triggered via a no-op `turn-ended` dispatch. Test added in `node/chat/thread-edited-files.test.ts` (press `=` → asserts `-hello`/`+bye` diff lines appear; press `=` again → collapses; press `<CR>` → diffsplit). Note: the driver's position-based `triggerDisplayBufferKey` resolved to the wrong "a.txt" occurrence (the edl tool-result summary line), so the test uses `triggerDisplayBufferKeyOnContent("▶ a.txt", ...)` which resolves the binding directly. Full `tsgo -b` and `biome check .` pass. Full `vitest run`: the only failures are pre-existing/environmental flakes (3 context-manager disk-edit tests fail on baseline `main` too; a few nvim-process tests fail non-deterministically across runs) — none involve the edited-files view.

- Goal: `=` expands an inline diff under each edited-file row; `<CR>` opens a snapshot-vs-live diffsplit.
- Verification:
  - Behavior (view/integration): expanding a file row renders a unified diff derived from the snapshot; toggling collapses it.
  - Setup: driver-based thread test (see doc-testing) with a thread that has edited a file this turn.
  - Actions: press `=` on the row; assert diff text appears; press `<CR>` and assert a diff helper is invoked / two diff windows exist.
  - Expected outcome: diff content matches `createPatch`; `<CR>` triggers `openDiffInNonMagentaWindow` (assert via spy or resulting window/buffer state).
- Before moving on: type checks, tests, lint pass.
### Stage 3 code-review follow-ups (DONE)

Addressed review findings:
- Typed `Thread.state.editedFilesExpanded` key as `AbsFilePath` (was loose `string`) in `thread.ts:204`.
- Added a `withDriver()` test in `thread-edited-files.test.ts` asserting the `<CR>` diffsplit layout: a `*_snapshot` scratch window opens containing the snapshot lines with `diff` set, the live `a.txt` window also has `diff` set, and magenta windows are preserved.
- Added a second test covering `readCurrentFileContent`'s open-buffer branch: opening `a.txt` in a non-magenta split with distinct unsaved content and confirming the inline `=` diff reflects the live buffer (`+buffered`) rather than the on-disk `bye`.
- All typechecks (`tsgo -b`), the edited-files tests, and `biome check` pass.
