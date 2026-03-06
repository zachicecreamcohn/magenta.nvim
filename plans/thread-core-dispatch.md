# context

The goal is to refactor `ThreadCore` so that all state mutations go through a central `update(action)` method, using a disjoint union `ThreadCoreAction` type. This gives us a single, obvious place to call `didUpdate()` after each state change, which the Thread wrapper can listen to for re-rendering.

Currently, `ThreadCore` mutates `this.state.*` in ~30 scattered locations across many methods. The `callbacks.onUpdate()` is called manually in a handful of places, making it easy to miss and causing test failures where views don't re-render after state changes.

## Relevant files

- `node/core/src/thread-core.ts`: The ThreadCore class (~890 lines). All state mutations need to be routed through `update()`.
- `node/chat/thread.ts`: Thread wrapper that creates ThreadCore and listens to callbacks. Needs to handle `didUpdate`.
- `node/core/src/index.ts`: Barrel exports from core — may need to export new action types.

## Key types

Current state shape (from `ThreadCore.state`):

```ts
{
  title?: string;
  threadType: ThreadType;
  systemPrompt: SystemPrompt;
  pendingMessages: InputMessage[];
  mode: ConversationMode;
  toolCache: ToolCache;
  edlRegisters: EdlRegisters;
  outputTokensSinceLastReminder: number;
  yieldedResponse?: string;
  teardownMessage?: string;
  tornDown?: boolean;
  compactionHistory: CompactionRecord[];
}
```

Current callbacks:

```ts
interface ThreadCoreCallbacks {
  onUpdate: () => void; // currently called manually in ~7 places
  onPlayChime: () => void;
  onScrollToLastMessage: () => void;
  onSetupResubmit: (lastUserMessage: string) => void;
  onAgentMsg: (msg: AgentMsg) => void;
}
```

## Design

### Action type

A disjoint union covering every state mutation:

```ts
type ThreadCoreAction =
  | { type: "set-title"; title: string }
  | { type: "set-mode"; mode: ConversationMode }
  | { type: "rebuild-tool-cache" }
  | { type: "cache-tool-result"; id: ToolRequestId; result: ProviderToolResult }
  | { type: "increment-output-tokens"; tokens: number }
  | { type: "reset-output-tokens" }
  | { type: "set-yielded-response"; response: string }
  | { type: "set-torn-down" }
  | { type: "push-pending-messages"; messages: InputMessage[] }
  | { type: "drain-pending-messages" }
  | { type: "push-compaction-record"; record: CompactionRecord }
  | { type: "reset-after-compaction" };
```

### `update(action)` method

Processes the action (pure state mutation), then calls `this.callbacks.onUpdate()`.

### Callbacks change

- Replace ad-hoc `onUpdate()` calls with the automatic `didUpdate` after every `update()`.
- Other callbacks (`onPlayChime`, `onScrollToLastMessage`, etc.) remain as explicit calls since they are side effects, not state updates.

# implementation

- [x] Define `ThreadCoreAction` type in `thread-core.ts`
  - All possible state mutations as discriminated union members
- [x] Add `update(action: ThreadCoreAction)` method to `ThreadCore`
  - Switch on action.type, apply state mutation
  - Call `this.callbacks.onUpdate()` after processing
- [x] Replace all direct `this.state.*` mutations with `this.update(...)` calls
  - `setTitle()`: `this.update({ type: "set-title", title })`
  - `rebuildToolCache()`: `this.update({ type: "rebuild-tool-cache" })`
  - `handleProviderStopped()`: increment-output-tokens, set-mode
  - `handleProviderStoppedWithToolUse()`: cache-tool-result (in promise), set-mode
  - `abortAndWait()`: set-mode
  - `handleSendMessageRequest()`: push-pending-messages
  - `maybeAutoRespond()`: drain-pending-messages
  - `submitToolResultsAndStop()`: set-mode, set-torn-down, set-yielded-response
  - `sendToolResultsAndContinue()`: set-mode, reset-output-tokens
  - `prepareUserContent()`: reset-output-tokens
  - `startCompaction()`: set-mode
  - `handleCompactionResult()`: set-mode, push-compaction-record
  - `handleCompactComplete()`: push-compaction-record, reset-after-compaction
- [x] Remove all manual `this.callbacks.onUpdate()` calls (they're now automatic in `update()`)
- [x] Keep `requestRender` in `CreateToolContext` (tools need it for intermediate progress)
  - Check all uses of `requestRender` in tool implementations and replace with appropriate mechanism
- [x] Fix up the Thread wrapper in `thread.ts`
  - The `onUpdate` callback already dispatches `tool-progress` which triggers a re-render
  - Verify this still works correctly
- [x] Update barrel exports in `core/src/index.ts` if needed
- [x] Check for type errors and iterate until they pass
- [x] Run the failing tests — same 5 pre-existing test pollution failures remain (not caused by this refactor)
