# Sandbox Bypass (per-thread-tree, toggled at root)

## Context

The goal is to add a per-thread-tree "sandbox bypass" toggle that:
- Disables all sandbox wrapping and approval prompts for the entire thread tree
- One flag per thread tree, stored on the root thread
- Toggling from any thread in the tree toggles at the root (walks up via `getRootAncestorId`)
- Sub-agents inherit bypass via a getter that reads from the root
- Is off by default
- Displayed prominently (red) in the input winbar when active

### Relevant files and entities

- `node/capabilities/sandbox-shell.ts` — `SandboxShell.execute()` is the decision point for sandbox wrapping. Bypass short-circuits all sandbox wrapping, approval patterns, and violation monitoring.
- `node/capabilities/sandbox-file-io.ts` — `SandboxFileIO.isWriteBlocked()` checks write permissions. Bypass skips write approval prompts.
- `node/environment.ts` — `createLocalEnvironment()` constructs `SandboxShell` and `SandboxFileIO` per thread. Needs to accept and pass through an `isBypassed` callback.
- `node/chat/thread.ts` — `Thread` class. Root threads own the mutable `sandboxBypassed` boolean. Sub-agent threads get a getter that reads from the root.
- `node/chat/chat.ts` — `Chat.createThreadWithContext()` creates threads with environments. `Chat.spawnThread()` creates sub-agent threads. `Chat.handleForkThread()` creates forked threads.
- `node/magenta.ts` — `Magenta.command()` handles `:Magenta <command>`. New `sandbox-bypass` command toggles on the root thread.
- `node/sidebar.ts` — `getInputWindowTitle()` renders the input winbar. Needs to show red bypass indicator.
- `node/nvim/extmarks.ts` — Highlight group definitions. May need a new `MagentaSandboxBypass` group for red text.

## Design

### Thread tree model

- Every `Thread` has a `sandboxBypassed: boolean` field (default `false`). Only meaningful on root threads.
- Every `Thread` has a `get isSandboxBypassed(): boolean` getter:
  - If the thread has a parent, delegate to `parent.isSandboxBypassed` (recursive traversal to root).
  - If the thread is a root (no parent), return `this.sandboxBypassed`.
- Thread gets a new optional `getParentThread?: () => Thread | undefined` in its constructor context. Root threads don't have this; sub-agent threads do.
- The `isBypassed` callback passed to `createLocalEnvironment` is `thread.isSandboxBypassed.bind(thread)`.
- When the user runs `:Magenta sandbox-bypass`, we find the active thread, walk up to the root via the getter chain, and toggle `sandboxBypassed` on the root.
- Forked threads (`handleForkThread`) are independent roots — they get their own `sandboxBypassed` initialized from the source thread's current value.

### Display

- `getInputWindowTitle()` appends ` %#ErrorMsg# SANDBOX OFF %#Normal#` when bypass is active on the current thread tree's root.
- The `%#ErrorMsg#` statusline syntax renders the text in red (ErrorMsg highlight group). `%#Normal#` resets back to normal.
- `Sidebar` gets a new callback `getIsSandboxBypassed: () => boolean` to check the active thread's root bypass state.

## Implementation

- [ ] **1. Add `isBypassed` callback to `SandboxShell`**
  - Add required `isBypassed: () => boolean` to the `context` parameter of the `SandboxShell` constructor.
  - At the top of `execute()`, before the sandbox status check, add:
    ```typescript
    if (this.context.isBypassed()) {
      return this.spawnCommand(command, opts);
    }
    ```
  - This skips all sandbox wrapping, approval pattern checks, and violation monitoring.
  - Update all existing call sites (including tests) to pass `isBypassed: () => false` where bypass is not needed.
  - **Test** (`sandbox-shell.test.ts`): Add a test that creates a `SandboxShell` with `isBypassed: () => true` and a ready sandbox. Execute a command that would normally match `requireApprovalPatterns`. Assert it runs directly without approval prompt or `wrapWithSandbox`.

- [ ] **2. Add `isBypassed` callback to `SandboxFileIO`**
  - Add required `isBypassed: () => boolean` as a 4th constructor parameter.
  - In `isWriteBlocked()`, at the top: `if (this.isBypassed()) return false;`
  - This means `writeFile()` will never call `promptForWriteApproval` when bypassed.
  - Update all existing call sites (including tests) to pass `() => false` where bypass is not needed.
  - **Test** (`sandbox-file-io.test.ts`): Add a test that creates a `SandboxFileIO` with `isBypassed: () => true` and a sandbox config that would block writes. Assert `isWriteBlocked()` returns `false`.

- [ ] **3. Wire `isBypassed` through `createLocalEnvironment()`**
  - Add required `isBypassed: () => boolean` to the params of `createLocalEnvironment()`.
  - Pass it to `SandboxShell` constructor context and `SandboxFileIO` constructor.
  - All call sites must provide this callback.

