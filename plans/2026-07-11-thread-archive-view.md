# Objective and Context

User request (verbatim):

> ok next up, let's hook up some new UI for this.
>
> From the thread overview, I want to add a link to an archive view.
>
> The archive view should show archived threads, in order (uuidv7 orders by timestamp) from most recent on top to oldest on bottom.
>
> For each thread, we should show a date (like Sat Jul 11, 2026, 8:53PM) followed by the thread title. I don't know if we're persisting the thread title yet, so
>
> I want this to be nice and efficient, even for very large archives. I think the easiest way to do this is to just show the last N threads or so, and add a pager? Or maybe we just show them all and the person can delete older threads they don't need any more?
>
> dd on a thread line should delete it from the archive. <CR> on a thread line should open the thread archive in a file.
>
> Come up with a plan. How should we persist the title so it's fast to read for a large number of threads? Does that performance concern matter? Should we page or just show everything? If we show everything should we stream? What happens if we have like 1000 threads?

## What we're building

A new "archive" view reachable from the thread overview. It lists every thread that has a conversation archive on disk (`/tmp/magenta/threads/{threadId}/conversation.jsonl`), newest-first, showing a formatted date and the thread's title. `<CR>` on a row opens that thread's `conversation.jsonl` in a non-magenta window; `dd` deletes the thread's archive directory.

## Key facts grounding the design

- Thread dirs are named by `ThreadId`, which is a `uuidv7` (`import { v7 as uuidv7 } from "uuid"`, see `node/chat/chat.ts`). uuidv7 is time-ordered: the first 48 bits are the ms-since-epoch creation time. So both **sort order** and **creation date** are derivable from the directory name with **zero file reads**.
- Titles are NOT persisted today. `ThreadCore` holds it only in `state.title`, set via the `set-title` action (`node/core/src/thread-core.ts:457`, `setTitle` at :640, auto-generated at :1608).
- `ThreadLogger` (`node/core/src/thread-logger.ts`) already owns append-only writes to the archive dir and supports a `baseDir` override for tests. `threadConversationLogPath(threadId, baseDir?)` lives in `node/core/src/utils/files.ts`.
- The overview view and its bindings live in `node/chat/chat.ts` (`renderThreadOverview` ~:975, `renderThread` ~:860 with `withBindings` for `<CR>`/`dd`). `ChatState` currently has `thread-overview` and `thread-selected`.
- Files are opened via `openFileInNonMagentaWindow(filePath, context)` (`node/nvim/openFileInNonMagentaWindow.ts`).

## Relevant files

- `node/core/src/thread-logger.ts` — add title persistence (JSONL line + sidecar).
- `node/core/src/thread-core.ts` — call the logger when the title is set.
- `node/core/src/utils/files.ts` — add a sidecar-path helper.
- `node/core/src/archive.ts` (new) — pure archive read/list/delete + uuidv7 date decode.
- `node/chat/chat.ts` — new `archive` state, messages, rendering, and the overview link.
- Tests alongside the above (`thread-logger.test.ts`, new `archive.test.ts`, chat integration where practical).

# Design

## Answering the performance questions

- **Persisting the title fast:** write a tiny `meta.json` sidecar (`{ title, threadType }`) in each thread dir, overwritten whenever the title is set. Keep the JSONL as the append-only source of truth (also append a `title` entry there for archive completeness), but never scan the JSONL to build the list — scanning N full JSONL files just to find a title is the expensive path we are avoiding. The list view reads only the small sidecar.
- **Does perf matter / 1000 threads:** `readdir` of the threads dir is single-digit ms even at thousands of entries, and it gives us order + date for free. The only cost that scales with archive size is reading `meta.json` per row. Reading 1000 sidecars eagerly would add ~50-200ms of avoidable latency, so we don't.
- **Page vs. show-all vs. stream:** show *all* rows (order and date come free from dir names, so rows render instantly), but **lazily hydrate titles a page at a time** (e.g. 50 rows). A `[load more]` affordance extends the hydrated window. This is strictly better than a hard "last N" cap (old threads stay reachable) and avoids true async streaming into the TUI. Rows appear immediately with their date; the title fills in when its sidecar read completes.
- **Deletion policy:** no auto-pruning. `dd` gives manual control, which is simpler and safer.

