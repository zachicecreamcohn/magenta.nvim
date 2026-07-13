# Objective and Context

Verbatim user request:

> I'd like to continue working on the thread archive.
>
> I want to be able to delete multiple threads from the archive using a multi-line selection in normal mode, and then pressing d.
>
> I also want to hook up a nicer way to display archived threads, rather than just opening the plain json files. We should extend the plaintext thread rendering (that we currently use for compaction). On <CR> we should open a new buffer for the archived thread, pretty-printing the log.

## What we're building

Two improvements to the existing thread archive view (rendered by `Chat.renderArchive` / `renderArchiveRow` in `node/chat/chat.ts`):

1. **Multi-delete**: while the archive list is shown, the user makes a visual (multi-line) selection over several archive rows and presses `d` to delete all of the selected threads at once. Today only single-row `dd` deletion exists.
2. **Pretty-printed archived thread view**: pressing `<CR>` on an archive row currently opens the raw `conversation.jsonl` file in a plain buffer (`openFileInNonMagentaWindow(threadConversationLogPath(id))`). Instead, we parse the log, reconstruct the message list, render it via the existing compaction plaintext renderer (`renderThreadToMarkdown`), and show that markdown in a fresh scratch buffer.

## Key entities

- `ThreadLogEntry` (`node/core/src/thread-logger.ts`) — discriminated union of JSONL log lines; the `{ type: "message", message: ProviderMessage }` variant carries the actual conversation messages. Also `compaction`, `title`, `thread_start`, `fork`, `restart`.
- `renderThreadToMarkdown(messages: ReadonlyArray<ProviderMessage>): RenderResult` (`node/core/src/compact-renderer.ts`) — existing plaintext renderer; `RenderResult.markdown` is the string we want to display.
- `archive.ts` (`node/core/src/archive.ts`) — `listArchivedThreadIds`, `readThreadMeta`, `deleteArchivedThread`, `threadCreatedAt`. New reader for parsing a thread's log will live here.
- Binding system: `BINDING_KEYS`, `BINDING_MODES`, `BindingCtx`, `getBinding` (`node/tea/bindings.ts`); dispatch/plumbing of visual selections in `lua/magenta/init.lua` (`listenToBufKey`) → `node/magenta.ts` (`magentaKey` handler) → `node/tea/tea.ts` `onKey`.
- `Chat` archive message handlers and rendering (`node/chat/chat.ts`, roughly `archive-*` cases near lines 401-455 and `renderArchive`/`renderArchiveRow` near 1197-1262).
- `openFileInNonMagentaWindow` / `findOrCreateNonMagentaWindow` (`node/nvim/openFileInNonMagentaWindow.ts`) — pattern for placing a buffer in a non-magenta window.

# Design

## Feature 1: multi-delete via visual `d`

The binding infrastructure already supports visual-mode bindings: `F` is registered with `BINDING_MODES = ["n", "v"]`, and on a visual keypress lua captures the selection text and forwards it as `ctx.selection: string[]` (see `listenToBufKey`). `onKey` in tea derives `mode = ctx?.selection !== undefined ? "v" : "n"` and resolves the binding at the cursor position, which — because lua feeds `<Esc>` before reading marks — is the top (`'<`) of the visual selection.

Approach: add a new binding key `d` that is active only in visual mode (`BINDING_MODES["d"] = ["v"]`), attached per archive row alongside the existing normal-mode `dd`. Because `dd` stays normal-only and `d` is visual-only, they never collide on the same node.

When visual `d` fires on a row:
- The resolved row is the topmost selected thread (anchor), giving its `threadId`.
- `ctx.selection.length` gives the number of selected buffer lines. Since each archive row renders as exactly one contiguous line (`renderArchive` emits `${rows}` with no blank separators, each row is `d`- ${date}  ${title}\n``), the number of selected lines equals the number of selected rows.
- Delete `count` threads starting at the anchor's index in the ordered `state.threadIds`: `threadIds.slice(idx, idx + count)`.

This avoids fragile text-matching of titles back to ids; it relies only on row ordering and the one-line-per-row invariant.

Implementation shape:
- Add a new chat message `archive-delete-threads` carrying `ids: ThreadId[]` (or reuse the existing single-delete path in a loop). The handler mirrors `archive-delete-thread`: filter them out of `state.threadIds`, drop their `titles`, and call `deleteArchivedThread` for each (best-effort, error-logged).
- In `renderArchiveRow`, add a `d` binding whose handler computes the anchor index and count and dispatches `archive-delete-threads`.

Alternative considered and rejected: plumbing the raw selection row range through `BindingCtx` and mapping buffer rows to ids via mounted VDOM positions. Rejected as more invasive (touches tea/lua/magenta plumbing) than necessary; the anchor + count approach reuses existing plumbing unchanged.

