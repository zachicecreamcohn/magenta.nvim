# Objective and Context

User request, verbatim:

> I want to make some changes to how magenta interacts with vim buffers:
>
> - when a thread is titled, we should use that title somehow in the buffer name (instead of just using an opaque id, though still need to make sure it's unique)
> - thread display buffers should be listed
> - deleting a thread display or input buffer (via :bd) should remove that thread from magenta state

We are changing how magenta names, lists, and tears down the neovim buffers
backing each thread. Three independent improvements:

1. Reflect a thread's title in its display/input buffer names (while keeping
   names unique and keeping the prefix that completion relies on).
2. Make thread display buffers appear in `:ls` (listed buffers).
3. Make `:bd`/`:bw` of a thread display or input buffer remove that thread
   from magenta's state.

## Key entities

- **`BufferManager`** (`node/buffer-manager.ts`) — owns the per-thread display
  and input `NvimBuffer`s plus the overview buffers. Holds `threadEntries:
  Map<ThreadId, BufferEntry>` and the reverse lookup `bufNrToInfo: Map<BufNr,
  BufferInfo>` where `BufferInfo = { key: ThreadId | "overview"; role:
  "display" | "input" }`. Names buffers in `registerThread()` using a
  hyphen-stripped thread id (`bufferId`). Creates buffers via the private
  `createDisplayBuffer` / `createInputBuffer` / `createReadOnlyInputBuffer`
  statics. Exposes `lookupBuffer(bufNr)` and `isMagentaBuffer(bufNr)`.
- **`MAGENTA_INPUT_BUFFER_PREFIX`** (`node/buffer-manager.ts:11`) = "Magenta
  Input". Must stay a substring of every input buffer name — the lua
  completion source (`lua/magenta/completion/constants.lua`,
  `is_magenta_input_buffer`) detects input buffers by substring-matching it.
- **`ThreadCore`** (`node/core/src/thread-core.ts`) — stores `state.title?:
  string`, set via `setTitle()` which emits the generic core `"update"` event.
- **`Thread`** (root controller, `node/chat/thread.ts`) — bridges `ThreadCore`
  events to `RootMsg` dispatches; already listens to core `"update"` at ~:290
  and dispatches `{ type: "tool-progress" }`. Has `this.context.dispatch`.
- **`Chat`** (`node/chat/chat.ts`) — owns thread lifecycle. `delete-thread`
  message (:104, handled :305) finds the root ancestor and calls
  `deleteThreadSubtree(rootId)` (:604) which destroys threads and removes them
  from `threadWrappers`, but does NOT currently clean up `BufferManager`.
- **`Magenta`** (`node/magenta.ts`) — registers lua->node notifications
  (`MAGENTA_BUF_ENTER` etc. around :824-889) and holds `bufferManager`,
  `chat`, `dispatch`.
- **Lua bridge** (`lua/magenta/init.lua`) — registers autocmds in the
  `MagentaBridge` augroup that `safe_rpcnotify` events to node (see existing
  `BufEnter` / `WinClosed` handlers ~:213-249).

# Design

## 1. Title in buffer name

Titles are not known at `registerThread()` time, so names must be updated
later when a title is set. Add a `BufferManager.setThreadTitle(threadId,
title)` method that renames both buffers via `NvimBuffer.setName`.

Lead with the title (the interesting part, which shows first in `:ls` /
bufferline UIs) and push the marker + id into a de-emphasized trailing
bracket, e.g.:

- display: `<title> [Magenta <bufferId>]`
- input:   `<title> [Magenta Input <bufferId>]`

Before a title exists (at `registerThread` time), fall back to a placeholder
in the title slot, e.g. `Thread [Magenta <bufferId>]`.

Constraints this format satisfies:
- The input name still contains the literal `"Magenta Input"` substring, which
  is all the lua completion source checks for (it matches anywhere, not just a
  prefix).
- The full `<bufferId>` is retained so names stay globally unique (display vs.
  input differ via the `Input` marker), which matters because
  `nvim_buf_set_name` errors on a collision. Do not truncate the id — uuidv7
  ids only guarantee uniqueness in full.

The title is sanitized first (strip newlines, collapse whitespace, truncate to
a reasonable length).

Triggering the rename: the `Thread` controller already observes core
`"update"`. Cache the last-applied title; when `core.state.title` changes,
route a rename request to `BufferManager`. `Thread` does not hold
`BufferManager`, so the cleanest path is a new `RootMsg` variant that `Magenta`
handles by calling `bufferManager.setThreadTitle(threadId, title)`. (Confirm
during implementation whether an existing sidebar/chat message channel is a
better fit than a brand-new variant.)

## 2. Listed buffers

`createDisplayBuffer` and `createInputBuffer` currently call
`NvimBuffer.create(false, true, nvim)` (unlisted, scratch). Change both the
thread display and thread input buffers to be created listed
(`NvimBuffer.create(true, true, nvim)`). `buftype` stays `"nofile"`. The
overview buffers are left unchanged.

## 3. `:bd` removes the thread

- Lua: add a `BufDelete` autocmd (pattern `*`) in the `MagentaBridge` augroup
  that `safe_rpcnotify`s a new `magentaBufDelete` event carrying the bufnr.
