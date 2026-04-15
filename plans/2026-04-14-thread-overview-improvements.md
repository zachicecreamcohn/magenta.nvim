# Thread Overview Improvements

## Context

The goal is to improve the thread overview UI with three changes:
1. Collapse sub-agent threads by default, showing only root threads. Expand subtrees with `=`.
2. Show all pending permission requests from the entire subtree under a collapsed root thread.
3. Order root threads by latest user message sent (most recent on top).

### Relevant files and entities

- `node/chat/chat.ts`: `Chat` class — manages all threads, renders the thread overview. Contains `ThreadWrapper` type (tracks `parentThreadId`, `depth`, `state`), `ChatState`, `Msg`, and rendering methods (`renderThreadOverview`, `renderThreadSubtree`, `renderThread`, `buildChildrenMap`).
- `node/chat/thread.ts`: `Thread` class — individual thread with `sandboxViolationHandler` property. `Msg` type includes `send-message` which is the user message dispatch.
- `node/chat/thread-view.ts`: `view` function — renders the full thread view including `sandboxViolationHandler.view()` for violations.
- `node/capabilities/sandbox-violation-handler.ts`: `SandboxViolationHandler` — manages pending permission requests. Has `getPendingViolations()` returning `Map<string, PendingViolation>` and `view()` returning `VDOMNode`.
- `node/root-msg.ts`: `RootMsg` — discriminated union of all message types.
- `node/magenta.ts`: Central dispatch loop, `getActiveKey()`, `selectThreadEffect()`.

### Key observations

- Thread IDs are UUIDv7 (timestamp-ordered), so `Object.entries(threadWrappers)` currently yields threads in creation order.
- `ThreadWrapper` has `parentThreadId: ThreadId | undefined` and `depth: number`.
- `buildChildrenMap()` already creates a `Map<ThreadId, ThreadId[]>` for parent→children lookup.
- `sandboxViolationHandler` is `undefined` for docker threads (they run in isolation).
- The overview re-renders on every `dispatch` call through the TEA cycle.

## Implementation

- [ ] **Add `expandedThreads` state and `lastActivityTime` to Chat**
  - Add `expandedThreads: Set<ThreadId>` field to `Chat` class, initialized to empty set in constructor.
  - Add `lastActivityTime: number` field to `ThreadWrapper` type (alongside `parentThreadId` and `depth`). Initialize to `Date.now()` wherever `ThreadWrapper` is created (`createThreadWithContext`, `handleForkThread`).

- [ ] **Add new messages for expand/collapse**
  - Add `{ type: "toggle-thread-expand"; id: ThreadId }` to `Chat.Msg`.
  - In `myUpdate`, handle `toggle-thread-expand`: toggle the thread ID in/out of `expandedThreads` set.

- [ ] **Track `lastActivityTime` on root threads**
  - In `Chat.update()`, when processing a `thread-msg` with `msg.msg.type === "send-message"`, find the root ancestor of the target thread and update its `lastActivityTime` to `Date.now()`.
  - Add a private helper `getRootAncestorId(threadId: ThreadId): ThreadId` that walks `parentThreadId` up to the root.

- [ ] **Update `renderThreadOverview` to collapse subtrees and sort by activity**
  - Collect root threads (those with `parentThreadId === undefined`) into an array.
  - Sort the array by `lastActivityTime` descending (most recent first).
  - For each root thread:
    - If the root has children (check `childrenMap`), show an expand indicator: `▶` if collapsed, `▼` if expanded.
    - Add `=` keybinding on the root thread line to dispatch `toggle-thread-expand`.
    - If expanded (root ID is in `expandedThreads`), render children via `renderThreadSubtree` as before.
    - If collapsed and root has subtree pending violations, render the aggregated violation views below the root line.
  - testing:
    - Create a mock Chat with multiple root threads and subthreads. Verify only root threads are displayed by default. Verify `=` toggles child visibility. Verify ordering is by latest activity.

- [ ] **Collect and render subtree violations for collapsed roots**
  - Add a private helper `collectSubtreeViolationHandlers(threadId: ThreadId, childrenMap: Map<ThreadId, ThreadId[]>): SandboxViolationHandler[]` that recursively walks the subtree collecting all initialized threads' `sandboxViolationHandler` instances that have pending violations.
  - In `renderThreadOverview`, for collapsed root threads with children, call this helper. If any handlers have pending violations, render each handler's `view()` below the root thread line with appropriate indentation.
  - testing:
    - Create a root thread with subthreads that have pending violations. Verify violations appear under the root when collapsed. Verify violations disappear from the overview when the root is expanded (they'd be visible in the thread view instead).

- [ ] **Update `renderThread` to show expand indicator and child count**
  - Accept `childrenMap` and `isExpanded` parameters (or compute from Chat state).
  - For root threads with children, prefix the line with `▶`/`▼` and append a child count like `(3 subthreads)`.
  - Add `=` keybinding alongside existing `<CR>` binding.

- [ ] **Verify type-checking passes**
  - Run `npx tsgo -b` and fix any type errors.

- [ ] **Write tests**
  - Unit test for `getRootAncestorId`: chain of 3 threads, verify root is returned from any level.
  - Unit test for ordering: create 3 root threads, send messages in specific order, verify `renderThreadOverview` outputs them in the correct activity order.
  - Integration test (if feasible with `withDriver`): create a thread, send a message, verify overview shows it at top. Create a second thread, verify ordering updates.