- [ ] **4. Add `sandboxBypassed` and `isSandboxBypassed` to `Thread`**
  - Add `public sandboxBypassed = false` to the `Thread` class.
  - Add optional `getParentThread?: () => Thread | undefined` to the constructor's `context` parameter.
  - Add a getter:
    ```typescript
    get isSandboxBypassed(): boolean {
      const parent = this.context.getParentThread?.();
      if (parent) return parent.isSandboxBypassed;
      return this.sandboxBypassed;
    }
    ```

- [ ] **5. Wire `isBypassed` in `Chat.createThreadWithContext()`**
  - The challenge: `createLocalEnvironment` is called before the Thread is constructed, so we can't pass `() => thread.isSandboxBypassed` directly. Use a mutable ref:
    ```typescript
    const bypassRef = { get: () => false };
    const env = createLocalEnvironment({ ..., isBypassed: () => bypassRef.get() });
    const thread = new Thread(...);
    bypassRef.get = () => thread.isSandboxBypassed;
    ```
  - This keeps the ref internal to `createThreadWithContext` — no new fields on `Environment`.

- [ ] **6. Pass `getParentThread` in `Chat.spawnThread()`**
  - When constructing the child thread, pass `getParentThread` in context:
    ```typescript
    getParentThread: () => {
      const wrapper = this.threadWrappers[parentThreadId];
      return wrapper?.state === "initialized" ? wrapper.thread : undefined;
    }
    ```
  - The child's `isSandboxBypassed` getter will automatically traverse up to the root.
  - The child's environment `isBypassed` callback uses the same ref pattern from step 5, pointing to `thread.isSandboxBypassed`.

- [ ] **7. Handle `Chat.handleForkThread()`**
  - Forked threads are new roots (no `getParentThread`).
  - Initialize `thread.sandboxBypassed` to the source thread's current `isSandboxBypassed` value.

- [ ] **8. Add `sandbox-bypass` command in `Magenta.command()`**
  - New case `"sandbox-bypass"` that dispatches a thread message:
    ```typescript
    case "sandbox-bypass": {
      const activeThreadId = this.chat.state.activeThreadId;
      if (activeThreadId) {
        this.dispatch({
          type: "thread-msg",
          id: activeThreadId,
          msg: { type: "toggle-sandbox-bypass" },
        });
      }
      break;
    }
    ```
  - Add `{ type: "toggle-sandbox-bypass" }` to Thread's `Msg` union.
  - In `Thread.myUpdate`, handle `"toggle-sandbox-bypass"` by walking to the root and toggling:
    ```typescript
    case "toggle-sandbox-bypass": {
      let root: Thread = this;
      while (root.context.getParentThread?.()) {
        root = root.context.getParentThread!();
      }
      root.sandboxBypassed = !root.sandboxBypassed;
      return;
    }
    ```
  - Because this goes through `dispatch`, it triggers a re-render, which updates the sidebar winbar via `renderInputHeader()`.
  - **Test** (`thread.test.ts` or new `sandbox-bypass.test.ts`):
    - `isSandboxBypassed` traversal: Create a mock thread chain (root → child → grandchild) using `getParentThread` callbacks. Set `root.sandboxBypassed = true`. Assert `grandchild.isSandboxBypassed === true`. Toggle root off, assert grandchild reads `false`.
    - Toggle from child targets root: Dispatch `toggle-sandbox-bypass` to a child thread. Assert `root.sandboxBypassed` flipped. Child's own `sandboxBypassed` unchanged.

- [ ] **9. Add `Chat.isSandboxBypassed()` for sidebar**
  - Helper that gets the active thread and returns `thread.isSandboxBypassed`.
  - Used by the sidebar callback. Returns `false` when no active thread.

- [ ] **10. Show bypass indicator in sidebar input header**
  - Add a `getIsSandboxBypassed: () => boolean` callback to the `Sidebar` constructor.
  - In `getInputWindowTitle()`, when `this.getIsSandboxBypassed()` returns true, append:
    ```typescript
    return bypassed
      ? `${baseTitle} [${tokenDisplay} tokens] %#ErrorMsg# SANDBOX OFF %#Normal#`
      : `${baseTitle} [${tokenDisplay} tokens]`;
    ```
  - The `%#ErrorMsg#` / `%#Normal#` syntax works in winbar strings (they use statusline-style formatting).
  - Wire the callback in `Magenta` where Sidebar is constructed: `() => this.chat.isSandboxBypassed(this.chat.state.activeThreadId)` (returns false when no active thread).

- [ ] **11. Register the command**
  - `:Magenta sandbox-bypass` should work automatically since all `:Magenta <arg>` commands are forwarded generically. Verify this is the case by checking the lua command registration.
  - **Integration test** (using `withDriver()`): Open sidebar, send `:Magenta sandbox-bypass`. Assert the input winbar contains "SANDBOX OFF". Send `:Magenta sandbox-bypass` again. Assert the indicator is gone.