## Feature 2: pretty-printed archived thread on `<CR>`

We render the whole `conversation.jsonl` — i.e. the `ThreadLogEntry` stream — directly, so that non-message events (compaction, title renames, forks, restarts) appear *inline* in the transcript rather than being filtered out. We do NOT reconstruct a bare `ProviderMessage[]`.

Add a core reader `readArchivedThreadLog(threadId): Promise<ThreadLogEntry[]>` in `archive.ts`:
- Read `threadConversationLogPath(threadId)`, split into lines, `JSON.parse` each non-empty line into `ThreadLogEntry` (best-effort: skip malformed lines; follow the best-effort style already used by `readThreadMeta`, never throwing on missing/corrupt logs).

Do NOT modify or refactor `compact-renderer.ts`. Its output is deliberately terse — it strips thinking blocks, system reminders, and `get_file` contents to give the summarizer just enough to orient. The archive viewer has different goals (a human browsing history who may be looking for anything), so it should render *liberally*.

Create a NEW module `node/core/src/archive-renderer.ts` (a copy-and-expand of the compaction renderer, not a shared refactor):
- `renderThreadLogToMarkdown(entries: ReadonlyArray<ThreadLogEntry>): string`.
- Its own copy of the per-message / content-block rendering, expanded to include things compaction omits:
  - Keep thinking / `redacted_thinking` blocks (rendered, clearly labeled) instead of dropping them.
  - Include full `get_file` result contents instead of `[file contents omitted]`.
  - Render system reminders / system info / context updates / fork notifications rather than blanking them.
  - Preserve tool use inputs and full tool results.
  - Default posture: when in doubt, print it. Only elide truly non-textual blobs (e.g. raw image/document bytes), replaced with a short descriptive placeholder.
- For each entry, dispatch on `type`:
  - `message` → role header + content blocks (liberal rendering above).
  - `compaction` → inline marker, e.g. `--- compaction (N chunks) ---` plus the `summary` when present.
  - `title` → inline marker `# title: "<title>"` so renames are visible in sequence.
  - `fork` → inline marker noting `fromThreadId` / `nativeMessageIdx`.
  - `thread_start` / `restart` → short inline markers.

Duplication with `compact-renderer.ts` is intentional and acceptable here: the two renderers optimize for opposite goals and will diverge, so coupling them via a shared abstraction would be a false economy.

Then in `chat.ts`, replace the `<CR>` handler in `renderArchiveRow`:
- Call `readArchivedThreadLog(threadId)`, run `renderThreadLogToMarkdown(entries)` to get `markdown`.
- Create a scratch buffer (`NvimBuffer.create(false, true, nvim)`), set its lines to `markdown.split("\n")`, set `filetype=markdown` and a readable name, then place it in a non-magenta window via `findOrCreateNonMagentaWindow` (reuse from `openFileInNonMagentaWindow.ts`; export the buffer-placement piece or add a sibling helper `openScratchInNonMagentaWindow(lines, name, context)`).
- On read/parse failure, log via `context.nvim.logger.error` and fall back to (or simply surface the error like) the existing file-open behavior.

Invariants:
- Archive rows render one line each with no interleaved blank lines, so selection-line-count equals selected-row-count. If future changes add blank separators or multi-line rows, the multi-delete count logic must be revisited.
- `state.threadIds` order matches on-screen row order (already true; rows iterate `this.state.threadIds`).
- The new core reader must be best-effort and never throw on missing/partial/corrupt logs (matching `readThreadMeta`/`ThreadLogger` conventions); core layer must not import neovim code.
- Scratch buffers created for archived threads must not be treated as magenta buffers, and the hosting window must have `winfixbuf=false` (already handled by `findOrCreateNonMagentaWindow`).

# Stages

## Stage 1: core log reader + log-stream renderer

**Status: DONE.** `readArchivedThreadLog` added to `archive.ts` (best-effort, `[]` on missing file, skips malformed lines). New `archive-renderer.ts` with `renderThreadLogToMarkdown` renders liberally (keeps thinking, full get_file contents, system reminders/info/context updates) with inline `# title: "..."`, `--- compaction (N chunks) ---` (+summary), `--- fork ... ---`, `--- thread start ---`, `--- restart ---` markers. Exported from `index.ts` (also re-exported `ThreadLogEntry`/`ForkProvenance` types for stage 2). `compact-renderer.ts` untouched. Unit tests added in `archive.test.ts` and new `archive-renderer.test.ts`. Full `npx vitest run node/core/`, `npx tsgo -b`, `npx biome check .` pass.

