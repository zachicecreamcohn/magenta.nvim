# Objective and Context

User request (verbatim):

> When I'm using bedrock or other providers, I'll see the request sit on streaming and seemingly without really doing anything. I think that happens either when I'm waiting on the stream request to start processing or when maybe waiting on retries or something like that, like exponential backoff type stuff.
>
> Let's take a look at the logic around where the request is made and where the retry logic is created and then expose that state out to the view on the streaming, where we show the streaming message. If the streaming has been going on for longer, if we've been waiting for longer than three seconds to hear back after sending a request, start showing a timer on an elapsed timer on the streaming. Also show any retry states or retry timeouts or things like that so it's clear when we're just waiting and the endpoint is slow or when we're encountering errors and retrying.
>
> We have a timer ticker on the bash command while it's executing that you can use for reference.

## What we're building

While the agent is streaming, the UI currently shows `Streaming response <animation frame>`. During "dead air" — after the request is sent but before the first stream event arrives, or while sitting in the exponential-backoff wait between retries — nothing re-renders, so the user can't tell whether the endpoint is slow or something is broken. We want to:

1. Show an **elapsed "waiting" timer** once we've gone >3s without hearing back from the server during streaming.
2. Make the existing **retry countdown** ("retrying in Ns... (attempt N)") actually tick down live, and surface the underlying error so it's clear we're retrying due to an error vs. just a slow endpoint.

The blocker for both is the same: there is no ticker driving re-renders while streaming, so any time-based status is frozen until the next stream event.

## Key entities

- `AgentStatus` (`node/core/src/providers/provider-types.ts:251`) — discriminated union; the `streaming` variant carries `startTime` and optional `retryStatus`.
- `RetryStatus` (`provider-types.ts:245`) — `{ attempt, nextRetryAt, error }`, already set during backoff waits.
- `AnthropicAgent` (`node/core/src/providers/anthropic-agent.ts`) — the only agent that produces `streaming` status (Bedrock also routes through it). `continueConversation()` / `runWithRetry()` (lines ~470-611) own the request + retry loop. Emits `didUpdate` which flows to the view.
- `renderStatus()` (`node/chat/thread-view.ts:80-117`) — renders the status line; already has a branch for `retryStatus` and a plain streaming branch.
- Reference ticker: bash command tool (`node/core/src/tools/bashCommand.ts:189-232` setInterval + cleanup; `node/render-tools/bashCommand.ts:49-55` elapsed rendering).

# Design

## Ticker (drives live re-renders)

Add a 1s heartbeat inside `AnthropicAgent`, started in `continueConversation()` and cleared when `runWithRetry()` settles (completed / aborted / error). Each tick simply calls `this.emit("didUpdate")`, which travels the existing chain (`didUpdate` -> ThreadCore `update` -> Thread `tool-progress` dispatch -> render). This mirrors the bash ticker, but lives in the agent because the dead-air (waiting on stream start / backoff) is a core concern. Keeping it in core means a single place handles both the waiting timer and the retry countdown.

### Ticker lifecycle (avoiding zombie tickers)

The interval ID is stored on the instance: `private tickInterval: ReturnType<typeof setInterval> | undefined`.

Two idempotent helpers, mirroring `bashCommand.ts`:

- `startTicker()` — first calls `stopTicker()` (defensive, so we never overlap two intervals), then sets `this.tickInterval = setInterval(() => this.emit("didUpdate"), 1000)`.
- `stopTicker()` — if `this.tickInterval !== undefined`, `clearInterval(it)` and set it back to `undefined`. Safe to call any number of times.

Start/stop wiring — there is exactly one start point and one stop chokepoint:

- **Start**: in `continueConversation()`, right after `update({ type: "start-streaming" })`. Because `startTicker()` first calls `stopTicker()`, even a (buggy) overlapping `continueConversation` cannot leak a second interval — the previous one is cleared before the new one is created.
- **Stop**: inside `resolveStreamingEnd()`. All three terminal transitions already route through it — `stream-completed` (anthropic-agent.ts:316), `stream-error` (:327), and `stream-aborted` (:338) — so the ticker is guaranteed to be cleared on success, error, and abort via a single line, with no per-branch duplication. `abort()` reaches this via the `stream-aborted` update.

