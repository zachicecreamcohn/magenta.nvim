# Context

The goal is to enhance the `wait_for_subagents` tool view to show detailed real-time information about each subthread it's waiting for, instead of just showing "Waiting for X subagent(s) to complete".

Currently, the tool only shows basic waiting status. We want to show:

1. For each subthread: whether it has yielded or not
2. If not yielded: what the thread state is (stopped, in-flight, error, etc.)
3. If stopped: what the stop reason is
4. Real-time updates as subthread states change

## Key types and interfaces:

**ConversationState** (from node/chat/thread.ts): Union type representing different thread states including:

- `message-in-flight`: Thread is currently processing
- `compacting`: Thread is compacting
- `stopped`: Thread stopped with reason (end_turn, aborted, tool_use)
- `error`: Thread encountered an error
- `yielded`: Thread yielded to parent with response

**Chat.getThreadResult()**: Returns thread completion status and result, but only indicates "done" vs "pending"

**WaitForSubagentsTool**: Current implementation only checks if threads are done/pending, doesn't access detailed state

**ToolInterface**: Basic interface that tools must implement

## Relevant files:

- `node/tools/wait-for-subagents.ts`: The tool that needs enhancement
- `node/chat/chat.ts`: Contains Chat class with thread management and getThreadResult method
- `node/chat/thread.ts`: Contains Thread class with detailed ConversationState
- `node/root-msg.ts`: Message dispatch system (may need new message types)

# Implementation

- [x] Extend Chat class to provide detailed thread state information

  - [x] Add new method `getThreadSummary(threadId: ThreadId)` that returns full thread wrapper state
  - [x] This method should return thread title, conversation state, stop reason, etc.
  - [x] Handle edge cases for non-existent thread IDs

- [x] Enhance WaitForSubagentsTool to access and display detailed thread information

  - [x] Modify constructor to store reference to chat for accessing thread details
  - [x] Update `view()` method to show detailed per-thread status
    - [x] Create helper method `renderThreadStatus(threadId: ThreadId)` for individual thread rendering
    - [x] Show thread ID, title (if available), and current state for each thread
    - [x] Use different icons/indicators for different states (✅ yielded, ⏳ in-flight, ❌ error, ⏹️ stopped)
    - [x] For stopped threads, show the stop reason
    - [x] For error threads, show truncated error message
    - [x] For yielded threads, show truncated response
    - [x] Handle edge cases like missing threads gracefully
    - [x] Iterate until you get no compilation/type errors

- [ ] Test the enhanced functionality
  - [ ] update existing tests in `node/chat/chat.spec.ts` to pass
  - [ ] add a new test that verifies that the in-progress view updates as threads progress and yield
  - [ ] Iterate until all tests pass

## Implementation Details

### New Chat Method Structure:

```typescript
getThreadSummary(threadId: ThreadId): {
  title?: string;
  status:
    | { type: "pending" }
    | { type: "running" }
    | { type: "stopped"; reason: string }
    | { type: "yielded"; }
    | { type: "error"; message: string };
}
```

### Enhanced View Structure:

```
⏸️⏳ Waiting for 3 subagent(s):
- [42] Analyze code: ⏳ streaming response
- [43] Fix bugs: ⏹️ stopped (tool_use)
- [44] Write tests: ❌ error: Connection timeout
```

### Real-time Update Flow:

1. on any dispatch
2. WaitForSubagentsTool receives re-render notification
3. This causes the view to be re-evaluated, and new thread summaries to be fetched
