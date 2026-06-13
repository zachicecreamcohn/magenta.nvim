# Objective and Context

User request (verbatim, from `todo.md`):

> - pending messages. When the stream errors or is aborted, they should move back into the input buffer (for an abort), or be appended to the previous message (for an error)
> - pending messages should be highlighted as a user message. Extra long pending messages should be trimmed in preview / expandable so they don't take up too much visual space by default

## What we're building and why

"Pending messages" are user/system messages queued via `@async` while the
agent is busy (streaming or running tools). They currently live in
`ThreadCore.state.pendingMessages: InputMessage[]` and are drained and sent on
the next natural boundary (`end_turn` or tool completion) by `maybeAutoRespond`.

Two gaps:

1. **Recovery on interruption.** If the in-flight turn is **aborted** by the
   user, or the stream **errors**, the queued pending messages are silently left
   in `pendingMessages` and never surfaced for recovery. We want:
   - **abort** → pending messages move back into the **input buffer** so the user
     can edit/resubmit them.
   - **error** → pending messages are **appended to the previous (failed) user
     message** so they're recovered together with the resubmit flow.

2. **Rendering.** Pending messages currently render as a plain `> text` blockquote
   list. We want them to read as a queued **user message** (same `CursorLine`
   highlight used for user blocks), and long pending messages should be
   **trimmed in preview with an expand/collapse toggle** so they don't dominate
   the view.

## Key types / entities

- `InputMessage` (`node/core/src/thread-core.ts:67`) — `{ type: "user" | "system"; text: string }`. Pending messages are arrays of these.
- `ThreadCore.state.pendingMessages` (`thread-core.ts:181`) — the queue.
- `ThreadCoreAction` variants `push-pending-messages` / `drain-pending-messages` (`thread-core.ts:160-161`, applied at `418-422`).
- `abortAndWait()` / `abort()` (`thread-core.ts:771-818`) — the abort path; emits `aborting` and `turnEnded({reason:"aborted"})`. Does **not** currently touch `pendingMessages`.
- `handleErrorState(error)` (`thread-core.ts:741-769`) — the error path; sets `failedSubmit` and emits `setupResubmit`.
- `state.failedSubmit` (`thread-core.ts:190`) and `setupResubmit` event (`thread-core.ts:106`) — existing "recover the failed user message" machinery.
- Root bridge: `Thread` coreListeners (`node/chat/thread.ts:339-352`) translate `setupResubmit`/`aborting` into `RootMsg` dispatches.
- `SidebarMsg` (`node/root-msg.ts:6`) and its handler `handleSidebarMsg` (`node/magenta.ts:372`) — `setup-resubmit` overwrites the input buffer lines.
- `pendingMessagesView` (`node/chat/thread-view.ts:405-412`) — current render. User blocks use `withExtmark(..., { hl_group: "CursorLine", hl_eol: true })` (`thread-view.ts:551-554`).
- `thread.state.messageViewState` — per-message view state already used for expand/collapse-style UI; the pattern to follow for an "expanded pending message" toggle.

## Relevant files

- `node/core/src/thread-core.ts` — queue state, abort/error paths (core logic, no nvim).
- `node/chat/thread.ts` — core→root event bridge.
- `node/root-msg.ts` — `SidebarMsg` union.
- `node/magenta.ts` — `handleSidebarMsg` (input-buffer writes).
- `node/chat/thread-view.ts` — `pendingMessagesView` rendering + expand toggle.
- `node/chat/thread.test.ts`, `node/chat/thread-abort.test.ts` — existing pending/abort tests to extend.

# Design

## Recovery on interruption

The decision of *where* the pending messages go is a core concern (it depends on
abort vs error, which only core knows), but the *destination* (input buffer)
lives in the root/nvim layer. Keep the split clean:

- **Abort path.** In `abortAndWait()`, before clearing mode, snapshot
  `pendingMessages`, drain them, and surface their combined text to the root so
  it can place them in the input buffer. Reuse the existing input-buffer write
  path rather than inventing a new one: emit `setupResubmit` (or a sibling event)
  with the joined pending text. The root already knows how to push that text into
  the input buffer (`handleSidebarMsg` → `setup-resubmit`). Decide whether to
  **append** to existing input-buffer contents or **overwrite**: the existing
  `setup-resubmit` overwrites. For abort we should **append** the pending text to
  whatever the user has already typed, so introduce an `append` flag (or a new
  `SidebarMsg` variant) rather than clobbering in-progress input.

