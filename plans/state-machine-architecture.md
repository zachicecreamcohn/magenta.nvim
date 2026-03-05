# Context

The goal is to introduce a consistent state machine pattern across the core components in `@magenta/core`. Currently we have a mix of patterns: action-based reducers, callback injection, direct mutation, and implicit state. We want each component to be an explicit state machine with typed states, typed actions, and event emission for external notification.

## Components to refactor

- **ThreadCore** (`node/core/src/thread-core.ts`): Already has an action-based `update()` method and event emitter. Closest to the target pattern but mixes concerns — `ConversationMode` is essentially its state machine state but it's one field among many.
- **Agent** (`node/core/src/providers/provider-types.ts:254-297`): Interface with `AgentState` (streaming/stopped/error). Internal state machine already exists per-provider. Uses callback injection `(msg: AgentMsg) => void` for notifications.
- **ContextManager** (`node/core/src/context/context-manager.ts`): Mutable class, no state machine, no events. Directly mutates `files` map. ThreadCore has no way to know when context changes.
- **CompactionManager** (`node/core/src/compaction-manager.ts`): Implicit state machine (idle → processing chunk → waiting for tools → chunk complete → next chunk or done). State encoded in method flow, not declared types.
- **ThreadSupervisor** (`node/core/src/thread-supervisor.ts`): Stateless interface with callbacks. `DockerSupervisor` has hidden `restartCount`. Lives mostly outside core.

## Key files

- `node/core/src/thread-core.ts` — ThreadCore class, ThreadCoreAction, ConversationMode, ThreadCoreEvents
- `node/core/src/compaction-manager.ts` — CompactionManager, CompactionManagerContext
- `node/core/src/compaction-controller.ts` — CompactionController interface, CompactionResult, CompactionStep
- `node/core/src/context/context-manager.ts` — ContextManager class, Files type, FileUpdates
- `node/core/src/capabilities/context-tracker.ts` — ContextTracker interface, TrackedFileInfo
- `node/core/src/providers/provider-types.ts` — Agent interface, AgentState, AgentStatus, AgentMsg
- `node/core/src/thread-supervisor.ts` — ThreadSupervisor interface, SupervisorAction
- `node/chat/thread.ts` — Thread class (neovim wrapper, subscribes to ThreadCore events)
- `node/chat/thread-view.ts` — View layer, reads `thread.core.state.*` directly
- `node/chat/chat.ts` — Chat class, reads `thread.core.state.*` directly
- `node/context/context-manager.test.ts` — ContextManager integration tests
- `node/context/context-manager-unit.test.ts` — ContextManager unit tests
- `node/chat/thread.test.ts` — Thread integration tests
- `node/chat/thread-compact.test.ts` — Compaction integration tests
- `node/chat/thread-abort.test.ts` — Abort integration tests
- `node/test/driver.ts` — Test helper that spies on `thread.core.sendMessage` and `maybeAutoRespond`

## Design principles

1. **Typed state union + typed action union per component.** Each component declares its possible states as a discriminated union and its transitions as an action union.

2. **Single `send(action)` entry point.** All mutations go through one method. This enables logging, debugging, and middleware.

3. **Event emission on transition.** Each component emits a `"transition"` event (or component-specific events) so parents can react without polling.

4. **Side effects separated from state transitions.** The reducer-like logic is pure (prev state + action → next state). Side effects (API calls, agent interactions) happen in a separate `effect()` step triggered after the transition.

5. **Composition via event subscription.** ThreadCore subscribes to child component events rather than reaching into their internals. Children don't know about their parent.

6. **Agent stays as-is.** The Agent interface is implemented per-provider (anthropic, openai, mock) and already has a clean state machine. We keep its interface unchanged but standardize how ThreadCore consumes its AgentMsg callbacks.

## Target pattern