- Goal: `readArchivedThreadLog(threadId)` in `node/core/src/archive.ts` returns the ordered `ThreadLogEntry[]` from a thread's `conversation.jsonl`, tolerating missing files and malformed lines; and a NEW `renderThreadLogToMarkdown(entries)` in `node/core/src/archive-renderer.ts` renders that stream to markdown liberally, with inline compaction/title/fork/restart markers. Both exported from `node/core/src/index.ts`. `compact-renderer.ts` is left untouched.
- Verification (unit, in `node/core/src/archive.test.ts` and a new `archive-renderer.test.ts`):
  - Behavior: reader parses all entry types in order, best-effort.
    - Setup: temp `threads/<id>/conversation.jsonl` with `thread_start`, two `message` lines, a `title` line, a `compaction` line, plus one non-JSON garbage line; and a separate non-existent thread id.
    - Actions: call `readArchivedThreadLog` on each.
    - Expected: returns all valid entries in order (garbage skipped); `[]` (no throw) for the missing thread.
  - Behavior: `renderThreadLogToMarkdown` interleaves non-message markers with rendered messages and renders liberally.
    - Setup: a hand-built `ThreadLogEntry[]` with a message containing a thinking block and a `get_file` tool result, then a `title`, then a `compaction`, then another message.
    - Actions: call `renderThreadLogToMarkdown`.
    - Expected: title/compaction markers appear inline in sequence; the thinking block and full `get_file` contents are present (i.e. NOT stripped the way compaction would).
  - Behavior: `compact-renderer.ts` is unmodified (its existing tests still pass).
- Before moving on: confirm `npx vitest run node/core/`, `npx tsgo -b`, and `npx biome check .` pass.

## Stage 2: pretty-printed archive view on <CR>

- Goal: pressing `<CR>` on an archive row opens a new markdown scratch buffer rendered via `renderThreadToMarkdown`, in a non-magenta window, instead of the raw jsonl file.
- Implementation notes: add `openScratchInNonMagentaWindow(lines, name, context)` (or export `findOrCreateNonMagentaWindow` usage) in `node/nvim/openFileInNonMagentaWindow.ts`; update `renderArchiveRow`'s `<CR>` handler.
- Verification (integration, following `node/chat/archive-view.test.ts` patterns and the doc-testing skill):
  - Behavior: <CR> on a row renders the reconstructed thread markdown into a buffer.
    - Setup: archive a thread with a couple of known messages on disk; open the archive view via the driver.
    - Actions: place cursor on the row and trigger `<CR>`.
    - Expected: a non-magenta buffer becomes visible whose contents match `renderThreadLogToMarkdown(entries)` (or contain the message role headers / text and any inline title/compaction markers).
  - Behavior: malformed/missing log doesn't crash the UI.
    - Setup: archive dir with a corrupt conversation.jsonl.
    - Actions: <CR> on the row.
    - Expected: error logged, no unhandled rejection, archive view still usable.
- Before moving on: confirm full `npx vitest run`, `npx tsgo -b`, and `npx biome check .` pass.

## Stage 3: multi-delete via visual `d`

- Goal: a visual selection spanning N archive rows followed by `d` deletes all N threads from disk and the view.
- Implementation notes:
  - Add `d` to `BINDING_KEYS` and set `BINDING_MODES["d"] = ["v"]` in `node/tea/bindings.ts` (this auto-registers the lua visual keymap in `tea.ts`).
  - Add chat message `archive-delete-threads { ids: ThreadId[] }` and handler mirroring `archive-delete-thread`.
  - In `renderArchiveRow`, add `d` binding: compute `idx = state.threadIds.indexOf(threadId)`, `count = ctx?.selection?.length ?? 1`, dispatch delete for `state.threadIds.slice(idx, idx + count)`.
  - Check whether `BINDING_KEYS`/driver test helpers need `d` added anywhere they enumerate keys (e.g. `node/test/driver.ts`).
- Verification (integration, extending `node/chat/archive-view.test.ts`):
  - Behavior: visual `d` over 3 rows deletes those 3 threads.
    - Setup: archive 5 threads; open archive view.
    - Actions: drive a visual selection over rows 2-4 and send `d` (with `ctx.selection` of length 3), anchored at row 2.
    - Expected: `state.threadIds` no longer contains those 3 ids; `deleteArchivedThread` invoked for each; remaining 2 rows still shown; single-row `dd` still works.
  - Behavior: single-row `dd` unaffected (regression).
- Before moving on: confirm full `npx vitest run`, `npx tsgo -b`, and `npx biome check .` pass.

# Notes / follow-ups

- Optional: parameterize `renderThreadToMarkdown` to optionally include `get_file` contents / thinking blocks for the archive viewer (compaction deliberately strips them). Not required for the initial implementation.
- Consult `.magenta/skills/doc-testing/skill.md` for driver/mock setup and `.magenta/skills/doc-views/skill.md` for any view/binding details before implementing stages 2-3.