## Data flow

1. Entering the archive view triggers `listArchivedThreadIds(baseDir?)`: `readdir` the threads dir, keep names that parse as uuidv7, sort descending. Cheap, no content reads. Store the full id list in `ChatState`.
2. Each row's date is decoded from its uuidv7 id (no I/O). Rows for ids without a loaded title render with a placeholder (`…` / `(untitled)`).
3. For the currently-visible window (first `loadedCount` ids), asynchronously read each `meta.json` and dispatch a message that caches `{ threadId -> title }`, causing a re-render as titles arrive.
4. `[load more]` increases `loadedCount` and hydrates the next window.
5. `<CR>` → `openFileInNonMagentaWindow(conversationLogPath, context)`. `dd` → delete the thread dir, drop the id from state, re-render.

## Archive module (`node/core/src/archive.ts`)

Pure, filesystem-only helpers so they're trivially unit-testable with a temp `baseDir`:

- `listArchivedThreadIds(baseDir?): Promise<ThreadId[]>` — readdir + uuidv7 filter + descending sort.
- `readThreadMeta(threadId, baseDir?): Promise<{ title?: string; threadType?: ThreadType }>` — read sidecar; missing/corrupt sidecar resolves to `{}` (best-effort).
- `deleteArchivedThread(threadId, baseDir?): Promise<void>` — `rm -rf` the thread dir.
- `threadCreatedAt(threadId): Date` — decode first 48 bits of the uuidv7 as ms epoch.

Date formatting (e.g. `Sat Jul 11, 2026, 8:53 PM`) is done in the view layer.

Invariants:
- Listing and date/order derivation must never read file contents (only `readdir` + name parsing).
- Sidecar reads are best-effort: a missing or malformed `meta.json` yields an undefined title, never an error surfaced to the user.
- `dd` deletes only the one thread's directory and never touches a live thread's on-disk log for a thread that is currently open (deletion is an archive operation; if the thread is live its logger simply recreates the dir on next write — acceptable, but the archive view should operate on non-live entries in practice).
- Sidecar writes stay best-effort and off the hot path, consistent with existing `ThreadLogger` behavior (errors routed to the diagnostic logger, never thrown/awaited by thread execution).

# Stages

## Stage 1 — Persist titles (sidecar + JSONL)

**Status: DONE.** Added `threadMetaPath` to `utils/files.ts`; `ThreadLogger` gained a `title` log-entry type, `recordTitle(title)` (appends `title` JSONL entry + overwrites `meta.json` sidecar via a serialized `metaChain` so last-write-wins), and `flushed()` now awaits the meta chain. `ThreadCore`'s `set-title` action calls `recordTitle`. Meta writes are best-effort (errors routed to logger, never thrown). Tests added in `thread-logger.test.ts`; full core suite, typecheck, and lint pass.

**Code-review follow-up (DONE).** Added two unit tests in `thread-logger.test.ts`: (1) the message-flush invariant — `onUpdate()` withholds the still-streaming final message (only N-1 land), `onTurnEnded()` appends the withheld one, and both are idempotent by cursor with no double-writes on repeated calls; (2) meta sidecar write errors route to the logger (distinct from the JSONL append error path). Full core suite, typecheck, and lint pass.

