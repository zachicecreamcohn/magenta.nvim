# context

The goal is to display a summary of all files the agent edited during the current "turn" whenever the agent yields control back to the user. A turn begins when the user sends a message and ends when the agent stops (end_turn), is aborted by the user, or fails with an error. The summary is rendered in the chat view with bindings that let the user open each file.

Secondary goal: the chime and terminal-bell currently only fire on a clean `end_turn`. The error path is also a moment where control returns to the user unexpectedly, so it should fire the chime/bell as well. (Abort is user-driven, so the user is already at the terminal — no chime needed.) We centralize this by introducing a `turnEnded` event on `ThreadCore` with a `reason` payload and having the root `Thread` play the chime/bell for `end_turn` and `error` reasons.

The relevant files and entities are:

- `node/core/src/thread-core.ts` — `ThreadCore` class. Owns turn lifecycle. Currently emits `playChime` only from `handleProviderStopped` / `handleProviderStoppedWithToolUse`. Has `handleErrorState` (no chime today) and `abortAndWait` (emits `aborting` only, no chime). Wires `onToolApplied` into the tool context (line ~551). Owns `state` (mode, toolCache, etc.) and is where per-turn tracking should live.
- `node/core/src/capabilities/context-tracker.ts` — defines `OnToolApplied` and the `ToolApplied` discriminated union. The `"edl-edit"` variant is the marker we'll use to detect file mutations. (`get-file*` variants are reads and should be ignored.)
- `node/core/src/tools/edl.ts` — only tool that currently fires `onToolApplied` with `type: "edl-edit"`. This is the source of truth for "the agent edited this file".
- `node/core/src/tools/getFile.ts` — fires `onToolApplied` with `get-file*` types; we explicitly skip these.
- `node/chat/thread.ts` — root-side `Thread` class. Subscribes to `ThreadCore` events and bridges them into `RootMsg` dispatches. Houses `playChimeIfNeeded`, `playChimeSound`, `sendTerminalBell`. Already has the `open-edit-file` message that uses `openFileInNonMagentaWindow` — we'll reuse this for navigation bindings.
- `node/chat/thread-view.ts` — renders the chat buffer. We'll add a new "edited files this turn" section near the bottom (below `messagesView`, near `statusView` / `pendingMessagesView`).
- `node/core/src/thread-core.ts` `Events` map (line ~88) — where we declare new event types (`turnEnded`).
- `node/utils/files.ts` (or wherever `AbsFilePath` is defined under core) — type for the tracked file paths.

Key new types/state:

```ts
// in thread-core.ts state
editedFilesThisTurn: AbsFilePath[]; // insertion-ordered, deduped

// new event in Events
turnEnded: [{ reason: "end_turn" | "aborted" | "error" }];
```

# implementation

- [ ] **Track edited files in `ThreadCore` state**
  - Add `editedFilesThisTurn: AbsFilePath[]` to the `ThreadCore` initial state.
  - In the `onToolApplied` callback inside `handleProviderStoppedWithToolUse` (and the matching one in `compaction-manager.ts` if it should also count — verify with the user; default: ignore compaction edits), check `tool.type === "edl-edit"` and push the path if not already present.
  - Reset `editedFilesThisTurn = []` at the top of `sendMessage` (start of a new turn), and also in the `reset-after-compaction` update branch so post-compaction the list starts fresh.
  - **Testing**
    - Behavior: editing a file via the EDL tool records it in `editedFilesThisTurn`, and sending a new user message resets the list.
    - Setup: unit test against `ThreadCore` with the existing `MockProvider` pattern; queue an assistant response that issues an `edl` tool_use editing two files, then a second turn that edits a third file.
    - Actions: drive the thread through the first turn to completion, assert the list, then call `sendMessage` again and assert reset.
    - Expected output: after turn 1, list contains both edited paths in insertion order; after `sendMessage` for turn 2, list is empty; after turn 2 completes, list contains only the third path.
    - Assertions: direct read of `core.state.editedFilesThisTurn`.

- [ ] **Add a `turnEnded` event to `ThreadCore`**
  - Extend the `Events` map with `turnEnded: [{ reason: "end_turn" | "aborted" | "error" }]`.
  - Emit `turnEnded` in three places:
    - `handleProviderStopped`, after the existing `playChime` site, with `reason: "end_turn"` (only when the chime would have fired — i.e. not auto-responding).
    - `abortAndWait`, after the existing `set-mode → normal` line, with `reason: "aborted"`.
    - `handleErrorState`, at the end of the function, with `reason: "error"`.
  - Do **not** emit `turnEnded` from `handleProviderStoppedWithToolUse` — that path is a pause for tool execution, not a yield to the user. (Re-confirm with the user; this matches the "yields control back" framing.)
  - **Testing**
    - Behavior: each of the three terminal paths emits exactly one `turnEnded` with the correct reason.
    - Setup: unit tests against `ThreadCore` with `MockProvider`; spy on `core.on("turnEnded", ...)`.
    - Actions: (a) drive a normal end_turn response, (b) call `core.abort()` mid-stream, (c) make the provider emit an error.
    - Expected output: one `turnEnded` event per scenario, with reasons `"end_turn"`, `"aborted"`, `"error"` respectively.
    - Assertions: spy called once with the expected payload in each test.