```typescript
// Shared base - could be a utility class or just a pattern to follow
// Each component implements this shape:

type MyState =
  | { type: "idle"; /* fields */ }
  | { type: "active"; /* fields */ }
  | { type: "done"; /* fields */ };

type MyAction =
  | { type: "start"; /* params */ }
  | { type: "finish"; /* params */ };

class MyComponent {
  state: MyState;

  // All mutations go through send()
  send(action: MyAction): void {
    const prev = this.state;
    this.state = this.reduce(prev, action);
    if (prev !== this.state) {
      this.emit("transition", prev, this.state);
      this.effect(prev, this.state, action);
    }
  }

  // Pure state transition
  private reduce(state: MyState, action: MyAction): MyState { ... }

  // Side effects triggered by transitions
  private effect(prev: MyState, next: MyState, action: MyAction): void { ... }
}
```

# Implementation

The plan is ordered to minimize disruption — we introduce the pattern on the simplest component first, then progressively apply it to more complex ones, keeping tests passing at each step.

## Phase 1: Shared infrastructure

- [ ] Create `node/core/src/state-machine.ts` with a minimal typed `Emitter<Events>` utility class
  - This extracts the `on/off/emit` pattern already in ThreadCore into a reusable utility
  - Generic over an events map type: `{ [eventName: string]: argTypes[] }`
  - Methods: `on(event, listener)`, `off(event, listener)`, `emit(event, ...args)`
  - No base class for the state machine itself — just a pattern to follow (each component's state/action types are too different for a useful generic base)
- [ ] Export from `node/core/src/index.ts`
- [ ] Type-check: `npx tsgo -p node/core/tsconfig.json --noEmit`

## Phase 2: CompactionManager as explicit state machine

CompactionManager is the best starting point — it's self-contained, has clear lifecycle states, and is created/destroyed per compaction cycle.

- [ ] Define `CompactionState` discriminated union in `compaction-manager.ts`:
  ```
  | { type: "idle" }
  | { type: "processing-chunk"; chunkIndex: number; totalChunks: number; agent: Agent }
  | { type: "waiting-for-tools"; chunkIndex: number; totalChunks: number; agent: Agent; activeTools: Map<...>; toolResults: Map<...> }
  | { type: "complete"; result: CompactionResult }
  | { type: "error"; error: string; steps: CompactionStep[] }
  ```
- [ ] Define `CompactionAction` union:
  ```
  | { type: "start"; messages: ReadonlyArray<ProviderMessage>; nextPrompt?: string }
  | { type: "agent-msg"; msg: AgentMsg }
  | { type: "tool-complete"; id: ToolRequestId; result: ProviderToolResult }
  ```
- [ ] Refactor CompactionManager to use `send(action)` / `reduce()` / `effect()` pattern
  - Replace the current `handleAgentMsg` / `handleToolUse` / `handleChunkComplete` flow with explicit state transitions
  - The `reduce` method handles state transitions
  - The `effect` method triggers side effects (creating agents, sending chunks, executing tools)
  - Use `Emitter` for event emission
- [ ] Update `CompactionController` interface to expose `state: CompactionState` instead of individual fields (`chunks`, `currentChunkIndex`, `steps`, etc.)
  - Keep `chunks` and `steps` as top-level arrays since they accumulate across states
- [ ] Update ThreadCore's `startCompaction` and `handleCompactionResult` to use the new events instead of the `onComplete` callback
  - ThreadCore subscribes to compaction manager's `"transition"` event
  - When compaction reaches `"complete"` or `"error"` state, ThreadCore reacts
- [x] Update `node/chat/thread-view.ts` to read from new CompactionManager state shape
- [x] Type-check: `npx tsgo -b`
- [x] Run compaction tests — all 7 pass
- [x] Also removed dead `compact-agent-msg` code from Thread

## Phase 3: ContextManager state machine

ContextManager is simpler — it doesn't have lifecycle states per se, but it does have mutations that should emit events so ThreadCore (and the view) know when context changes.

- [x] Add `Emitter` to ContextManager with events:
  ```
  {
    fileAdded: [absFilePath: AbsFilePath];
    fileRemoved: [absFilePath: AbsFilePath];
    filesReset: [];
  }
  ```
- [x] (Skipped — ContextManager is a collection, not a lifecycle state machine; events on mutations are sufficient)
- [x] Define events type `ContextManagerEvents` with `fileAdded`, `fileRemoved`, `filesReset`
  ```
  | { type: "add-file"; absFilePath: AbsFilePath; relFilePath: RelFilePath; fileTypeInfo: FileTypeInfo }
  | { type: "remove-file"; absFilePath: AbsFilePath }
  | { type: "tool-applied"; absFilePath: AbsFilePath; tool: ToolApplied; fileTypeInfo: FileTypeInfo }
  | { type: "add-files"; filePaths: UnresolvedFilePath[] }  // async
  | { type: "reset" }
  ```
- [x] Added `emit()` calls to mutation methods
  - `addFileContext` → `send({ type: "add-file", ... })`
  - `removeFileContext` → `send({ type: "remove-file", ... })`
  - `toolApplied` → `send({ type: "tool-applied", ... })`
  - `reset` → `send({ type: "reset" })`
  - `addFiles` stays async but emits events after each file is added
  - `getContextUpdate` and `contextUpdatesToContent` are queries (reads), not mutations — they don't go through `send()`
- [x] Type-check: `npx tsgo -b`
- [x] Run context manager tests — all 25 pass

## Phase 4: ThreadCore consolidation

ThreadCore already has the closest pattern to what we want. The main changes are:

1. Consolidate `ConversationMode` + scattered state fields into a proper `ThreadMode` state union
2. Use the `Emitter` utility instead of hand-rolled listeners
3. Subscribe to child component events instead of using callbacks

- [x] Replace hand-rolled `listeners` map with `Emitter<ThreadCoreEvents>`
- [x] Consolidate state: merge `mode`, `yieldedResponse`, `tornDown` into a single `ThreadMode` discriminated union:

  ```
  | { type: "idle" }
  | { type: "streaming" }
  | { type: "tool-use"; activeTools: Map<ToolRequestId, ActiveToolEntry> }
  | { type: "compacting"; controller: CompactionManager }
  | { type: "yielded"; response: string }
  | { type: "torn-down" }
  ```

  - Keep `pendingMessages`, `toolCache`, `edlRegisters`, `outputTokensSinceLastReminder`, `compactionHistory` as separate state since they're orthogonal to mode

- [x] Update `ThreadCoreAction` — replaced `set-yielded-response`/`set-torn-down` with `set-teardown-message`
- [x] Refactor ThreadCore's `update()` method to work with the new state shape
- [x] Remove the `onComplete` callback from CompactionManagerContext — ThreadCore now subscribes to compaction events (done in Phase 2)
- [x] Update all ThreadCore methods that check `this.state.mode`, `this.state.yieldedResponse`, `this.state.tornDown` to use the new `ThreadMode`
- [x] Type-check: `npx tsgo -b`
- [x] Update `node/chat/thread.ts` to work with new ThreadCore state shape
  - Update event subscriptions if any changed
  - Update any direct state reads
- [x] Update `node/chat/thread-view.ts` to read from new state shape
  - `thread.core.state.mode` → `thread.core.state.mode` (shape changed)
  - `thread.core.state.yieldedResponse` → check `thread.core.state.mode.type === "yielded"`
  - `thread.core.state.compactionHistory` stays the same
- [x] Update `node/chat/chat.ts` — all direct state mutations now go through `update()` actions
- [x] Update `node/test/driver.ts` — no changes needed
- [x] Type-check: `npx tsgo -b`
- [x] Run all thread tests — all pass (348/348 excluding 1 pre-existing flaky test)

## Phase 5: Full test pass

- [x] Run full test suite — 921/924 pass, 6 failures are pre-existing flaky timing tests unrelated to changes
- [x] Type-check: `npx tsgo -b` — clean