- **Error path.** In `handleErrorState`, the failed user message is captured into
  `failedSubmit.userMessage`. Extend this to also fold any queued
  `pendingMessages` text onto the end of `userMessage` (newline-joined), then
  drain the queue. The existing `setupResubmit` → input-buffer flow then recovers
  the combined text in one shot. No new event needed.

Joining `InputMessage[]` to text: only `type: "user"` messages should be
surfaced for editing; `type: "system"` pending messages (if any are ever queued)
should be dropped or handled explicitly — confirm during implementation whether
system-typed pending messages can occur for root threads (they originate from
`@async` user input, so in practice they are `user`).

Invariants:
- After an abort or error, `pendingMessages` must be **empty** (no double-send if
  the user later resubmits and the queue were still populated).
- Pending text recovered on abort must **not clobber** text the user has already
  typed into the input buffer — append, don't overwrite.
- On error, the combined text must round-trip through the existing
  `failedSubmit` → `discardFailedSubmit()` resubmit flow without duplication.
- Only user-facing root threads (`root` / `docker_root`) surface recovery UI;
  subagent/compact threads must not (mirror the existing `isUserFacing` guard in
  `handleErrorState`).

## Rendering pending messages as a user message

Replace the `> text` blockquote list in `pendingMessagesView` with a rendering
that uses the same user-block highlight (`CursorLine`, `hl_eol: true`) so a
queued message visually reads as a user message, prefixed by the `✉️` queued
indicator.

For length trimming: render a **preview** (first N lines or M characters) by
default with an `[expand]` binding; expanded state is tracked in thread view
state keyed by pending-message index (follow the `messageViewState` /
`withBindings` pattern already used in `thread-view.ts`). Collapsing restores the
preview. Because `pendingMessages` is an ordered array, key expand state by index;
be careful that draining the queue resets/clears that state so stale indices
don't leak.

Invariant: expand/collapse is **view-only** state — it must never mutate
`pendingMessages` or affect what gets sent.

# Stages

## Stage 1: Core — recover pending messages on abort

**Status: DONE.** Added `recoverPendingMessages: [threadId, text]` event to
`ThreadCoreEvents`. `abortAndWait()` now calls `recoverPendingMessagesOnAbort()`
which joins `type: "user"` pending messages with `\n`, always drains the queue
(invariant: queue empty after abort, for all thread types), and emits
`recoverPendingMessages` only for user-facing threads (`root`/`docker_root`)
when there is text. Decision: drain happens regardless of thread type to keep
the empty-queue invariant; emit is gated by `isUserFacing`. Root wiring of the
new event is deferred to Stage 2. Unit tests added in `thread-core.test.ts`
("ThreadCore.abort recovers pending messages"), including a test mixing
a `user` + `system` pending message to cover the `type === "user"` filter
branch (system messages are excluded from recovered text). Pre-existing snapshot/render
test failures are unrelated (confirmed failing on base commit).

- Goal: aborting an in-flight turn that has queued `@async` messages drains the
  queue and emits the pending text to the root for input-buffer recovery; queue
  ends empty.
- Implementation sketch: in `abortAndWait()` snapshot + drain `pendingMessages`,
  emit an event carrying the joined user text (extend `setupResubmit` semantics
  or add an `append`-flavored event). Keep it a no-op when the queue is empty.
- Verification (unit test on `ThreadCore`, plus integration in `thread-abort.test.ts`):
  - Behavior: abort with queued pending messages clears the queue and surfaces text.
  - Setup: busy thread (streaming or tool_use) with one `@async` pending message.
  - Actions: trigger abort.
  - Expected outcome: `pendingMessages` is empty; the emitted/append event carries the pending text; an integration test asserts the input buffer now contains the pending text appended to any existing input.
- Before moving on: confirm tests, type checks (`npx tsgo -b`), and lint (`npx biome check .`) pass.

## Stage 2: Root — append pending text to input buffer on abort

