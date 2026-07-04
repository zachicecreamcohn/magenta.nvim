# Objective and Context

User's request, verbatim:

> in this branch (or recently on main) we changed how we handle errors in subthreads. This made subthreads fail (to free up a slot for concurrency). But I don't want that. Sometimes a worker fails due to a "terminated" error, which is due to the network being cut off or something. This error is recoverable, and I've been manually restarting the threads. I want to get that behavior back.

> I don't want to treat "error" as "done". I want to treat an error as pending in all threads (root threads or subagent threads, and inside script threads).

## What we're building

Today, `Chat.getThreadResult()` (`node/chat/chat.ts:1128`), which implements the `ThreadManager` interface (`node/core/src/capabilities/thread-manager.ts`), is the single choke point every consumer uses to ask "is this thread finished?":

- `node/core/src/tools/spawn-subagents.ts` (`runElement`/`runQueue`) uses it to decide when a subagent has finished and a concurrency slot can be freed, and (`buildResult`) whether to report the subagent as a success or a permanent failure.
- `node/scripts/script-manager.ts` (`create-thread` handler, `renderThreadYield`) uses it to resolve a script's `createThread()` call with a final value.
- `Chat.update()` itself (`node/chat/chat.ts:207`) uses it to decide when to fire the registered `onThreadYielded` callbacks that the above two call sites are waiting on.

Currently `getThreadResult` treats an `initialized` thread whose agent status is `"error"` as `status: "done"` with an error `Result` — i.e. permanently failed, indistinguishable from a thread that yielded. This is what causes a transient/recoverable error (e.g. a "terminated" network error) to permanently fail a subagent and free its queue slot, and to permanently fail a script's `createThread()` call, with no way to recover.

Contrast this with an *aborted* thread, which the same function already treats as `"pending"`, with the comment "An aborted thread can still be resumed and eventually yield." We want `"error"` to get the same treatment as `"aborted"`: not a terminal state, just a paused one that the thread may still recover from.

This applies uniformly to every `ThreadType` (`node/core/src/chat-types.ts`: `"subagent" | "compact" | "root" | "docker_root"`) and to script-spawned threads (which are just `subagent`-typed threads spawned via `Chat.spawnScriptThread`), because they all flow through the same `getThreadResult`.

## Key files

- `node/chat/chat.ts` — `getThreadResult` (the choke point to change), `update()`'s yield-callback dispatch, `ThreadWrapper` type (has its own separate `"error"` state for thread *construction* failures — out of scope, see Design).
- `node/core/src/capabilities/thread-manager.ts` — the `ThreadManager` interface `getThreadResult` implements.
- `node/core/src/thread-core.ts` — `handleErrorState()` (currently gates the resubmit-setup flow to `isUserFacing` root/docker_root threads only), `AgentStatus`/mode state.
- `node/core/src/providers/anthropic-agent.ts` — `isRetryableError`, `RETRY_DELAYS`, `MAX_RETRY_DURATION`: the existing mid-stream retry mechanism for transient provider errors, which any auto-resubmit mechanism should follow the pattern of (and could reuse the classification from).
- `node/core/src/tools/spawn-subagents.ts` — `runElement`/`runQueue` (waits on `getThreadResult`), `buildResult` (reports final status).
- `node/scripts/script-manager.ts` — `create-thread` handling, `renderThreadYield`.

# Design

## Stage 1: stop treating agent error as a terminal state

In `getThreadResult`, remove the branch that special-cases `agentStatus.type === "error"` as `status: "done"`. Once removed, an errored thread falls through to the existing "all other states ... are considered pending" branch, exactly like an aborted thread does today.