Invariant: the ticker is always cleared via `resolveStreamingEnd()` (the same point that tears down `streamingEndPromise`), so a ticker can only ever be live while `streamingEndPromise` is pending. There is no code path that ends a turn without going through `resolveStreamingEnd()`.

Note: `setInterval` does not need `.unref()` here since it is short-lived and deterministically cleared; tests use fake timers and assert no emissions after the turn settles (Stage 1) to catch a leak.

## "Waiting to hear back" state

Add a `lastEventTime: Date` field to the `streaming` AgentStatus variant. Semantics: the timestamp of the most recent sign of life from the server during the current turn.

- Set to "now" at the start of each attempt (request sent) — covers the pre-first-event dead air.
- Updated to "now" on every received stream event (`content_block_start` / `delta` / `stop`) — so once data is flowing the waiting timer disappears.
- During a retry backoff wait, `retryStatus` is what's shown, so `lastEventTime` is not consulted there.

The heartbeat tick does NOT touch `lastEventTime` (it only forces a render).

## View

In `renderStatus()`'s streaming branch:

- If `retryStatus` is set: keep the countdown but recompute live (now it actually ticks). Append a short error indicator so it's clear we're retrying due to an error, e.g. `⏳ Retrying in Ns (attempt N) — <short error>`. Keep the message compact; don't dump stack traces.
- Else, compute `waited = Date.now() - lastEventTime`. If `waited > 3000`, show `Streaming response <frame> (waiting Ns)`; otherwise show the existing `Streaming response <frame>` unchanged.

Invariants:
- Ticker is always cleared exactly once when the turn ends; no leaked intervals across turns or aborts.
- `lastEventTime` only moves forward within a turn and is reset per turn.
- When data is actively streaming (deltas arriving each <3s), the waiting timer never appears.
- No new `any` types; `undefined` over `null`.

# Stages

## Stage 1 — Core state: lastEventTime + heartbeat ticker

- Goal: `AgentStatus.streaming` exposes `lastEventTime`; `AnthropicAgent` emits `didUpdate` once per second during a turn and stops cleanly on completion/abort/error; `lastEventTime` advances on each stream event.
- Verification (unit, `node/core/src/providers/anthropic-agent*.test.ts`, vitest fake timers):
  - Behavior: heartbeat emits `didUpdate` ~1/sec while streaming and stops after the turn settles.
    - Setup: mock client whose stream delays before first event / resolves after a controlled interval.
    - Actions: call `continueConversation()`, advance fake timers; count `didUpdate` emissions; let it complete and advance further.
    - Expected: emissions occur during the wait, and stop (no further emissions) after completion; no dangling interval.
  - Behavior: `lastEventTime` resets at attempt start and advances on stream events.
    - Setup: stream that emits a `content_block_delta` after a delay.
    - Actions: read `getState().status` before and after the event.
    - Expected: `lastEventTime` ~= request start before the event, then ~= event time after.
- Before moving on: confirm tests, `npx tsgo -b`, and `npx biome check .` pass.

## Stage 2 — View: waiting timer + live retry countdown

- Goal: `renderStatus()` shows `(waiting Ns)` after >3s of dead air, and a live, error-annotated retry countdown.
- Verification (unit on `renderStatus`, or integration via mock provider + driver per doc-testing skill):
  - Behavior: streaming with `lastEventTime` 4s ago renders a `(waiting 4s)` suffix; 1s ago renders no suffix.
  - Behavior: streaming with `retryStatus` renders the countdown + attempt + short error, and updates as time advances.
    - Setup: build `AgentStatus` values directly (pure function) or drive a mock provider that errors then retries.
    - Expected: rendered text matches the waiting/retry formats; plain streaming under 3s is unchanged.
- Before moving on: confirm tests, `npx tsgo -b`, and `npx biome check .` pass.