- Node: register the `magentaBufDelete` notification in `Magenta`. The handler
  calls `bufferManager.lookupBuffer(bufNr)`:
  - If it resolves to a `ThreadId`, remove that thread and the subtree *below*
    it (the thread plus its descendants) — NOT the root ancestor / siblings.
    Note `deleteThreadSubtree(id)` already deletes the given node and all its
    descendants; the existing `delete-thread` message escalates to the root
    ancestor via `getRootAncestorId` (the `dd` binding's behavior), so the
    `:bd` path must NOT escalate. Either add a `delete-thread` variant/flag
    that skips the root-ancestor escalation, or a dedicated message that calls
    `deleteThreadSubtree(threadId)` directly.
  - If it resolves to `"overview"`, do NOT remove any thread. Instead recover:
    the overview must always exist. The held `NvimBuffer` references in
    `overviewEntry` are now dead, so `BufferManager` recreates the overview
    buffer(s) and resets `overviewEntry` to an unmounted (`"registered"`)
    state, updating `bufNrToInfo` (drop the dead bufnr, add the new one). The
    next `ensureOverviewMounted` / `switchToOverview` re-mounts and re-binds
    windows. If the overview is the active view, `Magenta.activeBuffers` holds
    a stale reference and must be refreshed (re-fetch via
    `getOverviewBuffers()` and re-switch the windows).
  - Keeping the overview buffers unlisted (see Stage 1 — only thread buffers
    become listed) reduces the chance a bare `:bd`/`:bufdo` targets them.
- `BufferManager` must drop its entries for a removed thread: add
  `removeThread(threadId)` that deletes both `NvimBuffer`s (best-effort) and
  clears `threadEntries` + both `bufNrToInfo` entries. Wire it into the
  `deleteThreadSubtree` path so magenta-initiated deletions also clean up
  buffers.
- `BufferManager` gets a `recreateOverview()` for the recovery path above:
  create fresh overview display/input buffers, reset `overviewEntry` to
  `"registered"`, and fix up `bufNrToInfo`.

Invariants:
- Every input buffer name continues to contain the literal "Magenta Input" so
  completion keeps activating.
- Buffer names stay globally unique (the `bufferId` component guarantees this).
- `delete-thread` is idempotent: deleting an already-removed thread is a
  no-op. This is required because magenta-initiated deletion deletes the
  buffers, which re-fires `BufDelete` -> `magentaBufDelete` -> `delete-thread`.
  Guard against this re-entrancy (e.g. `deleteThreadSubtree`/`removeThread`
  short-circuit when the thread/entry is already gone).
- Deleting an overview buffer never removes a thread; the overview is
  recreated so it always exists and stays usable.

# Stages

## Stage 1: Listed buffers

- Goal: thread display and input buffers show up in `:ls` / are listed;
  overview behavior unchanged.
- Verification:
  - Behavior: opening a thread produces listed display and input buffers.
  - Setup: `withDriver()` integration test; open magenta and create a thread.
  - Actions: query buffer list (e.g. `:ls` output or buffer option `buflisted`)
    for the thread's display and input buffers.
  - Expected outcome: both the display and input buffers are listed.
- Before moving on: confirm tests, type checks (`npx tsgo -b`), and linting
  (`npx biome check .`) pass.

## Stage 2: Title in buffer name

- Goal: when a thread receives a title, its display and input buffer names
  update to include the sanitized title while staying unique and keeping the
  "Magenta Input" prefix.
- Verification:
  - Behavior: setting a thread title renames both backing buffers.
  - Setup: `withDriver()` test; create a thread and drive a title to be set
    (manual `set-title` dispatch or the title flow per doc-testing skill).
  - Actions: read both buffer names after the title is applied.
  - Expected outcome: both names contain the title and the unique id; input
    name still contains "Magenta Input"; completion still recognizes the input
    buffer.
- Before moving on: confirm tests, type checks, and linting pass.

## Stage 3: Tighten the title-generation prompt

The title now drives the buffer name (Stage 2), so it should be short enough
to display efficiently in `:ls` / bufferline. Update the `thread_title` tool
spec (`node/core/src/tools/thread-title.ts`) — both the tool `description` and
the `title` property `description` — to encourage a single-line, concise
title with an encouraged max length (the spec currently only says "shorter
than 80 characters"; tighten toward a shorter target, e.g. a few words / ~40
chars, and explicitly require a single line / no newlines). This is advisory
to the model; the `setThreadTitle` sanitizer (Stage 2) still enforces
single-line + truncation as the hard guarantee.

- Goal: generated titles are short, single-line, and display well in a buffer
  name.
- Verification:
  - Behavior: the tool spec communicates the single-line + short-length
    expectation.
  - Setup: unit-level assertion on the exported `spec` strings, or a
    title-generation flow test per the doc-testing skill.
  - Actions: inspect the spec / drive a title generation.
  - Expected outcome: the prompt text reflects the new guidance; sanitization
    still guards against an over-long or multi-line title regardless.
- Before moving on: confirm tests, type checks, and linting pass.

## Stage 4: `:bd` removes the thread

- Goal: `:bd`/`:bw` of a thread's display or input buffer removes that thread
  from chat state; magenta-initiated deletion also cleans up buffers without
  infinite re-entrancy.
- Verification:
  - Behavior A: `:bd` on a thread display buffer removes the thread.
  - Behavior B: `:bd` on a thread input buffer removes the thread.
  - Behavior C: `:bd` of a non-root thread removes that thread and its
    descendants but leaves the root ancestor and siblings intact; deletion via
    any path also removes the corresponding buffers without erroring from
    re-entrant deletion.
  - Behavior D: deleting an overview buffer does not remove any thread, and the
    overview recovers — a fresh overview buffer is created and remains usable
    (re-openable, re-mountable).
  - Setup: `withDriver()` tests; create one or more threads.
  - Actions: run `:bd <bufnr>` against the relevant buffer / dispatch
    `delete-thread`.
  - Expected outcome: the thread is gone from `chat.threadWrappers` and
    `BufferManager` entries are cleared; overview deletion is a no-op.
- Before moving on: confirm tests, type checks, and linting pass.