- Goal: the abort event from Stage 1 lands in the input buffer **appended** to
**Status: DONE.** Added `append-to-input` `SidebarMsg` variant (`node/root-msg.ts`)
carrying `threadId` + `text` (chose a new variant over an `append` flag on
`setup-resubmit` to avoid entangling the resubmit semantics, which also calls
`discardFailedSubmit`). `handleSidebarMsg` (`node/magenta.ts`) reads existing
input-buffer lines and appends the recovered text only when there is existing
non-whitespace text (otherwise it just sets the lines, avoiding a leading blank
line). Wired a `recoverPendingMessages` coreListener in `Thread`
(`node/chat/thread.ts`) that dispatches the new `append-to-input` sidebar msg.
Integration test added in `thread-abort.test.ts` ("appends pending messages to
input buffer on abort"): queues an `@async` message, types in-progress text,
aborts, and asserts both the typed text and the recovered pending text are
present and the queue is empty. Pre-existing snapshot/render failures in
`thread.test.ts` are unrelated (confirmed still failing on base commit aa3adf1).

**Review follow-up.** Added a second integration test ("recovers pending
messages into empty input buffer on abort") covering the `hasExistingText ===
false` branch of the `append-to-input` handler: aborting with an empty input
buffer places the recovered pending text on the first line with no stray
leading blank line, and the queue ends empty.


  existing contents, not overwriting in-progress typing.
- Implementation sketch: add an `append` flag to `setup-resubmit` (or a new
  `SidebarMsg` variant) in `node/root-msg.ts`; update `handleSidebarMsg`
  (`node/magenta.ts`) to read existing input-buffer lines and append rather than
  overwrite; wire the `Thread` coreListener (`node/chat/thread.ts`) for the new
  event.
- Verification (integration via `withDriver`):
  - Behavior: abort with a queued message and pre-existing input-buffer text.
  - Setup: type text into the input buffer, queue an `@async` message while busy.
  - Actions: abort.
  - Expected outcome: input buffer contains the original typed text followed by the recovered pending text; queue empty.
- Before moving on: confirm tests, type checks, and lint pass.

## Stage 3: Core — fold pending messages into failed-submit on error

**Status: DONE.** In `handleErrorState` (`thread-core.ts`), inside the existing
`isUserFacing` guard, join `type: "user"` pending messages with `\n`, drain the
queue (invariant: queue empty after error), and fold the pending text onto the
last user message's text (`baseText\npendingText`, or pendingText alone when the
last message has no text). The combined `userMessage` flows through the existing
`set-failed-submit` + `setupResubmit` machinery, so resubmit recovers everything
in one shot. Integration test added in `thread.test.ts` ("folds pending messages
into failed-submit on error"): queues an `@async` message, errors the stream, and
asserts both the original and pending text land in the input buffer and
`failedSubmit.userMessage`, and the queue ends empty. Pre-existing snapshot/render
failures in `thread.test.ts` (6 failing, 3 snapshots) are unrelated (confirmed
still failing on base commit afcfc26 via git stash).

- Goal: when the stream errors with queued pending messages, the pending text is
  appended to `failedSubmit.userMessage` and the queue is drained, so the
  existing resubmit flow recovers everything together.
- Implementation sketch: in `handleErrorState`, after computing `textContent`,
  join in drained `pendingMessages` user text before setting `failedSubmit` /
  emitting `setupResubmit`. Guard with the existing `isUserFacing` check.
- Verification (integration in `thread.test.ts`):
  - Behavior: error during a turn with a queued `@async` message.
  - Setup: busy thread with one pending message; mock stream errors.
  - Actions: drive the error.
  - Expected outcome: `failedSubmit.userMessage` contains both the original message and the pending text; `pendingMessages` empty; resubmit puts combined text in the input buffer.
- Before moving on: confirm tests, type checks, and lint pass.

## Stage 4: View — render pending messages as user blocks with expand/collapse

- Goal: pending messages render with the user-block highlight and a `✉️` queued
  marker; long ones show a trimmed preview with an `[expand]`/`[collapse]` toggle.
- Implementation sketch: rewrite `pendingMessagesView` in `thread-view.ts` to use
  `withExtmark(..., { hl_group: "CursorLine", hl_eol: true })` and a preview/full
  branch driven by per-index view state (new field in thread view state) toggled
  via `withBindings`. Ensure drain clears the expand state.
- Verification (integration via `withDriver`):
  - Behavior: a long pending message renders trimmed by default and expands on toggle.
  - Setup: queue an `@async` message longer than the preview threshold while busy.
  - Actions: assert default display is truncated; trigger the `[expand]` binding.
  - Expected outcome: collapsed view shows preview + expand affordance; expanded view shows full text; toggling back restores preview; `pendingMessages` unchanged throughout.
- Before moving on: confirm tests, type checks, and lint pass.
