# Debug max_tokens recovery

## Context

### Objective

Two issues with `max_tokens` handling:

1. Bedrock model strings don't match regex patterns for max output tokens (already fixed).
2. When `max_tokens` occurs, dangling tool_use blocks and truncated text aren't handled (partially fixed — `handleProviderStopped` now routes `max_tokens`, but one test still fails).

Additionally, our `MockStream` hand-rolls event accumulation logic that diverges from the real Anthropic SDK's `MessageStream`. This has been a recurring source of test/production mismatch. We want to replace the mock's internals with a real `MessageStream` driven via `ReadableStream`, while keeping the same external test API.

### Relevant files and entities

- `node/core/src/providers/mock-anthropic-client.ts`: `MockStream` class — current mock that hand-rolls event accumulation and `finalMessage()`. `MockAnthropicClient` — creates `MockStream` instances when `messages.stream()` is called.
- `node/core/src/providers/anthropic-agent.ts`: `AnthropicAgent` — uses `client.messages.stream()` which returns a `MessageStream`. It calls `.on("streamEvent", cb)`, `.finalMessage()`, `.controller.signal.aborted`, and `.abort()` on the stream.
- `node/providers/mock.ts`: `MockProvider` — root-layer wrapper around `MockAnthropicClient`. Exposes `awaitPendingStream()`, `awaitPendingStreamWithText()`, etc. Returns `MockStream` instances.
- `node/core/src/thread-core.ts`: `ThreadCore.handleProviderStopped()` — routes `max_tokens` to tool_use handling or continuation prompt.
- `node/core/src/thread-core.test.ts`: Unit tests for max_tokens handling — 2 pass, 1 fails (truncated tool_use block).

### Key SDK internals (from `@anthropic-ai/sdk`)

- `MessageStream` (`node_modules/@anthropic-ai/sdk/src/lib/MessageStream.ts`): The real stream class. Accumulates events via `#accumulateMessage`, uses `partialParse` for incomplete JSON in `input_json_delta`, emits `streamEvent`. `finalMessage()` resolves after all events are processed.
- `MessageStream.fromReadableStream(readable)`: Static factory that creates a real `MessageStream` from a `ReadableStream` of newline-delimited JSON `MessageStreamEvent` objects. Drives the full real accumulation/event pipeline.
- `partialParse` (`node_modules/@anthropic-ai/sdk/src/_vendor/partial-json-parser/parser.ts`): Lenient JSON parser that strips dangling tokens and closes open braces. E.g. `'{"filePath":'` → `{}`.
- `Stream.fromReadableStream` (`node_modules/@anthropic-ai/sdk/src/core/streaming.ts`): Lower-level stream that parses newline-delimited JSON from a `ReadableStream`. Each line is `JSON.parse`'d into a `MessageStreamEvent`.

### Architecture of the new mock

The new `MockStream` keeps its existing public API (`streamText()`, `streamToolUse()`, `finishResponse()`, `respond()`, `emitEvent()`, etc.) but internally pushes newline-delimited JSON events into a `ReadableStream`, which feeds a real `MessageStream.fromReadableStream()`. The real `MessageStream` handles all event accumulation, `partialParse`, and `finalMessage()` assembly.

```
Test code                    MockStream                    Real MessageStream
─────────                    ─────────                     ──────────────────
stream.streamText("hi") ──→ pushes content_block_start,   ──→ #accumulateMessage
                             content_block_delta,               builds snapshot
                             content_block_stop as JSON    ──→ emits "streamEvent"

stream.finishResponse() ──→ pushes message_delta,         ──→ #accumulateMessage
                             message_stop as JSON,              sets stop_reason
                             closes ReadableStream         ──→ _emitFinal, finalMessage resolves
```

The `MockStream` returned by `MockAnthropicClient.messages.stream()` wraps the real `MessageStream`, delegating `.on("streamEvent", ...)`, `.finalMessage()`, `.abort()`, and `.controller` to the real instance.

## Implementation

### 1. Rewrite `MockStream` to drive a real `MessageStream`

- [ ] In `node/core/src/providers/mock-anthropic-client.ts`, rewrite `MockStream`:
  - [ ] Constructor creates a `ReadableStream<Uint8Array>` with a stored controller ref, plus a real `MessageStream` via `MessageStream.fromReadableStream(readable)`.
  - [ ] Add a private `pushEvent(event: MessageStreamEvent)` method that JSON-stringifies the event + `\n`, encodes to UTF-8, and enqueues on the `ReadableStream` controller.
  - [ ] Add a private `closeStream()` method that calls `controller.close()` on the `ReadableStream`.
  - [ ] Keep the `params` constructor arg and the `messages` / `systemPrompt` / `getProviderMessages()` accessors unchanged.
  - [ ] Delegate `.on("streamEvent", cb)` to the real `MessageStream.on("streamEvent", ...)`. Note: the real stream's callback signature is `(event, snapshot)` — we just forward it.
  - [ ] Delegate `.finalMessage()` to the real `MessageStream.finalMessage()`.
  - [ ] Delegate `.abort()` to the real `MessageStream.abort()`.
  - [ ] Expose `.controller` from the real `MessageStream`.

