# Context

Replace the current "list of context files" display with a "pending context updates" view — showing the content/diffs that would be sent to the agent on the next turn. The goal is to reduce visual noise: files that are tracked but have no pending changes are hidden entirely. The user can scroll back to prior messages to see what the agent has looked at / edited.

Key design points agreed with the user:

1. **Source of truth is `agentView` vs. disk.** `ContextManager.files[path].agentView.content` already stores the version of the file as of the agent's last read/write. Pending updates for text files are `diff(agentView.content, currentDiskContent)`. For binary/PDF files we don't diff — instead we use stat-equality with `lastStat` to detect change: if `agentView` is undefined OR the current stat differs from `lastStat`, pending is a whole-file re-send. The cached `pendingUpdate` map lives on the `ContextManager` as the view-layer's view of pending state.
2. **`lastStat` plays two roles.**
   - For **text files**, it is a polling optimization: if stat matches `lastStat`, skip the expensive read+diff (cache stays valid); otherwise re-read and re-diff against `agentView.content`.
   - For **binary/PDF files**, it is the change-detection primitive: pending is a whole-file re-send whenever current stat differs from `lastStat` (or `lastStat`/`agentView` is missing). We never diff binary content.
   In both cases `lastStat` records the stat of the disk content at the time we last computed / committed that file's pending state.
3. **Periodic background refresh**: a simple setInterval on the `ContextManager` re-runs the (stat-gated) diff computation for all tracked files. Detects out-of-process edits without buffer/file-system event plumbing.
4. **Implicit pre-send check**: `getContextUpdate()` already reads disk when building real updates, so the send path is naturally correct. After a send, `agentView` is updated to current content and `lastStat` is invalidated for the affected files; the next refresh produces an empty pending map.
5. **Don't show unchanged tracked files**: only entries with a real FileUpdate appear in the view.
6. **Separate pending vs. sent views**: keep the existing `renderContextUpdate()` (inline, per-message, for already-sent updates). Add a new `pendingContextView()` for the below-chat summary. Remove the old `contextView()`.

## Relevant files and entities

- `node/core/src/context/context-manager.ts` — `ContextManager` class. Owns file tracking and `agentView`. We'll add a peek method, a pending-updates cache, a refresh method, a background poll timer, and a new event.
- `node/core/src/capabilities/file-io.ts` — `FileIO` capability. Already exposes `readFile` / `readBinaryFile` / `fileExists`. No change required.
- `node/core/src/capabilities/context-tracker.ts` — Defines `TrackedFileInfo.agentView`. Structural reference; no change.
- `node/core/src/thread-core.ts` — Calls `getContextUpdate()` in `sendMessage()` and `sendToolResultsAndContinue()`. We need to ensure the cache is refreshed / cleared on this path and that the ContextManager poll is stopped at thread shutdown.
- `node/context/context-manager.ts` (root wrapper) — Re-exports core types. Defines `contextView()` and `renderContextUpdate()`. We'll add `pendingContextView()` and remove `contextView()`.
- `node/chat/thread-view.ts` — Two call sites for `contextView` (empty-logo view, below-chat view). Swap both to `pendingContextView`. Inline per-message `renderContextUpdate` is untouched.
- `node/chat/thread.ts` — Root `Thread`. Already subscribes to core events. Add a subscription to the new `pendingUpdatesChanged` event to trigger re-renders.

## Key types

```ts
// New event on ContextManager:
export type ContextManagerEvents = {
  fileAdded: [absFilePath: AbsFilePath];
  fileRemoved: [absFilePath: AbsFilePath];
  filesReset: [];
  pendingUpdatesChanged: [];
};

// Per-file stat cache — polling optimization for text, change-detection primitive for binary/PDF:
export type FileStat = { mtimeMs: number; size: number };

// Extend Files entries with a stat snapshot:
export type Files = {
  [absFilePath: AbsFilePath]: {
    relFilePath: RelFilePath;
    fileTypeInfo: FileTypeInfo;
    agentView: TrackedFileInfo["agentView"];
    lastStat?: FileStat; // stat at the time we last computed this file's pendingUpdate
  };
};

// View cache, stored as a single field on ContextManager:
private pendingUpdates: FileUpdates = {};
```

Invalidation / update rules for `lastStat`:
- On `addFileContext` / `addFiles` the entry starts with `lastStat: undefined` (first refresh will read/stat).
- On `toolApplied` (the agent just read or wrote the file), `lastStat` is refreshed to the current on-disk stat — the file now matches `agentView` so there should be no pending update on the next poll.
- On the commit path of `getContextUpdate()`, `lastStat` is refreshed to the stat of the content we just read (which now equals `agentView`). Same rationale.
- Not needed on `removeFileContext` (entry goes away).

The view consumes `contextManager.getPendingUpdates()`.

# Implementation

