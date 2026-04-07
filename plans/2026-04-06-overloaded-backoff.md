# context

## Objective

Implement exponential backoff with retry when Anthropic API requests return "overloaded" (HTTP 529) or rate limit (HTTP 429) errors. Retry schedule: 5s, 15s, 30s, then every 30s for up to 5 minutes total. If all retries fail, surface the error as today.

## Key types and interfaces

- `APIError` (from `@anthropic-ai/sdk/core/error`): Base error class with `.status` field. HTTP 529 (overloaded) → `InternalServerError` (status >= 500). HTTP 429 → `RateLimitError`.
- `Agent` interface (`node/core/src/providers/provider-types.ts`): Defines `continueConversation()` which initiates streaming, and emits `error` / `stopped` / `didUpdate` events.
- `AnthropicAgent` (`node/core/src/providers/anthropic-agent.ts`): Concrete Agent. The `continueConversation()` method at line ~379 calls `this.client.messages.stream()`. Errors caught in `.catch()` dispatch `{ type: "stream-error", error }` action. The `update()` state machine at line ~233 handles `stream-error` by emitting `"error"` event.
- `AnthropicProvider.forceToolUse()` (`node/core/src/providers/anthropic.ts` ~line 450): Separate code path for forced tool use (thread titles, etc). Also calls `this.client.messages.stream()`. Errors propagate as rejected promises.
- `ThreadCore` (`node/core/src/thread-core.ts`): Subscribes to Agent `"error"` event → calls `handleErrorState()` which logs and emits `setupResubmit`.

## Relevant files

- `node/core/src/providers/anthropic-agent.ts`: `continueConversation()` and `update()` state machine — where streaming errors are caught and routed
- `node/core/src/providers/anthropic.ts`: `forceToolUse()` — separate API call path that should also get retry
- `node/core/src/thread-core.ts`: `handleErrorState()` — where errors surface to the user. Will need to show retry status during backoff.
- `node_modules/@anthropic-ai/sdk/core/error.d.ts`: SDK error class hierarchy

## Design decisions

### Where to put retry logic

Retry logic lives directly inside `AnthropicAgent.continueConversation()` and `AnthropicProvider.forceToolUse()`. Since we only have one provider, no need to abstract into a separate utility.

### UI feedback

Instead of a new `AgentStatus` variant, add an optional `retryStatus` field to the existing `streaming` status: `{ type: "streaming"; startTime: Date; retryStatus?: RetryStatus }`. The agent is conceptually still "streaming" (trying to get a response), just waiting to retry. This avoids adding a new status variant and updating all exhaustive switches.

### What's retryable

An error is retryable if it's an `APIError` with `status === 429` (rate limit) or `status === 529` (overloaded).

### Retry schedule

Delays: [1000, 5000, 10000, 30000] then repeat 30000 every 30s.
Total timeout: 5 minutes (300000ms).
After the initial 4 retries (1+5+10+30 = 46s), ~8 more retries at 30s intervals before hitting the 5-minute wall.

# implementation

- [ ] Add `RetryStatus` type to `node/core/src/providers/provider-types.ts`
  - [ ] Define `RetryStatus = { attempt: number; nextRetryAt: Date; error: Error }`
  - [ ] Add optional `retryStatus?: RetryStatus` field to the `streaming` variant of `AgentStatus`

- [ ] Add retry logic directly in `AnthropicAgent` (`node/core/src/providers/anthropic-agent.ts`)
  - [ ] Add a private helper `isRetryableError(error: Error): boolean` — checks `error instanceof APIError` with status 429 or 529
  - [ ] Define constants: `RETRY_DELAYS = [1000, 5000, 10000, 30000]`, `MAX_RETRY_DURATION = 300_000`
  - [ ] Refactor `continueConversation()`:
    - Extract stream creation + `finalMessage()` into a factory that returns a `Promise<Anthropic.Message>`
    - On retryable error: update `this.status` to `{ type: "streaming", startTime, retryStatus: { attempt, nextRetryAt, error } }`, emit `didUpdate`, wait delay (respecting abort signal), then retry with a fresh stream
    - On non-retryable error or timeout: fall through to existing `stream-error` handling
    - On success: fall through to existing `stream-completed` handling
    - Clear `retryStatus` from status when a retry attempt starts (stream is active again)
  - [ ] Wire the agent's `AbortController` signal so abort cancels retry waits
  - [ ] Write unit tests (`node/core/src/providers/anthropic-agent-retry.test.ts`)
    - **non-retryable errors pass through immediately**: mock client rejects with 400 → agent emits `error` without retry
    - **retries on 529 with correct delays**: mock client fails 2x with 529, succeeds 3rd → agent emits `stopped`, verify timing
    - **retries on 429**: mock client fails with 429 → retries
    - **gives up after 5 min total**: mock timers, always fail 529 → eventually emits `error`
    - **abort during retry cancels immediately**: mock 529, abort during wait → agent emits `stopped` with `"aborted"`
    - **status shows retryStatus during wait**: verify `getState().status.type === "streaming"` with `retryStatus` populated during delay

- [ ] Add retry logic to `AnthropicProvider.forceToolUse()` (`node/core/src/providers/anthropic.ts`)
  - [ ] Extract the same `isRetryableError` and constants to a shared location (or import from anthropic-agent), or just duplicate the small helper inline
  - [ ] Wrap the `request.finalMessage()` call in a retry loop with same schedule
  - [ ] Wire abort through the existing `abort()` mechanism
  - [ ] Test: mock client fails with 529 twice, succeeds third → `forceToolUse` resolves

- [ ] Update view layer to display retry status
  - [ ] Find where `AgentStatus` is rendered in the view
  - [ ] When `status.type === "streaming"` and `status.retryStatus` is set, show "⏳ Server overloaded, retrying in Xs... (attempt N)"

- [ ] Run full type check (`npx tsgo -b`) and fix any issues
- [ ] Run full test suite