- [ ] **Bridge `turnEnded` in the root `Thread`**
  - In `node/chat/thread.ts` add a `turnEnded` listener alongside `playChime`, `aborting`, etc.
  - On `turnEnded` from any reason, dispatch a re-render (`{ type: "tool-progress" }` is already used for that purpose).
  - Centralize chime/bell here: call `playChimeSound()` + `sendTerminalBell()` when `reason === "end_turn"` or `reason === "error"`. Skip chime/bell on `reason === "aborted"` (user-driven, already at terminal). Remove the existing `playChime` listener and the `playChimeIfNeeded` end_turn check — that filtering now happens at the source.
  - Make sure the listener is added to `coreListeners` and properly unsubscribed in `destroy()`.
  - **Testing**
    - Behavior: chime/bell fires on end_turn and error, but NOT on abort.
    - Setup: integration test with `withDriver()`; mock the chime sound player or assert via `nvim_chan_send` spy on the bell escape sequence.
    - Actions: trigger each terminal path through driver interactions (send message → end_turn; send message → abort; send message → mock provider error).
    - Expected output: bell sent on end_turn and error paths; not sent on abort path.
    - Assertions: spy on the bell call, count invocations.

- [ ] **Render the edited-files summary in the chat view**
  - In `node/chat/thread-view.ts`, add a `editedFilesSummaryView` helper rendering whenever `thread.core.state.editedFilesThisTurn.length > 0`. Render it regardless of agent status — the list grows live as the agent edits files and is reset at the start of the next turn.
  - Paths are stored as `AbsFilePath` in `editedFilesThisTurn` (always absolute). For rendering, use the existing `displayPath(cwd, absFilePath, homeDir)` util from `node/core/src/utils/files.ts`, which returns a relative path when the file is under `cwd` and the absolute path otherwise (with `~` substitution for the home dir).
  - Each rendered row is wrapped in a `withBindings` block that dispatches `{ type: "thread-msg", id, msg: { type: "open-edit-file", filePath } }` with the stored `AbsFilePath`.
  - Place the summary just above `statusView` / below `messagesView`. Visually separate with a header like `Files edited this turn:`.
  - **Testing**
    - Behavior: after a turn that edits files, the summary appears in the chat buffer with the file paths and pressing `<CR>` on a path opens that file.
    - Setup: integration test with `withDriver()`; queue an assistant response that uses `edl` to edit a file in a fixture project.
    - Actions: send a user message, let the response complete, assert the summary text, then trigger the binding.
    - Expected output: the summary lists the edited file; activating the binding opens the file in a non-magenta window.
    - Assertions: `assertDisplayBufferContains("Files edited this turn")` and `assertDisplayBufferContains(displayPath)`; after `triggerDisplayBufferKey`, assert the file buffer is the current window. Include a second case where the edited file is outside `cwd` and assert the absolute path is rendered.

- [ ] **Edge cases and polish**
  - Sub-agents: confirm whether sub-agent `editedFilesThisTurn` should bubble up to the parent thread's summary. Default: keep them separate (each thread tracks its own).
  - Files edited but no longer existing (e.g. moved by a follow-up command): render the path anyway; opening will surface a normal nvim error.
  - Compaction: any edits performed by the compaction agent itself must not be appended to the parent thread's `editedFilesThisTurn`. Verify `compaction-manager.ts`'s `onToolApplied` does not push into the parent list (it currently writes to `contextManager.toolApplied`, not the new state, so this should be fine — confirm by reading the wiring). Compaction completion should reset the parent's `editedFilesThisTurn` (handled via the `reset-after-compaction` branch above), so the post-compaction turn starts clean.
  - **Testing**
    - Behavior: aborting mid-tool still shows the files that were successfully edited before the abort.
    - Setup: queue an `edl` edit that completes followed by a long-running second tool that gets aborted.
    - Actions: trigger the abort during the second tool.
    - Expected output: summary lists the first file only.
    - Assertions: `assertDisplayBufferContains` for the edited path; absence of the un-edited tool's target.

- [ ] **Run full type check and test suite**
  - `npx tsgo -b` until clean.
  - `TEST_MODE=sandbox npx vitest run` for local feedback, then `tests-in-docker` for full coverage.