- [ ] factor out a non-mutating peek variant of the update computation
      - extract the diff/read logic from `handleTextFileUpdate` and `handleBinaryFileUpdate` into helpers that can run in two modes: "commit" (updates `agentView`, current behavior) and "peek" (does not). Text mode is the interesting one: read disk, compare to `agentView.content`, return a `{type: "diff"}` or `{type: "whole-file"}` FileUpdate, or `undefined` if equal. Binary/PDF: return a whole-file update iff `agentView` is undefined / incomplete; otherwise `undefined`.
      - expose `private async peekFileUpdate(absFilePath): Promise<FileUpdate | undefined>`.
      - `getContextUpdate()` keeps the commit-mode behavior verbatim.
      - test (unit):
        - Behavior: `peekFileUpdate` returns a diff for a text file whose disk content has changed, without mutating `agentView`
        - Setup: mock FileIO `readFile` to return initial then modified content; insert entry with `agentView = {type:"text", content: initial}`
        - Actions: call `peekFileUpdate(path)` twice with `readFile` returning the new content
        - Expected output: both calls return equivalent diff; `agentView.content` still equals initial
        - Assertions: patch non-empty; `files[path].agentView.content === initial`

- [ ] add `pendingUpdates: FileUpdates` cache and `refreshPendingUpdates()` method on `ContextManager`
      - for each file in `this.files`:
        - call `fileIO.stat(absFilePath)`
        - if stat is undefined (file gone): pending = `{type: "file-deleted"}`, clear `lastStat`
        - else if `lastStat` is set and equals the current stat: **skip** — the file is unchanged; leave the previous per-file pending entry as-is
        - else (text file, stat differs): call `peekFileUpdate(absFilePath)` which reads the file and diffs against `agentView.content`; store result (may be undefined if content equal to `agentView`); set `lastStat` to the new stat
        - else (binary/PDF file, stat differs or `agentView` missing): pending is a whole-file re-send — emit a `{type: "whole-file"}` FileUpdate built from reading the file (for images: base64-encode as today; for PDFs: re-run `getSummaryAsProviderContent`). Set `lastStat` to the new stat. Do NOT mutate `agentView` here — that only happens in the commit path.
      - build the new `pendingUpdates` map from per-file results; skip entries with `undefined` result
      - emit `pendingUpdatesChanged` iff the map differs from the previous snapshot (keys changed, or any value changed). Compare via a shallow check on each entry's `update` value (by `type` + content-hash/patch string is simplest; alternatively `JSON.stringify` the small map — fine at this scale)
      - expose `getPendingUpdates(): FileUpdates` accessor
      - test (unit):
        - Behavior: refresh detects out-of-process change and emits event
        - Setup: mock FileIO `stat` + `readFile`; add file, set `agentView`; baseline refresh
        - Actions: change mock `readFile` output AND bump `stat.mtimeMs`; refresh again
        - Expected output: first refresh → pending empty; second refresh → diff present; `pendingUpdatesChanged` emitted once
        - Assertions: spy count = 1 between the two refreshes; `pendingUpdates[path].update.value.type === "diff"`
      - test (unit, stat-skip optimization):
        - Behavior: if stat is unchanged, `readFile` is not called
        - Setup: mock FileIO with counters; add file; baseline refresh
        - Actions: refresh again without changing the stat mock
        - Expected output: `readFile` call count unchanged after the second refresh
        - Assertions: `fileIO.readFile.callCount` stable; no emit of `pendingUpdatesChanged`

- [ ] start/stop a background poll inside `ContextManager`
      - constructor accepts optional `pollIntervalMs` (default e.g. 1000ms); passing `undefined` disables the poll (useful for tests)
      - `start()` sets `setInterval(() => this.refreshPendingUpdates(), pollIntervalMs)`; `stop()` clears it
      - call `refreshPendingUpdates()` immediately (fire-and-forget) after every mutating API (`addFileContext`, `addFiles`, `removeFileContext`, `toolApplied`, `reset`). Each of these also clears `lastStat` for the affected file(s) so the immediate refresh will re-diff rather than hitting the stat-skip

- [ ] add a `destroy()` teardown path for threads (ThreadCore and Thread)
      - `ContextManager.destroy()` (or `stop()`): clears the poll interval; removes all listeners via the existing `Emitter` API; safe to call multiple times
      - `ThreadCore.destroy()`: calls `this.contextManager.destroy()`; also aborts any in-flight agent (`abortAndWait` if the current state warrants) and removes any internal Agent event listeners so the agent can be GC'd
      - `Thread.destroy()` (root, `node/chat/thread.ts`): unsubscribes all `this.core.on(...)` handlers registered in the constructor, then calls `this.core.destroy()`
      - wire `Thread.destroy()` into `Chat.deleteThreadSubtree` in `node/chat/chat.ts:543`. Currently the delete path calls `wrapper.thread.abortAndWait()` and then `delete this.threadWrappers[id]`. Replace / augment the `abortAndWait()` call with `await wrapper.thread.destroy()` (which itself awaits an abort) so all resources are released before the wrapper is dropped
      - make `destroy()` idempotent (multiple calls are no-ops) so double-dispose is harmless
      - test (unit, ContextManager):
        - Behavior: after `destroy()`, the poll no longer fires and listeners are detached
        - Setup: fake timers; `pollIntervalMs: 100`; attach a spy to `pendingUpdatesChanged`; call `start()`
        - Actions: `destroy()`, advance timers 500ms
        - Expected output: zero additional emits after destroy
        - Assertions: spy count unchanged across the advance
      - test (integration, thread delete):
        - Behavior: deleting a thread from the overview releases its ContextManager poll
        - Setup: driver-based; create a thread with a file in context; open the overview; record an indicator that the poll is active (e.g. count of `pendingUpdatesChanged` emits, or a spy on `ContextManager.refreshPendingUpdates`)
        - Actions: press `dd` on the thread in the overview to delete it; advance fake timers past `pollIntervalMs`
        - Expected output: no further `refreshPendingUpdates` invocations after the delete
        - Assertions: spy count stable after the advance
      - test (unit, with vitest fake timers):
        - Behavior: interval fires refresh periodically
        - Setup: fake timers; `pollIntervalMs: 100`; mock `FileIO` so disk content differs from `agentView` after first poll
        - Actions: `start()`, advance timers 300ms
        - Expected output: `pendingUpdatesChanged` emitted at least once
        - Assertions: spy count ≥ 1; teardown calls `stop()` (no further emits after advance)