- Goal: whenever a thread's title is set, `ThreadLogger` appends a `title` line to `conversation.jsonl` and writes a `meta.json` sidecar; `ThreadCore` invokes this on the `set-title` path. Add `threadMetaPath(threadId, baseDir?)` to `utils/files.ts`.
- Verification:
  - Behavior: setting a title writes the sidecar with the latest title and appends a `title` entry to the JSONL.
    - Setup: `ThreadCore` (or `ThreadLogger` directly) with a temp `baseDir`, as existing archive tests do.
    - Actions: call `setTitle("Hello")`, then `setTitle("Hello 2")`; await `flushed()`.
    - Expected: sidecar contains the final title; JSONL contains two `title` entries in order.
  - Behavior: sidecar write errors are swallowed (best-effort).
    - Setup: force an fs error (unwritable path) as the existing error-routing test does.
    - Actions: set a title.
    - Expected: no throw; error routed to the logger.
- Before moving on: confirm tests, type checks, and linting all pass.

## Stage 2 — Archive read/list/delete module

- Goal: `node/core/src/archive.ts` can list archived thread ids newest-first, read a thread's meta, decode its creation date, and delete a thread dir.
- Verification:
  - Behavior: `listArchivedThreadIds` returns valid uuidv7 dirs sorted descending and ignores non-uuid entries.
    - Setup: temp baseDir with several thread dirs (uuidv7 ids) plus a junk dir.
    - Actions: call the function.
    - Expected: only uuid ids, most-recent first.
  - Behavior: `threadCreatedAt` decodes the uuidv7 timestamp.
    - Setup: generate an id via `uuidv7()` around a known `Date.now()`.
    - Actions: decode.
    - Expected: within a few ms of the generation time.
  - Behavior: `deleteArchivedThread` removes the directory; `readThreadMeta` tolerates a missing sidecar.
    - Setup: a thread dir with and without `meta.json`.
    - Actions: read meta (missing → `{}`); delete; re-list.
    - Expected: `{}` for missing meta; deleted id gone from the list.
- Before moving on: confirm tests, type checks, and linting all pass.

## Stage 3 — Archive view state, messages, and rendering

- Goal: a new `archive` `ChatState` with `loadedCount` and a `titles` cache; messages `archive-open`, `archive-navigate-back`, `archive-load-more`, `archive-delete-thread`, and `archive-meta-loaded`. `renderArchive()` renders the header and newest-first rows (date + title/placeholder) with `<CR>`/`dd` bindings and a `[load more]` row when more ids remain than are hydrated.
- Verification (integration, following existing chat/driver test patterns where practical):
  - Behavior: opening the archive lists rows newest-first with decoded dates.
    - Setup: seed a temp archive with a few thread dirs + sidecars.
    - Actions: dispatch `archive-open`.
    - Expected: rows in descending id order; each shows formatted date; titles appear after hydration.
  - Behavior: `dd` deletes the row and its on-disk dir.
    - Actions: trigger the `dd` binding on a row.
    - Expected: id removed from state and directory gone.
  - Behavior: `<CR>` opens the thread's conversation.jsonl.
    - Actions: trigger `<CR>`; assert `openFileInNonMagentaWindow` called with the log path.
  - Behavior: `[load more]` hydrates and reveals the next window when ids exceed the page size.
- Before moving on: confirm tests, type checks, and linting all pass.

## Stage 4 — Overview link + back navigation

- Goal: `renderThreadOverview` gains an "Archive" link (bound to `archive-open`); the archive view has a back affordance (bound to `archive-navigate-back`) returning to `thread-overview`. Wire the overview app so the archive state renders through the existing overview buffer.
- Verification:
  - Behavior: from the overview, activating the archive link switches to the archive view; back returns to the overview.
    - Setup: mounted overview app (existing test harness).
    - Actions: trigger the link, then back.
    - Expected: state transitions overview → archive → overview; correct content rendered each time.
- Before moving on: confirm tests, type checks, and linting all pass.

## Open questions (confirm with user, defaults chosen)

- Date source: decode from uuidv7 (zero I/O) — chosen. (Alternative: read `thread_start` timestamp.)
- `<CR>` target: open raw `conversation.jsonl` — chosen. (A rendered read-only view could come later.)
- Page size for hydration: default 50.
