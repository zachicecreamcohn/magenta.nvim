# Context

The goal is to refactor ThreadCore from using injected callbacks (`ThreadCoreCallbacks`) to an event emitter pattern, where ThreadCore emits events and the chat-layer Thread wrapper subscribes to them.

## Current state

**`ThreadCoreCallbacks` interface** (thread-core.ts:80-86) has 5 callbacks:

- `onUpdate: () => void` — called when state changes (requestRender)
- `onPlayChime: () => void` — called when assistant finishes responding
- `onScrollToLastMessage: () => void` — called after sending a message
- `onSetupResubmit: (lastUserMessage: string) => void` — called on error to allow retry
- `onAgentMsg: (msg: AgentMsg) => void` — passed to agent for streaming messages

**`onContextUpdatesSent`** is a public optional callback property on ThreadCore (not part of the interface), set by the wrapper after construction.

**Callback invocation sites** in thread-core.ts:

- `this.callbacks.onUpdate()` — in `update()`, in `createTool` context as `requestRender`, in `startCompaction()` as `requestRender`
- `this.callbacks.onAgentMsg(msg)` — in `createFreshAgent()`, passed to provider.createAgent
- `this.callbacks.onPlayChime()` — in `handleProviderStopped()` and `handleProviderStoppedWithToolUse()`
- `this.callbacks.onSetupResubmit(text)` — in `handleErrorState()`
- `this.callbacks.onScrollToLastMessage()` — in `handleSendMessageRequest()`
- `this.onContextUpdatesSent?.(updates)` — in `sendMessage()` and `sendToolResultsAndContinue()`

**Chat-layer Thread** (thread.ts:241-259) wires these callbacks to dispatch calls and local methods.

## Relevant files

- `node/core/src/thread-core.ts`: ThreadCore class, ThreadCoreCallbacks interface, all callback invocation sites
- `node/chat/thread.ts`: Thread wrapper, subscribes to callbacks and forwards to dispatch
- `node/core/src/index.ts`: Core exports (will need to export event types)

## Existing patterns

The codebase uses Node.js `EventEmitter` in `attach.ts` for RPC, but it's internal. No general-purpose event emitter pattern exists. We should use a simple typed event emitter.

# Implementation

- [x] Define a `ThreadCoreEvents` type map and add typed event emitter methods to ThreadCore
  - [x] Define event map: `{ update: void, playChime: void, scrollToLastMessage: void, setupResubmit: string, agentMsg: AgentMsg, contextUpdatesSent: Record<string, unknown> }`
  - [x] Add `on(event, listener)`, `off(event, listener)`, and private `emit(event, data)` methods to ThreadCore
  - [x] Remove the `ThreadCoreCallbacks` interface
  - [x] Remove `callbacks` from the constructor parameter
  - [x] Remove `onContextUpdatesSent` public property
  - [x] Replace all `this.callbacks.onX()` calls with `this.emit("x", ...)`
  - [x] Replace `this.onContextUpdatesSent?.(...)` calls with `this.emit("contextUpdatesSent", ...)`
  - [x] For `createFreshAgent`, wrap the agent msg callback to emit the event
  - [x] Export `ThreadCoreEvents` from index.ts
  - [x] Check for type errors and iterate until they pass

- [x] Update chat-layer Thread to subscribe to events
  - [x] Remove the callbacks object from the ThreadCore constructor call
  - [x] After constructing `this.core`, call `this.core.on(...)` for each event
  - [x] Wire event handlers to the same dispatch/method calls currently in the callbacks object
  - [x] Remove the `this.core.onContextUpdatesSent = ...` assignment (now handled via `.on("contextUpdatesSent", ...)`)
  - [x] Check for type errors and iterate until they pass

- [x] Verify tests pass
  - [x] Run the build
  - [x] Run tests (1 pre-existing failure unrelated to these changes)