- [ ] Rewrite the high-level helpers to push real SSE event sequences:
  - [ ] `streamText(text)`: push `message_start` (if first block), `content_block_start` (text), `content_block_delta` (text_delta), `content_block_stop`. Track whether `message_start` has been emitted.
  - [ ] `streamToolUse(id, name, input)`: push `content_block_start` (tool_use), `content_block_delta` (input_json_delta), `content_block_stop`.
  - [ ] `streamThinking(thinking, signature)`: push `content_block_start` (thinking), `content_block_delta` (thinking_delta), optionally `content_block_delta` (signature_delta), `content_block_stop`.
  - [ ] `streamRedactedThinking(data)`: push `content_block_start` (redacted_thinking), `content_block_stop`.
  - [ ] `streamServerToolUse(id, name, input)`: push `content_block_start` (server_tool_use), `content_block_delta` (input_json_delta), `content_block_stop`.
  - [ ] `streamWebSearchToolResult(toolUseId, content)`: push `content_block_start` (web_search_tool_result), `content_block_stop`.
  - [ ] `emitEvent(event)`: push the raw event directly (for fine-grained test control).
  - [ ] `nextBlockIndex()`: return the next block index (unchanged).
  - [ ] `finishResponse(stopReason, usage)`: push `message_delta` (with stop_reason and usage), push `message_stop`, call `closeStream()`. Do NOT manually construct a `Message` object — the real `MessageStream` does this.
  - [ ] `respondWithError(error)`: abort the real stream and reject somehow. May need to close the readable stream with an error or abort the controller.
  - [ ] `respond({text, toolRequests, stopReason, usage})`: compose calls to the above helpers (unchanged logic).

- [ ] Handle `message_start` emission:
  - [ ] The real `MessageStream` requires a `message_start` event before any content blocks. Track whether it's been sent; auto-emit on the first `streamText`/`streamToolUse`/etc. call.
  - [ ] The `message_start` event needs a `Message` stub with `id`, `type: "message"`, `role: "assistant"`, empty `content`, `model`, `stop_reason: null`, usage stub.

- [ ] Remove the old manual accumulation logic:
  - [ ] Remove `finalMessageDefer`, `contentBlocks`, `openBlock`, `openBlockInputJson` fields.
  - [ ] Remove `applyDeltaToOpenBlock` method.
  - [ ] Remove the manual `emit` method that tracked open blocks.

- [ ] Keep `resolved` and `aborted` properties working:
  - [ ] `resolved`: track whether `finishResponse` has been called (stream is closed).
  - [ ] `aborted`: delegate to `realStream.controller.signal.aborted`.

### 2. Update `MockAnthropicClient`

- [ ] `messages.stream()` should still create a `MockStream` with the params and return it. The `MockStream` now wraps a real `MessageStream` internally but presents the same interface.
- [ ] `messages.countTokens()` stays the same.
- [ ] `awaitStream()` stays the same.

### 3. Update `MockMessageStream` interface

- [ ] Review the `MockMessageStream` interface. It currently defines `on(event, callback)`, `finalMessage()`, and `abort()`. Update it to match whatever the new `MockStream` exposes, or remove it if no longer needed (since `MockStream` now wraps a real `MessageStream`).

### 4. Fix the thread-core test

- [ ] The truncated tool_use test should now work correctly because:
  - The real `MessageStream` requires `message_start` before content blocks.
  - If we emit `content_block_start` + `content_block_delta` (partial JSON) + then `message_delta` + `message_stop` (skipping `content_block_stop`), the real `MessageStream` will include the block in the snapshot with `partialParse`'d input.
  - Actually: the real API always sends `content_block_stop`. Update the test to use `content_block_stop` and rely on `partialParse` producing `{}` for incomplete JSON, which will fail input validation and route through the error path.
- [ ] Verify all 3 thread-core tests pass.

### 5. Run anthropic-agent tests

- [ ] Run `npx vitest run node/core/src/providers/anthropic-agent.test.ts` (the heaviest user of low-level `MockStream` methods — 33 `emitEvent` calls, 29 `finishResponse`, etc.).
- [ ] Fix any failures. Likely issues:
  - Tests that check `stream.finalMessage()` return value — now returns the real assembled `Message` from the SDK.
  - Tests that use `emitEvent` without a preceding `message_start` — need to ensure `message_start` is auto-emitted.
- [ ] Iterate until all tests pass.

### 6. Run integration tests

- [ ] Run `npx vitest run node/chat/` and `npx vitest run node/tools/` — these use the high-level `respond()` method via `MockProvider`.
- [ ] Fix any failures. The `respond()` method should work transparently since it composes `streamText` + `streamToolUse` + `finishResponse`.
- [ ] Iterate until all tests pass.

### 7. Full validation

- [ ] `npx tsgo -b` — type checks pass
- [ ] `npx vitest run` — all tests pass
- [ ] `npx biome check .` — lint passes