- [ ] refresh/clear after a real send
      - at the end of `getContextUpdate()` (commit path), for each file that was updated: clear `lastStat` (agentView just changed, so the next refresh must re-diff against the new baseline)
      - then call `refreshPendingUpdates()` once more. With the updated `agentView`, the resulting pending map should be empty for those files (unless disk changed again mid-flight)
      - test (unit):
        - Behavior: after a send, pending is empty
        - Setup: file with modified disk content → `refreshPendingUpdates` shows pending diff
        - Actions: call `getContextUpdate()`
        - Expected output: `getPendingUpdates()` is `{}`
        - Assertions: `Object.keys(...).length === 0`

- [ ] add `pendingContextView()` in `node/context/context-manager.ts` (root wrapper)
      - iterates `ContextManager.getPendingUpdates()`
      - for each entry, render a one-liner: `- \`path\` [ +N / -M ]` for diff, `[ +N lines ]` for whole-file, `[ deleted ]`, `[ error: msg ]`. This is structurally identical to the existing `renderContextUpdate` per-line output — extract a shared helper for the line rendering
      - bind `dd` → `core.removeFileContext(absFilePath)` and `<CR>` → `openFile(absFilePath, core, ctx)`
      - include a `# pending context updates:` heading styled the same way as the current `# context:` heading
      - return `""` if the pending map is empty so the section collapses
      - **remove the old `contextView()` export**

- [ ] swap render sites in `node/chat/thread-view.ts`
      - replace both `contextView(thread.contextManager, contextViewCtx(thread))` calls with `pendingContextView(thread.contextManager, contextViewCtx(thread))`
      - update `shouldShowContextManager` so it gates on `Object.keys(contextManager.getPendingUpdates()).length > 0` instead of `!isContextEmpty()`; rename it to `shouldShowPendingContext` for clarity
      - inline per-message `renderContextUpdate(viewState.contextUpdates, ...)` remains untouched (that is the "sent" view)

- [ ] wire `pendingUpdatesChanged` into the root render loop
      - in `node/chat/thread.ts` constructor, subscribe to `this.core.contextManager.on("pendingUpdatesChanged", ...)` and dispatch whatever message triggers a re-render of the thread view (follow the same pattern as existing `core.on("update", ...)` handler — likely a `tool-progress`-style dispatch)
      - verify the handler is torn down on thread close (match existing cleanup pattern for other `core.on` handlers here)
      - integration test (driver-based, see `.magenta/skills/doc-testing/skill.md`):
        - Behavior: out-of-process file change appears in the sidebar as a pending update
        - Setup: temp file, start thread, add the file to context, wait for idle
        - Actions: modify the file on disk externally; advance fake timers past `pollIntervalMs`
        - Expected output: sidebar contains `# pending context updates:` and a line with the file path and change indicator
        - Assertions: `driver.assertDisplayBufferContains("pending context updates")` plus substring match for the change indicator

- [ ] validation pass
      - `npx tsgo -b`
      - `npx biome check --write .`
      - `TEST_MODE=sandbox npx vitest run node/core/src/context/ node/chat/ node/context/` for quick local feedback
      - full suite via `tests-in-docker` subagent if integration tests touched

# Notes / open questions

- Teardown path: `Chat.deleteThreadSubtree` (`node/chat/chat.ts:543`) is the one caller that currently disposes thread resources (it aborts the agent and drops the wrapper). We extend it to call the new `Thread.destroy()` so the ContextManager poll stops and all core→root subscriptions are torn down.
- Polling interval: 1000ms is a reasonable default. Can be exposed as an option later.
- The stat-skip optimization keeps the poll cheap: per tick we do N stat syscalls and only re-read files that actually changed. For typical workloads (a handful of files), this is negligible.
- Binary/PDF pending semantics: we use stat-equality with `lastStat` as the change-detection primitive. A binary or PDF whose `agentView` is `undefined`, or whose current stat differs from `lastStat`, is "pending" as a whole-file re-send. After a commit, both `agentView` and `lastStat` are updated so the file drops out of pending until disk changes again.
