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

## Stage 2: automatic resubmission for non-interactive thread types [DONE]

- Goal: `subagent`/`compact` threads (including script-spawned ones) that hit a recoverable error automatically resubmit and can still reach `yielded`; non-recoverable/exhausted errors leave the thread parked in error/pending, same as an unresumed abort.
- Implementation notes:
  - `node/core/src/providers/anthropic-agent.ts`: extended `isRetryableError` to also treat a bare `Error`/`TypeError` whose message is exactly `"terminated"` as retryable — Node/undici's fetch surfaces an abrupt socket/connection close this way, and it carries no information about request content, so retrying is safe (same reasoning as the existing SSE-parse/stream-order transient-error checks it sits next to).
  - `node/core/src/thread-core.ts`:
    - `handleErrorState` now computes the rolled-back user-message text (pendingText/baseText/userMessage) unconditionally for every thread type, not just user-facing ones (previously this whole block, including `drain-pending-messages`, was gated on `isUserFacing`). `root`/`docker_root` keep the exact same `set-failed-submit` + `setupResubmit` emission as before; every other thread type is routed to a new private method, `maybeAutoResubmitAfterError`.
    - `maybeAutoResubmitAfterError(error, userMessage)`: tracks a bounded auto-retry "episode" via three new private fields (`errorRetryTimer`, `errorRetryAttempt`, `errorRetryFirstErrorAt`). On the first error in an episode it records `errorRetryFirstErrorAt = Date.now()`; on each subsequent error it recomputes `elapsed = now - errorRetryFirstErrorAt`. If `!isRetryableError(error) || elapsed >= MAX_RETRY_DURATION` (or `userMessage` is empty), it calls `resetErrorRetryState()` and leaves the thread parked in its current (pending, per Stage 1) error state — no timer scheduled. Otherwise it schedules a `setTimeout` at `getRetryDelay(attempt)` (same `RETRY_DELAYS` shape as the agent's own mid-stream retries) whose callback calls `discardFailedSubmit()` then `sendMessage([{type:"user", text: userMessage}])`, i.e. the same rollback-then-resubmit sequence a human performs manually for root threads.
    - `resetErrorRetryState()`/`clearErrorRetryTimer()`: reset the episode. Called from: (a) `maybeAutoResubmitAfterError` itself when giving up, (b) `abortAndWait()` (a manual abort should not leave a stray auto-retry pending), and (c) `handleProviderStopped`, but **only when `usage` is defined**.
    - Important bug caught by the exhausted-budget test: `discardFailedSubmit()` calls `agent.truncateMessages()`, which as a side effect sets the agent to `{type:"stopped", stopReason:"end_turn"}` and emits a synthetic `"stopped"` event with `usage: undefined`. Originally `resetErrorRetryState()` was called unconditionally at the top of `handleProviderStopped`, which meant every single auto-retry attempt's own rollback silently erased `errorRetryFirstErrorAt` right before the next error arrived — so `elapsed` was always computed as `~0` and the retry budget could never actually expire. Fixed by only resetting when `usage` is truthy, which is only ever populated by a genuine completed-turn (`stream-completed`) event, not by the rollback-triggered synthetic stop or by `stream-aborted`.
  - `node/core/src/thread-core.test.ts`: added a new `describe("ThreadCore auto-resubmit for non-user-facing threads (Stage 2)")` block (uses `vi.useFakeTimers()`/`vi.useRealTimers()`) with three tests:
    - "subagent automatically resubmits a recoverable error and eventually yields" — bypasses the *agent's own* mid-stream retry budget via `vi.setSystemTime(+300_001ms)` right before `respondWithError(new Error("terminated"))` so the error reaches `ThreadCore` immediately (as if connection-level retries were already exhausted), then advances 1000ms (the thread-level `RETRY_DELAYS[0]`) and confirms a second stream is created automatically and, once it responds successfully, the thread reaches `stopped`/`end_turn` with no duplicate user message and no `setupResubmit` emission.
    - "subagent with a non-recoverable error stays parked and never auto-succeeds" — plain `Error("subagent provider failure")` (not agent-level retryable either, so no bypass needed); asserts no second stream is ever created even after advancing 60s, and `failedSubmit` stays unset.
    - "subagent stops auto-resubmitting once the retry budget is exhausted" — same agent-level bypass trick applied repeatedly (each cycle: advance the fake clock enough to fire the pending thread-level retry timer, then bypass the agent's own budget again and error again) in a bounded loop until no further stream is created, then asserts the stream count is stable across a final 60s advance. This test is what caught the `handleProviderStopped` reset bug above.
  - Root/docker_root manual-resubmit behavior is byte-for-byte unchanged (same `set-failed-submit` + `setupResubmit` emission, same rollback-computed `userMessage`); the existing Stage 1 tests in the "ThreadCore non-retryable error resubmit flow" describe block pass unchanged, confirming no regression.
- Verification:
  - Behavior: a subagent whose agent reports a "terminated"-style connection error automatically resubmits and eventually yields successfully. Verified at the `ThreadCore` level (see test above) rather than through `spawn-subagents.ts`'s queue as originally sketched — `getThreadResult`/the queue already treat "pending" uniformly regardless of *why* a thread is pending (Stage 1), so the only new behavior to verify is that `ThreadCore` itself can autonomously get from `error` back to `yielded`/`stopped` without a human; wiring that through the full subagent queue would mostly re-test Stage 1's plumbing.
  - Behavior: a subagent with a non-recoverable error (or one that exceeds the retry budget) is left pending indefinitely and does not spuriously resolve as a success. Verified (two separate tests, one per cause).
  - Behavior: root/docker_root threads still surface `setupResubmit` to the human for non-recoverable errors, unchanged from today. Verified via the untouched Stage 1 tests.
- Before moving on: confirm tests, type checks, and linting all pass.
  - `npx vitest run node/core/src/thread-core.test.ts`: 33/33 pass.
  - `npx vitest run` (full suite): 3 pre-existing/unrelated failures (`node/magenta.test.ts > can switch profiles`, `node/chat/thread.test.ts > expands context update diff with = binding`, and a flaky `node/render-tools/spawn-subagents.test.ts` hierarchy test that passes in isolation) — confirmed all three fail identically on a clean stash of this stage's changes, i.e. pre-existing and not introduced here.
  - `npx tsgo -b`: passes.
  - `npx biome check .` (after `--write` for two pre-existing formatting nits unrelated to logic): passes.

## Post-Stage-2 code review follow-ups

Addressed all findings from code review of Stage 2:

- `node/core/src/providers/anthropic-agent-retry.test.ts`: added direct unit tests for the new `"terminated"`-message branch in `isRetryableError` — asserts both `Error` and `TypeError` with message exactly `"terminated"` are retryable, and that unrelated messages (including a `"terminated unexpectedly"` substring, to rule out a substring-match regression) are not.
- `node/core/src/thread-core.ts`: collapsed the three loose fields (`errorRetryTimer`, `errorRetryAttempt`, `errorRetryFirstErrorAt`) into a single `errorRetry: { timer, attempt, firstErrorAt } | undefined` struct, per the "make invalid states non-representable" guideline — `undefined` now means "no retry episode in progress" is the only way to represent that state, so `attempt`/`firstErrorAt` can no longer exist without a `timer` (or vice versa) from a stale episode. `maybeAutoResubmitAfterError`, `clearErrorRetryTimer`, and `resetErrorRetryState` updated accordingly; behavior unchanged.
- `node/core/src/thread-core.test.ts`: added three regression tests to the Stage 2 describe block and the Stage 1 describe block:
  - "aborting a subagent cancels a pending auto-resubmit timer" — schedules an auto-resubmit via a recoverable error, calls `core.abort()` before the timer fires, then advances 60s and confirms no second stream is ever created (locks down `abortAndWait()`'s call to `resetErrorRetryState()`).
  - "does not schedule an auto-resubmit when there is no user message to roll back to" — covers `maybeAutoResubmitAfterError`'s early-return when `userMessage` is empty. This isn't reachable through the public `sendMessage`/`handleSendMessageRequest` API (every `InputMessage`, whether `type: "user"` or `type: "system"`, produces a plain `"text"` content block via `prepareUserContent`, so `baseText` is never actually empty once any message has been sent), so the test calls the private method directly via a narrow `as unknown as {...}` cast, matching the existing repo convention of casting to narrow interfaces for test-only access (used elsewhere in this file for `ThreadCoreContext` fields).
  - "rolls back queued pending-message text alongside the in-flight user message on error" (added to the Stage 1 "ThreadCore non-retryable error resubmit flow" describe block) — queues an async message via `handleSendMessageRequest(..., true)` while the root thread is streaming (landing in `pendingMessages`), then errors the stream, and asserts `failedSubmit.userMessage` joins both the original and queued text exactly as before the refactor that hoisted this computation out of the `isUserFacing` branch. Confirms the hoist in `handleErrorState` didn't change root/docker_root behavior.
- Verification:
  - `npx vitest run node/core/src/thread-core.test.ts node/core/src/providers/anthropic-agent-retry.test.ts`: 51/51 pass.
  - `npx tsgo -b`: passes.
  - `npx biome check --write .`: passes (two pre-existing formatting nits in the newly-added test code auto-fixed).
  - `npx vitest run` (full suite): same pre-existing failures as before (`node/magenta.test.ts > can switch profiles`, `node/chat/thread.test.ts > expands context update diff with = binding`) reconfirmed via `git stash`/rerun in isolation to be unaffected by these changes; `node/render-tools/spawn-subagents.test.ts` passes in isolation (17/17), confirming the flakiness noted in Stage 2. Additionally, `node/render-tools/docker-sync.test.ts` and `node/core/src/container/container.test.ts` failed in this run because the local Docker daemon was unresponsive (`docker ps`/`docker info` both timed out after 300s) — an environment infra issue unrelated to any code in this repo or this change.
