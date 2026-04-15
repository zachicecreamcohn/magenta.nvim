# Append "user aborted" message after abort

## Context

When the user aborts a running request, the conversation should include a user message
informing the agent that the user aborted. This way, when the conversation is continued,
the agent knows the previous turn was interrupted by the user rather than completing normally.

The abort message should appear **after** any tool results that are generated as part of the
abort cleanup (e.g., error tool_results for in-progress tool_use blocks).

### Current abort flow

1. User triggers abort → `ThreadCore.abort()` is called.
2. `ThreadCore.abortAndWait()`:
   a. Emits `"aborting"` event.
   b. Awaits `agent.abort()` — cancels streaming, agent's `cleanup()` handles incomplete
      blocks (adds error tool_results for incomplete tool_use blocks, removes empty blocks).
   c. If in `tool_use` mode: sends error tool_results for tools that hadn't cached results
      yet via `agent.toolResult()`, calls `agent.abortToolUse()`.
   d. Sets mode to `"normal"`.

### Where messages live

- Messages are stored in the Agent (`this.messages` in `anthropic-agent.ts`), as native
  Anthropic message format.
- `agent.appendUserMessage(content)` appends a new user message with the given content.
- The Agent interface is provider-agnostic — other providers (OpenAI, etc.) implement
  the same `Agent` interface.

### Relevant files

- `node/core/src/thread-core.ts`: `abortAndWait()` (lines 618-639) — orchestrates abort.
- `node/core/src/providers/provider-types.ts`: `Agent` interface, `AgentInput` type.
- `node/core/src/providers/anthropic-agent.ts`: `abort()`, `abortToolUse()`, `cleanup()`,
  `appendUserMessage()`.

## Implementation

- [ ] In `ThreadCore.abortAndWait()`, after all abort cleanup is done (after tool results
      are sent and `abortToolUse()` is called, or after `agent.abort()` if not in tool_use
      mode), but before setting mode to `"normal"`, call
      `this.agent.appendUserMessage([{ type: "text", text: "..." }])` with a message like:
      `"[The user aborted the previous request.]"`

      Specifically, the append should go right before the
      `this.update({ type: "set-mode", mode: { type: "normal" } })` line, so it is after:
      - `agent.abort()` (which handles incomplete streaming blocks and adds error tool_results
        for mid-stream tool_use blocks)
      - The tool_use cleanup loop (which adds error tool_results for tools that completed but
        weren't cached yet)
      - `agent.abortToolUse()` (which transitions agent status to stopped/aborted)

      This ensures the abort message comes after all tool_result messages in the conversation.

  - [ ] Also handle the case where the agent was **streaming** (not in tool_use mode) — the
        abort message should still be appended. The `cleanup()` in the agent may have already
        added tool_result error messages for incomplete tool_use blocks mid-stream, so the
        user message should go after those as well.

  - [ ] Emit `"update"` after appending the message so the UI re-renders with the new message.

- [ ] Add a test in `node/core/src/thread-core.test.ts` (or a new test file if more appropriate):
  - **Abort during streaming (no tool_use)**:
    - Setup: Start a conversation with a mock agent that is streaming.
    - Action: Call `threadCore.abort()`.
    - Assertion: The last user message in the conversation contains the abort text.
  - **Abort during tool_use**:
    - Setup: Start a conversation, agent stops with tool_use, tools are pending.
    - Action: Call `threadCore.abort()`.
    - Assertion: The conversation has tool_result error messages followed by a user message
      with the abort text.

- [ ] Run type checks (`npx tsgo -b`) and fix any issues.
- [ ] Run tests (`TEST_MODE=sandbox npx vitest run`) and fix any failures.
