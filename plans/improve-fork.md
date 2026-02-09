# context

The goal is to allow `@fork` to work at any time without aborting the source thread.

Currently, `@fork` is detected in `Thread.handleSendMessageMsg()` (node/chat/thread.ts ~line 749). It dispatches a `"fork-thread"` message to `Chat`, which calls `Chat.handleForkThread()` (node/chat/chat.ts ~line 640). That method **aborts the source thread** if it's streaming or in tool_use mode before cloning.

`AnthropicAgent.clone()` (node/providers/anthropic-agent.ts ~line 270) currently **rejects** cloning if:

1. The agent is streaming (`status.type === "streaming"`)
2. The agent is stopped on tool_use (`status.stopReason === "tool_use"`)

The `cleanup()` method (node/providers/anthropic-agent.ts ~line 367) shows how to handle incomplete state during abort:

- Clears `currentAnthropicBlock` (the in-progress streaming block)
- If the last block is a `server_tool_use`, pops it off
- If the last block is a `tool_use`, adds an error `tool_result` user message
- Filters out empty/incomplete blocks (empty text, empty thinking)
- Removes the assistant message entirely if it ends up empty

The relevant files and entities are:

- `node/providers/anthropic-agent.ts`: `AnthropicAgent.clone()` - needs to support cloning from any state
- `node/providers/anthropic-agent.ts`: `AnthropicAgent.cleanup()` - reference for how to handle incomplete blocks
- `node/providers/provider-types.ts`: `Agent` interface - `clone()` signature
- `node/chat/chat.ts`: `Chat.handleForkThread()` - orchestrates the fork, currently aborts source first
- `node/chat/thread.ts`: `Thread.handleSendMessageMsg()` - detects `@fork`, currently goes through the "busy → abort" path

# implementation

- [ ] Update `AnthropicAgent.clone()` to support cloning from any state
  - [ ] Remove the streaming guard — allow cloning while streaming
    - Deep-copy `this.messages` as before
    - If `currentAssistantMessage` exists (being built during streaming), include a snapshot of it in the cloned messages (with only the finalized blocks from `content`, excluding the in-progress `currentAnthropicBlock`)
    - Clean up the cloned assistant message:
      - Drop any `server_tool_use` blocks (these are built-in Anthropic tools like web_search that can't have tool_results)
      - For any `tool_use` blocks, add an error `tool_result` user message: "The thread was forked before the tool could execute."
      - Filter out empty text/thinking blocks
      - Remove the assistant message if it ends up empty
    - Set the cloned agent's status to `{ type: "stopped", stopReason: "end_turn" }` so it's ready to receive new messages
  - [ ] Remove the tool_use guard — allow cloning while stopped on tool_use
    - Deep-copy `this.messages` as before
    - Add error `tool_result` user messages for each `tool_use` block (similar to abort behavior) — Anthropic requires a `tool_result` for every `tool_use`
    - Set the cloned agent's status to `{ type: "stopped", stopReason: "end_turn" }`
  - [ ] Extract a helper method `cleanupClonedMessages(messages)` that applies the cleanup logic to a cloned message array, to avoid duplicating code with `cleanup()`
  - [ ] Run type checks: `npx tsc --noEmit`
  - [ ] Update clone unit tests in `node/providers/anthropic-agent.test.ts` (existing tests at line ~1347):
    - [ ] Delete existing "throws when cloning while streaming" test
    - [ ] Add test: clone while streaming with partial text block — cloned messages should not include the incomplete text
    - [ ] Add test: clone while streaming with finalized text + streaming tool_use — cloned messages should include the text but not the tool_use
    - [ ] Add test: clone while streaming with finalized server_tool_use block — cloned messages should drop the server_tool_use block
    - [ ] Add test: clone while stopped on tool_use — cloned agent has error `tool_result` for each `tool_use` block, status `stopped/end_turn`, source agent unchanged
    - [ ] Add test: clone while streaming — source agent continues streaming unaffected after clone
    - [ ] Iterate until clone unit tests pass

- [ ] Update `Chat.handleForkThread()` to not abort the source thread
  - [ ] Remove the `abortAndWait()` call — the source thread should continue undisturbed
  - [ ] The clone now handles any state, so just call `sourceAgent.clone(dispatch)` directly
  - [ ] Run type checks: `npx tsc --noEmit`

- [ ] Move `@fork` detection out of `Thread` and into `magenta.ts` / `Chat`
  - [ ] In `magenta.ts` `"send"` case (~line 305): check if `text` starts with `@fork`. If so, strip the prefix and dispatch `chat-msg / fork-thread` with `sourceThreadId` from the active thread and the stripped messages, instead of dispatching `thread-msg / send-message`
  - [ ] Remove the `@fork` detection from `Thread.handleSendMessageMsg()` (~line 749 in thread.ts) — it should no longer handle this case
  - [ ] `Chat.handleForkThread()` already handles the rest
  - [ ] Run type checks: `npx tsc --noEmit`

- [ ] Update integration tests in `node/chat/thread.test.ts` (existing fork tests at line ~212):
  - [ ] Update "forks a thread while streaming" test (~line 284) — source thread should NOT be aborted, should still be streaming after fork. Update snapshot.
  - [ ] Update "forks a thread while waiting for tool use" test (~line 337) — source thread should NOT be aborted, tools should still be pending. Cloned thread should have error tool_results. Update snapshot.
  - [ ] Existing "forks a thread with multiple messages" test (~line 212) should still pass (idle fork)
  - [ ] Iterate until all integration tests pass