This is a small, mechanical change, but because `getThreadResult` is the single choke point, it automatically fixes the concurrency-queue and script-await behavior for every thread type without needing to touch `spawn-subagents.ts` or `script-manager.ts` at all — they already handle `"pending"` correctly (that's the existing "thread did not complete" / still-waiting path used for in-flight and aborted threads).

Leave the `ThreadWrapper`-level `"error"` state (`node/chat/chat.ts:58`) alone — that represents a thread that never got constructed in the first place (e.g. docker container failed to start), which has no agent to recover, so it's correctly a permanent failure.

Leave all *rendering* code alone (thread summaries, error banners, `failedSubmit` display). Those already read `thread.agent.getState().status` / `thread.core.state` directly, not `getThreadResult`, so the human still sees the error immediately — only the orchestration-level "is this thread done" signal changes.

## Stage 2: give every thread type a path back out of "error"

Stage 1 alone creates a new problem: today, the *only* mechanism that gets a thread out of an error state is `ThreadCore.handleErrorState()`'s resubmit setup, and that's gated to `isUserFacing` threads (`root`/`docker_root` only, see `node/core/src/thread-core.ts:754`) since `fea6d5c061`. If a `subagent`/`compact`/script thread now sits in "pending" after an error, with nothing to ever resubmit it, it will stall forever — permanently occupying a concurrency slot / blocking a script's `createThread()` await, which is worse than today's behavior.

So Stage 2 must give non-interactive thread types the equivalent of the human hitting "resubmit": an automatic retry. Concretely:

- Reuse the existing rollback plumbing in `handleErrorState` (the `preSubmitNativeIdx` snapshot / `discardFailedSubmit`) for *all* thread types, not just user-facing ones — capturing the last user message text regardless of thread type.
- For `root`/`docker_root`: keep today's behavior unchanged — emit `setupResubmit` so the human can see the error and manually resubmit.
- For `subagent`/`compact` (including script-spawned threads): when the error is classified as recoverable (reuse/expose `isRetryableError` from `anthropic-agent.ts`, extended per the earlier investigation to also cover generic connection-drop errors like "terminated"), automatically call `sendMessage()` again with the rolled-back user message, following the same backoff shape already used for mid-stream retries (`RETRY_DELAYS`, capped by `MAX_RETRY_DURATION`), rather than waiting on a human. If the error is not recoverable, or retries are exhausted, leave the thread in its paused/error state — same as an aborted thread that never gets resumed, this is an accepted possibility of the design, not a new failure mode.

Invariants:
- A thread's `getThreadResult` must never report `"done"` for a state that could still change on its own (i.e. only genuine `yielded` or unrecoverable construction failure are terminal).
- No consumer of `getThreadResult` should busy-poll: they should all continue to rely on `onThreadYielded`/dispatch-driven callbacks (already the case).
- Manual resubmit UX for root/docker_root threads must be unaffected.
- The auto-resubmit path must be bounded (time/attempt limit) so a thread that is stuck in a genuine, non-recoverable error doesn't retry forever and burn tokens/requests.

# Stages

## Stage 1: `getThreadResult` treats error as pending [DONE]

- Goal: an agent-level `"error"` status is reported as `{ status: "pending" }` from `getThreadResult`, for every thread type. Concurrency queues and script awaits no longer resolve/fail early on a subagent error; they keep waiting.
- Implementation notes:
  - Removed the `agentStatus.type === "error"` branch in `Chat.getThreadResult` (`node/chat/chat.ts`); errored threads now fall through to the same "pending" return as aborted threads. Also removed the now-unused `agentStatus` local in that branch.
  - `node/tools/spawn-subagents.test.ts`: the old "handles subagent errors gracefully and continues" test asserted the old "error == done" semantics (with `maxConcurrentSubagents: 1`, the second task started immediately after the first errored). Replaced it with "keeps a subagent's slot occupied on error instead of freeing it", which asserts the second task does *not* spawn while the first is errored, then manually recovers the errored thread via `core.discardFailedSubmit()` + `core.sendMessage(...)` (standing in for the Stage 2 auto-resubmit mechanism) and confirms the queue then advances and completes normally.
  - `node/scripts/script-manager.test.ts`: added a new test "does not resolve a script's createThread() await on a subagent error" following the same pattern (force a subagent error, assert the invocation stays `"running"`, manually recover via `discardFailedSubmit`/`sendMessage`, confirm `thread-result` eventually arrives).
  - Root-thread manual-resubmit behavior is untouched by this stage (no changes to `thread-core.ts` or its tests); `node/core/src/thread-core.test.ts` passes unchanged, confirming regression-free.
- Verification:
- Verification:
  - Behavior: a subagent thread that errors keeps its queue slot occupied (not freed) and is not reported in `buildResult` until it actually yields.
    - Setup: spawn a subagent via `spawn-subagents.ts` test harness with a mock agent that errors then is manually driven to yield.
    - Actions: trigger the agent error, assert the tool call has not resolved yet; then drive the thread to `yielded`.
    - Expected outcome: tool call only resolves after the yield, reporting success.
  - Behavior: a script's `createThread()` await does not resolve on a subagent error.
    - Setup: existing script-manager test harness, spawn a script thread, force an agent error.
    - Expected outcome: `thread-result` message is not sent to the script child until the thread yields.
  - Behavior: existing root-thread manual-resubmit tests still pass unchanged (regression check).
- Before moving on: confirm tests, type checks, and linting all pass.

## Stage 2: automatic resubmission for non-interactive thread types

- Goal: `subagent`/`compact` threads (including script-spawned ones) that hit a recoverable error automatically resubmit and can still reach `yielded`; non-recoverable/exhausted errors leave the thread parked in error/pending, same as an unresumed abort.
- Verification:
  - Behavior: a subagent whose agent reports a "terminated"-style connection error automatically resubmits and eventually yields successfully.
    - Setup: mock agent that errors with a recoverable error once, then succeeds on the next `sendMessage`.
    - Actions: run through `spawn-subagents.ts`'s queue.
    - Expected outcome: subagent reports `ok: true` in the final tool result, with no manual intervention.
  - Behavior: a subagent with a non-recoverable error (or one that exceeds the retry budget) is left pending indefinitely and does not spuriously resolve as a success.
  - Behavior: root/docker_root threads still surface `setupResubmit` to the human for non-recoverable errors, unchanged from today.
- Before moving on: confirm tests, type checks, and linting all pass.
