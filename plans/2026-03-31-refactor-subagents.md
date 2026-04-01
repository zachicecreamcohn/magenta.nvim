# Context

## Objective

Simplify spawn_subagents so that its tool call never resolves prematurely due to a sub-thread error. Instead of maintaining mirrored progress state and using promise-based waiters, the tool should directly query sub-thread states whenever any sub-thread yields or changes. The tool call should only complete once **all** sub-threads have yielded.

This means:

- An Anthropic overloaded error in a sub-thread does NOT cause the spawn_subagents tool to complete for that element. The user can go into the sub-thread, resolve the issue, and instruct it to yield.
- The only terminal state the tool cares about is "yielded". Errors are visible in the UI but don't resolve the tool.

## Relevant files and entities

- `node/core/src/tools/spawn-subagents.ts`: The tool definition. Currently maintains `SpawnSubagentsProgress` with per-element state (pending/provisioning/running/completed), uses promises via `threadManager.waitForThread()` to track completion.
- `node/core/src/capabilities/thread-manager.ts`: `ThreadManager` interface with `spawnThread()`, `waitForThread()`, `yieldResult()`.
- `node/chat/chat.ts`: Implements `ThreadManager`. `waitForThread()` creates a promise, `resolveThreadWaiters()` resolves it on yield OR error. `getThreadResult()` queries thread state directly. `update()` calls `resolveThreadWaiters` when agent errors.
- `node/core/src/thread-core.ts`: `ActiveToolEntry` stores `handle: ToolInvocation` and `progress`. `maybeAutoRespond()` detects `yield_to_parent` and calls `submitToolResultsAndStop()`.
- `node/core/src/tool-types.ts`: `ToolInvocation = { promise, abort }`.
- `node/render-tools/spawn-subagents.ts`: Renders progress using `SpawnSubagentsProgress` and `Chat.getThreadSummary()`.
- `node/chat/thread-supervisor.ts`: `DockerSupervisor` — `onEndTurnWithoutYield()` auto-restarts docker threads that stop without yielding.

## Key insight

The render code (`node/render-tools/spawn-subagents.ts`) already queries thread state directly via `chat.getThreadSummary()` for the "running" state. The `SpawnSubagentsProgress` is only used to track the lifecycle (pending → provisioning → running → completed) and store threadIds. We can simplify by:

1. Having the progress object just store `{ threadIds, entries }` — the mapping from entries to spawned thread IDs.
2. Querying `chat.getThreadResult()` (or equivalent) to determine if all threads have yielded.
3. Replacing the promise-based `waitForThread` with an event-based check: whenever a sub-thread yields, check if ALL sub-threads for this tool have yielded, and if so, resolve the tool.

# Implementation

- [x] **Step 1: Change `ThreadManager.waitForThread` to `ThreadManager.onThreadYielded`**
  - [x] In `node/core/src/capabilities/thread-manager.ts`, replace `waitForThread(threadId): Promise<Result<string>>` with a callback-based API: `onThreadYielded(threadId: ThreadId, callback: () => void): void`. This registers a callback that fires whenever the given thread transitions to "yielded" state (not on error).
  - [x] Also add `getThreadResult(threadId: ThreadId): { status: "done"; result: Result<string> } | { status: "pending" }` to the `ThreadManager` interface so the tool can query state directly.
  - [x] Remove `yieldResult` from the interface (it's only used for programmatic yields, which we can handle differently).
  - [x] Fix type errors and iterate.

- [x] **Step 2: Simplify `SpawnSubagentsProgress`**
  - [x] In `node/core/src/tools/spawn-subagents.ts`, simplify the progress type to:
    ```typescript
    export type SubagentElementProgress =
      | { status: "pending" }
      | { status: "provisioning"; message: string }
      | { status: "spawned"; threadId: ThreadId };
    ```
    Remove the "running" vs "completed" distinction — once spawned, the thread's own state (queryable via `getThreadResult` / `getThreadSummary`) is the source of truth.
  - [x] Fix type errors and iterate.

- [x] **Step 3: Rewrite `spawn-subagents.ts` execute to use event-based completion**
  - [x] Replace the `processEntry` / `waitForThread` promise pattern. Instead:
    1. Spawn all threads (with concurrency control for provisioning/spawning only).
    2. Once all threads are spawned, store their threadIds in progress.
    3. Create a single promise that resolves when ALL threads have yielded. Use the `onThreadYielded` callback: each time a thread yields, check if all threads in this tool invocation have yielded (by calling `getThreadResult` on each). If all are done, resolve.
  - [x] The tool promise should ONLY resolve when all threads are yielded. Agent errors do NOT resolve it.
  - [x] Keep abort functionality: when aborted, resolve immediately with an error result.
  - [x] Fix type errors and iterate.

- [x] **Step 4: Update `Chat` to implement the new `ThreadManager` interface**
  - [x] In `node/chat/chat.ts`:
    - [x] Replace `waitForThread` implementation with `onThreadYielded`: register a callback that fires when the thread's mode becomes "yielded". Store callbacks in a map similar to current `threadWaiters`.
    - [x] Add `getThreadResult` to the public interface (it already exists, just needs to be exposed via the interface).
    - [x] In `update()`, remove the logic that calls `resolveThreadWaiters` on agent error (lines ~185-190). Only resolve/fire callbacks when `thread.core.state.mode.type === "yielded"`.
    - [x] Keep the `thread-error` (initialization failure) resolving behavior — if a thread can't even be created, we should still notify. But this should fire the callback so the tool can check state and see it never spawned.
  - [x] Fix type errors and iterate.

- [x] **Step 5: Update the render code**
  - [x] In `node/render-tools/spawn-subagents.ts`:
    - [x] Update `renderProgress` to work with the simplified `SubagentElementProgress` (no more "completed" state in progress — completion is derived from thread state).
    - [x] For "spawned" elements, query `chat.getThreadSummary()` as already done for "running" state.
    - [x] Remove handling of the old "completed" progress state.
  - [x] Fix type errors and iterate.

- [x] **Step 6: Update `buildResult`**
  - [x] In `spawn-subagents.ts`, update `buildResult` to query `getThreadResult` for each spawned thread to get the yield responses, rather than reading from progress element state.
  - [x] Fix type errors and iterate.

- [x] **Step 7: Handle edge cases**
  - [x] Thread initialization failures: if `spawnThread` throws, mark the element as an error in progress. The tool should still wait for other threads. Consider whether a thread that failed to spawn should block the tool forever — probably not, so track it as a non-blocking failure that gets included in the final result.
  - [x] Abort propagation: when the parent thread is aborted, the tool's abort handler fires, which should resolve the tool promise immediately. The existing abort cascade in `Chat.update()` already aborts child threads.
  - [x] Docker provisioning failures: these happen before the thread is spawned, so they should be tracked as spawn failures (same as above).

- [x] **Step 8: Write/update tests**
  - [x] Update any existing spawn_subagents tests to match the new behavior.
  - [x] Add a test case: sub-thread errors, user manually yields it → tool completes successfully.
  - [x] Add a test case: multiple sub-threads, one errors but tool waits for all to yield.
  - [x] Iterate until tests pass.

- [x] **Step 9: Clean up**
  - [x] Remove `threadWaiters` map from `Chat` if no longer needed (or repurpose for the callback approach).
  - [x] Remove `resolveThreadWaiters` if fully replaced.
  - [x] Remove `yieldResult` from `Chat` if no longer needed.
  - [x] Run `npx tsgo -b` and `npx biome check .` to verify no remaining issues.
