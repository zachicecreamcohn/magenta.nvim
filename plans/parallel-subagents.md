# Parallel Subagents Implementation Plan

## Overview

Currently, `spawn_subagent` is blocking - it waits for the subagent to complete before returning control to the parent. We want to change this to allow parallel execution:

- `spawn_subagent` should return immediately with a message like "Sub-agent started with ID: {threadId}"
- Add a new `wait_for_subagents` tool that accepts a list of thread IDs and blocks until all specified subagents complete
- This enables parents to spawn multiple subagents in parallel and then wait for all to finish

## Current Architecture Analysis

### Current Flow

- Parent calls `spawn_subagent` with prompt and options
- `SpawnSubagentTool` enters "preparing" state, then dispatches to create subagent thread
- When subagent thread is created, tool enters "running" state
- When subagent completes (yields or errors), tool enters "done" state
- Parent gets control back only after subagent fully completes

### Key Files to Modify

- `node/tools/spawn-subagent.ts` - Change to non-blocking behavior
- `node/tools/tool-registry.ts` - Add `wait_for_subagents` to tool list
- `node/tools/toolManager.ts` - Add new tool to tool map and initialization
- `node/chat/chat.ts` - Update subagent lifecycle handling

**New file to create:**

- `node/tools/wait-for-subagents.ts` - New blocking tool for waiting

## Implementation Steps

### Step 1: Modify spawn_subagent to be non-blocking

**In `node/tools/spawn-subagent.ts`:**

- [x] Change the `State` type to remove "running" state:

```typescript
export type State =
  | { state: "preparing" }
  | { state: "done"; result: ProviderToolResultContent };
```

- [x] Update the `spawnSubagent()` method to immediately finish when subagent is created:

  - [x] When receiving "subagent-created" message, transition directly to "done" with success result
  - [x] Move the logic that waits for subagent completion as a comment into a new node/tools/wait-for-subagents.ts file to save it for later

- [x] Update the result message to be informational rather than waiting for completion:

```typescript
result: {
 status: "ok",
 value: `Sub-agent started with ID: ${threadId}`
}
```

- [x] Remove `finish` message handling since we don't wait for completion anymore

### Step 2: Create wait_for_subagents tool

**Create `node/tools/wait-for-subagents.ts`:**

- [x] Input schema accepts array of thread IDs:

  ```typescript
  export type Input = {
    threadIds: ThreadId[];
  };
  ```

- [x] State tracks completion status of each thread:

  ```typescript
  export type State =
    | { state: "waiting" }
    | { state: "done"; result: ProviderToolResultContent };
  ```

- [x] A method to examine the chat threads that are blocking to see if they have results.
      This method should be called upon the tool being constructed (to catch situations where the target subagents have already yielded).
      We should also register a new action that can be used to get the tool to re-check its dependent threads.

- [x] Transition to "done" when all threads have completed
- [x] Aggregate results from all subagents into the result message.

### Step 3: Update tool registry and manager

**In `node/tools/tool-registry.ts`:**

- [x] Add "wait_for_subagents" to `ALL_TOOL_NAMES`
- [x] Add to `CHAT_TOOL_NAMES` (but not `SUBAGENT_TOOL_NAMES` to prevent recursive waiting)

**In `node/tools/toolManager.ts`:**

- [x] Add `wait_for_subagents` to `ToolMap` type
- [x] Add case in `init-tool-use` switch statement for the new tool
- [x] Update node/tools/helpers with appropriate validation, etc...
- [ ] iterate over project type errors until you fix them all

### Step 4: Update chat.ts

- [x] Add new "check-subagent-threads" message type to chat messages
- [x] Implement handleCheckSubagentThreads method to check thread completion status
- [x] Add "notify-wait-tool" message type to thread messages
- [x] Update thread.ts to handle notifying wait tools when results are ready
- [ ] Update handleYieldToParent to also notify any waiting tools that might be blocked on the yielding thread
- [ ] Test and fix any remaining type errors

## Implementation Details

### Message Flow for New System

- Parent: `spawn_subagent("task A")` → Returns immediately: "Sub-agent started with ID: 123"
- Parent: `spawn_subagent("task B")` → Returns immediately: "Sub-agent started with ID: 124"
- Parent: `wait_for_subagents([123, 124])` → Blocks until both complete
- Subagent 123: `yield_to_parent("result A")` → Notifies wait tool
- Subagent 124: `yield_to_parent("result B")` → Notifies wait tool, wait tool completes

### Error Handling

- If a subagent thread errors, the wait tool should capture that error for that thread ID
- If a requested thread ID doesn't exist, the wait tool should error immediately
- If a thread ID is not a subagent (no parent relationship), decide whether to error or ignore

### Backwards Compatibility

- Keep the old blocking behavior as fallback if needed
- Could add a flag to spawn_subagent to choose blocking vs non-blocking mode
- Or could phase out the old behavior entirely since this is more powerful

## Testing Strategy

Current tests are in `./node/chat/chat.spec.ts`

- [ ] Test non-blocking spawn behavior - verify parent gets control back immediately
- [ ] Test parallel spawning - create multiple subagents and verify they run concurrently
- [ ] Test wait tool with various scenarios:
  - [ ] All subagents succeed
  - [ ] Some subagents error
  - [ ] Invalid thread IDs
  - [ ] Mixed results
- [ ] Test integration - full parent → spawn multiple → wait → aggregate results flow
