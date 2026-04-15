# context

When the main thread terminates (e.g. user closes neovim or aborts), all subagent threads end up in "aborted" state even if they already completed and yielded their results.

## Root cause

When a parent thread is aborted, `Chat.update` (node/chat/chat.ts:144-162) cascades abort to ALL child threads with `state === "initialized"`, regardless of whether they've already yielded. Then `ThreadCore.abortAndWait` (node/core/src/thread-core.ts:614-637) unconditionally sets mode to `"normal"` at the end, overwriting the `"yielded"` mode. After that, `Chat.getThreadResult` (node/chat/chat.ts:749-813) returns `{ status: "pending" }` since the thread is no longer yielded.

## Relevant files and entities

- `node/core/src/thread-core.ts`: `ThreadCore.abort()` and `ThreadCore.abortAndWait()` — the core abort logic. `abortAndWait` unconditionally sets mode to `"normal"` at the end (line 636).
- `node/core/src/thread-core.ts`: `ThreadMode` — discriminated union with types `"normal"`, `"tool_use"`, `"compacting"`, `"yielded"`.
- `node/chat/thread.ts`: `Thread.myUpdate` case `"abort"` — calls `this.abortAndWait()` without checking current mode.
- `node/chat/chat.ts`: `Chat.update` — cascades abort to child threads without checking if they've yielded.
- `node/chat/chat.ts`: `Chat.getThreadResult` — returns `"done"` only when mode is `"yielded"` or agent is in error state; everything else returns `"pending"`.

# implementation

- [ ] Guard `ThreadCore.abort()` to be a no-op when already yielded
  - At the top of `ThreadCore.abort()` in `node/core/src/thread-core.ts`, add an early return if `this.state.mode.type === "yielded"`. This is the single defensive point that prevents a yielded thread from ever having its mode overwritten by abort, regardless of the caller.
  - [ ] Write a unit test for `ThreadCore` that:
    - Drives a thread to yielded state
    - Calls `abort()`
    - Asserts mode is still `"yielded"` with the original response preserved
  - [ ] Check for type errors with `npx tsgo -b`
  - [ ] Run tests and iterate until they pass

- [ ] Guard the abort cascade in `Chat.update` to skip yielded children
  - In `node/chat/chat.ts:144-162`, add a check `threadWrapper.thread.core.state.mode.type !== "yielded"` to the condition, so we don't even send abort messages to already-completed subagents. This is a clarity/efficiency improvement on top of the core guard.
  - [ ] Write an integration test that:
    - Sets up a parent thread with a child subagent thread
    - Drives the child to yielded state
    - Aborts the parent
    - Asserts the child's mode is still `"yielded"`
    - Asserts `getThreadResult()` returns `{ status: "done" }` for the child
  - [ ] Check for type errors with `npx tsgo -b`
  - [ ] Run tests and iterate until they pass
