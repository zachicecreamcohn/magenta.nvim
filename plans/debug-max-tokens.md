# Debug max_tokens recovery

## Context

### Objective

When the agent hits `max_tokens` (output token limit), the conversation enters a non-recoverable state. There are two root causes: (1) Bedrock model strings don't match the regex patterns used to determine max output tokens, causing a much-too-low default of 4096, and (2) when `max_tokens` does occur, the code doesn't handle the resulting dangling `tool_use` blocks or truncated text.

### Relevant files and entities

- `node/core/src/providers/anthropic-agent.ts` (lines 1221–1277): `getMaxTokensForModel()` and `getContextWindowForModel()` — regex-based model-to-limit mapping. Both use `^claude-` anchored patterns that fail for Bedrock strings like `us.anthropic.claude-3-5-sonnet-20241022-v2:0`.
- `node/core/src/thread-core.ts`:
  - `ThreadCore` class — orchestrates agents and tools, emits events.
  - `handleProviderStopped()` (lines 430–463) — dispatches on `stopReason`. Currently only special-cases `"tool_use"`, falling through to a `"normal"` mode for everything else including `"max_tokens"`.
  - `handleProviderStoppedWithToolUse()` (lines 465–569) — processes tool_use blocks, sends error results for malformed blocks, executes valid ones.
  - `maybeAutoRespond()` (lines 713–812) — checks whether to auto-respond based on mode and agent status. Returns a discriminated union.
  - `sendMessage()` (lines 624–670) — sends user/system messages to the agent.
  - `InputMessage` type (line 50) — `{ type: "user" | "system"; text: string }`.
- `node/core/src/thread-supervisor.ts`: `ThreadSupervisor` interface — `onEndTurnWithoutYield(stopReason)` returns a `SupervisorAction`.
- `node/core/src/providers/provider-types.ts` (line 27): `StopReason` type union including `"max_tokens"`.
- `node/core/src/providers/bedrock.ts`: `BedrockProvider` — extends `AnthropicProvider`, uses `AnthropicBedrock` client. Does not normalize model strings.
- `node/core/src/tools/helpers.ts` (lines 14–53): `validateInput()` — validates tool_use block inputs, returns `status: "ok"` or error.

## Implementation

### 1. Fix `getMaxTokensForModel` and `getContextWindowForModel` regex matching

- [ ] Add a `normalizeModelName` helper function in `node/core/src/providers/anthropic-agent.ts`:
  ```typescript
  function normalizeModelName(model: string): string {
    const match = model.match(/claude-[a-z0-9.-]+/);
    return match ? match[0] : model;
  }
  ```
  This extracts the `claude-*` portion from Bedrock-style strings like `us.anthropic.claude-3-5-sonnet-20241022-v2:0` → `claude-3-5-sonnet-20241022-v2`.
- [ ] Apply `normalizeModelName` at the top of `getMaxTokensForModel` and `getContextWindowForModel` so all regex matches work against the normalized string.
- [ ] Write unit tests for both functions with Bedrock model strings:
  - `us.anthropic.claude-3-5-sonnet-20241022-v2:0` → 8192 max tokens
  - `us.anthropic.claude-opus-4-6-v1:0` → 32000 max tokens
  - `global.anthropic.claude-sonnet-4-5-20250514-v1:0` → 32000 max tokens
  - Standard `claude-3-5-sonnet-20241022` still works → 8192
  - Unknown model `gpt-4` → 4096 (default)
- [ ] Run type checks (`npx tsgo -b`) and iterate until clean.

### 2. Write thread-core unit tests

- [ ] Create `node/core/src/thread-core.test.ts` with the following test cases. Study existing core tests (e.g. `node/core/src/tools/helpers.test.ts`) for test patterns.
  - [ ] **Test: `max_tokens` with partial tool_use block** — Use the mock provider's low-level streaming API (`emitEvent`) to partially stream a tool_use block: emit `content_block_start` (type: "tool_use"), emit an `input_json_delta` with incomplete JSON (e.g. `'{"filePath":'`), then call `finishResponse("max_tokens")` without emitting `content_block_stop`. This simulates how the real API truncates mid-block. Verify that `handleProviderStopped` routes to `handleProviderStoppedWithToolUse`, the malformed block gets an error `tool_result` via `agent.toolResult()`, and the agent auto-continues.
  - [ ] **Test: `max_tokens` with no tool_use blocks** — Mock agent stops with `"max_tokens"` and the last assistant message is text-only. Verify that `sendMessage` is called with a system continuation prompt.
- [ ] Run tests (`npx vitest run node/core/src/thread-core.test.ts`) and ensure the test fails. Before we fix the code, these cases should halt with a Malformed tool error.

### 3. Handle `max_tokens` stop reason in `handleProviderStopped`

- [ ] In `handleProviderStopped()`, add a check for `stopReason === "max_tokens"` before the existing fallthrough:
  - Get the last assistant message from `this.getProviderMessages()`.
  - Check if it contains any `tool_use` content blocks.
  - **If tool_use blocks exist**: call `this.handleProviderStoppedWithToolUse()` and return. This reuses the existing logic that already handles malformed blocks (sends error `tool_result`) and executes valid ones.
  - **If no tool_use blocks** (text was truncated): auto-continue by calling `this.sendMessage([{ type: "system", text: "Your previous response was truncated due to the output token limit. Please continue where you left off." }])` with `.catch(this.handleSendMessageError.bind(this))`, then return (don't fall through to the chime/supervisor logic).
- [ ] Run type checks and tests and iterate until clean.

### 4. Final validation

- [ ] Run full type check: `npx tsgo -b`
- [ ] Run full test suite: `npx vitest run node/core/`
- [ ] Run lint: `npx biome check .`
