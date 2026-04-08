# Per-Thread Buffers

## Context

### Objective

Move from a single display buffer / single input buffer to **per-thread buffer pairs**, so that:

- Jump navigation (ctrl-o / ctrl-i) works properly within a thread's display buffer
- Switching threads swaps which buffer is shown in the display/input windows (via `nvim_win_set_buf`)
- Unsubmitted input text is preserved when switching threads
- The thread overview gets its own dedicated display buffer
- Only the currently visible buffer is re-rendered; background buffers are marked dirty and re-rendered on switch
- Display and input windows stay synced: switching one switches the other

### Current Architecture

**Sidebar (`node/sidebar.ts`)**:

- Owns a single `displayBuffer`, `displayWindow`, `inputBuffer`, `inputWindow`
- `show()` creates (or reuses) one display buffer and one input buffer
- Buffers persist across hide/show cycles (stored on the `hidden` state)

**TEA App (`node/tea/tea.ts`)**:

- `createApp()` creates an `App<Model>` with a single `View` function
- `app.mount(mountPoint)` binds the app to a single buffer + position range
- `render(msg)` re-renders the VDOM into that single buffer
- Keybindings are registered per-buffer via `listenToBufKey`

**Chat (`node/chat/chat.ts`)**:

- `Chat.view()` returns either `renderThreadOverview()` or `renderActiveThread()` depending on `ChatState`
- Thread switching sets `activeThreadId`, then re-render overwrites the single buffer with the new thread's content
- This destroys jump history because the buffer content is fully replaced

**Magenta (`node/magenta.ts`)**:

- Owns one `chatApp: TEA.App<Chat>` and one `mountedChatApp: TEA.MountedApp`
- `dispatch()` calls `mountedChatApp.render(msg)` on every message
- Sidebar toggle mounts the chat app to `buffers.displayBuffer`

### Key Types and Interfaces

```typescript
// tea/tea.ts
type MountedApp = {
  onKey(key: BindingKey): Promise<void>;
  render(msg: unknown): void;
  unmount(): void;
  getMountedNode(): MountedVDOM;
  waitForRender(): Promise<void>;
  renderVersion: number;
};

// tea/view.ts
interface MountPoint {
  nvim: Nvim;
  buffer: NvimBuffer;
  startPos: Position0Indexed;
  endPos: Position0Indexed;
}

// sidebar.ts - visible state
{
  state: "visible";
  displayBuffer: NvimBuffer;
  inputBuffer: NvimBuffer;
  displayWindow: NvimWindow;
  displayWidth: number;
  inputWindow: NvimWindow;
}

// chat/chat.ts
type ChatState =
  | { state: "thread-overview"; activeThreadId: ThreadId | undefined }
  | { state: "thread-selected"; activeThreadId: ThreadId };
```

### Relevant Files

- `node/sidebar.ts` — window/buffer lifecycle, show/hide/toggle
- `node/magenta.ts` — dispatch loop, TEA app creation/mounting, command handling
- `node/tea/tea.ts` — TEA app lifecycle (createApp, mount, render, unmount)
- `node/tea/view.ts` — MountPoint, mountView, VDOM rendering
- `node/chat/chat.ts` — Chat controller, thread switching, view routing
- `node/chat/thread.ts` — Thread controller, core event bridging
- `node/chat/thread-view.ts` — Thread view function
- `node/root-msg.ts` — RootMsg, SidebarMsg types
- `node/nvim/buffer.ts` — NvimBuffer (setLines, create, setOption, keymaps)
- `node/nvim/window.ts` — NvimWindow (buffer(), setCursor, etc.)

## Implementation

### Step 1: Add `setBuffer` to NvimWindow

Add a convenience method to `NvimWindow` for switching which buffer is displayed:

```typescript
async setBuffer(buffer: NvimBuffer): Promise<void> {
  await this.nvim.call("nvim_win_set_buf", [this.id, buffer.id]);
}
```

**Testing**: Unit-level — verify `nvim_win_set_buf` is called with correct args.

---

### Step 2: Introduce BufferManager

Create `node/buffer-manager.ts` with a `BufferManager` class that owns the per-thread buffer pairs and the overview buffer. This replaces the single-buffer ownership currently in Sidebar.

```typescript
type ThreadBufferEntry = {
  displayBuffer: NvimBuffer;
  displayMountedApp: TEA.MountedApp | undefined; // lazily mounted on first view
  inputBuffer: NvimBuffer;
};

class BufferManager {
  private threadBuffers: Map<ThreadId, ThreadBufferEntry>;
  private overviewBuffer: NvimBuffer | undefined;
  private overviewMountedApp: TEA.MountedApp | undefined;
  private activeBufferKey: ThreadId | "overview" | undefined;

  // Eagerly create buffer pair for a thread (called when thread is created)
  async registerThread(threadId: ThreadId): Promise<ThreadBufferEntry>;

  // Get existing buffer pair
  getThreadBuffers(threadId: ThreadId): ThreadBufferEntry | undefined;

  // Lazily mount TEA app for a thread's display buffer (called on first switch)
  async ensureMounted(threadId: ThreadId): Promise<TEA.MountedApp>;

  // Get or create overview buffer
  async getOrCreateOverviewBuffer(): Promise<{
    buffer: NvimBuffer;
    mountedApp: TEA.MountedApp;
  }>;

  // Get active buffer key
  getActiveKey(): ThreadId | "overview" | undefined;
  setActiveKey(key: ThreadId | "overview"): void;

  // Switch buffers in windows
  async switchToThread(
    threadId: ThreadId,
    displayWindow: NvimWindow,
    inputWindow: NvimWindow,
  ): Promise<void>;
  async switchToOverview(
    displayWindow: NvimWindow,
    inputWindow: NvimWindow,
  ): Promise<void>;
}
```

Responsibilities:

- **Eagerly** creating display + input NvimBuffers when a thread is registered (so subagent threads get buffers immediately)
- Setting buffer options (bufhidden, buftype, swapfile, filetype, keymaps, name)
- **Lazily** mounting a TEA app per display buffer (only on first switch to that thread)
- Performing the window buffer swap via `nvim_win_set_buf`

The overview gets special input buffer handling — it can reuse a shared "empty/disabled" input buffer, or we can just show the active thread's input buffer even when viewing the overview. Decision: **show the active thread's input buffer** when viewing overview, since that's what the user will type into when they hit send.

**Testing**: Unit test — create manager, registerThread returns buffers, getThreadBuffers returns same entry on second call.

---

### Step 3: Refactor Sidebar to use BufferManager

Change `Sidebar` to:

- No longer own `displayBuffer` / `inputBuffer` directly
- Own a `BufferManager` as a direct class property (not part of the state union)
- `show()` creates windows but delegates buffer creation/selection to BufferManager
- `hide()` closes windows but BufferManager retains all buffers
- Remove the single-buffer state from `hidden`/`visible` states

`BufferManager` lives as `sidebar.bufferManager` and persists for the lifetime of the Sidebar, independent of show/hide cycles.

New Sidebar state:

```typescript
state:
  | { state: "hidden" }
  | {
      state: "visible";
      displayWindow: NvimWindow;
      displayWidth: number;
      inputWindow: NvimWindow;
    };
bufferManager: BufferManager; // direct property, always available
```

The `getMessage()` method needs to know which input buffer to read from. It should read from the **active thread's input buffer** (via `bufferManager.getActiveThreadBuffers()`).

**Testing**: Integration test — toggle sidebar, verify windows appear, toggle again, verify windows close but buffers survive.

---

### Step 4: One TEA App per display buffer

Currently there's a single `chatApp` with a single `View: () => this.chat.view()` that switches between overview and thread views.

Change to: **one TEA app per display buffer**, each with its own view function.

- **Overview buffer**: TEA app with `View: () => this.chat.renderThreadOverview()`
- **Thread buffer**: TEA app with `View: () => this.chat.renderActiveThread()` (scoped to that thread's id)

Actually, to minimize the refactor, each thread's TEA app view function should be:

```typescript
// For thread display buffer
View: () => chat.renderSingleThread(threadId);
```

Where `renderSingleThread(threadId)` is a new method extracted from `renderActiveThread()` that always renders that specific thread (no state check needed since the buffer _is_ the thread).

The overview TEA app:

```typescript
View: () => chat.renderThreadOverview();
```

This means `Chat.view()` is no longer needed — the routing between overview and thread is now handled by which buffer is in the window, not by the view function.

**Key change in dispatch**: Instead of calling `mountedChatApp.render(msg)` on every message, we need to:

1. Determine which mounted app is active
2. Render only the active buffer's mounted app
3. Background buffers are skipped — they get a render when switched to

Logic:

- Only the active buffer's `mountedApp.render(msg)` is called
- On buffer switch, always trigger a render (TEA diff handles no-ops cheaply)
- `sidebar-msg` → no buffer rendering, just scroll/input operations

**Testing**: Create two threads, verify each has its own mounted app. Send a message to thread A while viewing thread B — only thread B's app renders.

---

### Step 5: Wire up buffer switching on thread select

When `select-thread` is dispatched:

1. `Chat.myUpdate` sets `activeThreadId` as before
2. The dispatch loop in `Magenta` detects the thread change
3. Calls `bufferManager.switchToThread(threadId, displayWindow, inputWindow)` which:
   - Calls `nvim_win_set_buf` on display window with thread's display buffer
   - Calls `nvim_win_set_buf` on input window with thread's input buffer
   - Triggers a render on the newly active buffer
   - Sets `activeBufferKey`

For `threads-overview` / `threads-navigate-up` (when going to overview):

1. Calls `bufferManager.switchToOverview(displayWindow, inputWindow)` which:
   - Swaps display window to overview buffer
   - Keeps input window on active thread's input buffer
   - Triggers a render on the overview buffer

**Input buffer preservation**: Since each thread has its own input buffer, unsubmitted text is naturally preserved — we just stop clearing the input buffer on switch (currently `getMessage()` clears after reading, which is correct for send, but we no longer need to clear on thread switch since it's a different buffer).

**Testing**:

- Integration test: create thread A, type in input, switch to thread B, switch back to A → input text preserved
- Integration test: switch to overview, press enter on thread → display buffer changes

---

### Step 6: Intercept magenta buffer opens in any window

Register a single global `BufEnter` autocmd. On trigger, check the buffer and the window:

**Magenta buffer** (display or input): coerce it into the correct magenta window (display buffers → display window, input buffers → input window). If it was in the wrong window, restore that window's previous buffer. Perform a thread switch: sync the other magenta window to the same thread, update `activeBufferKey`, trigger render. If sidebar is hidden, open it first.

**Non-magenta buffer in a magenta window**: restore the magenta window to its correct magenta buffer. Move the non-magenta buffer to a non-magenta window, creating one if needed.

The existing `openFileInNonMagentaWindow` (`node/nvim/openFileInNonMagentaWindow.ts`) already has logic for finding non-magenta windows and creating opposite-side splits. Extract the "find or create a non-magenta window" logic into a shared helper (e.g. `findOrCreateNonMagentaWindow`) and reuse it in both `openFileInNonMagentaWindow` and the `BufEnter` handler.

Need a reverse mapping in BufferManager: `bufferIdToThread: Map<BufferId, { key: ThreadId | "overview", role: "display" | "input" }>`, updated when buffers are registered.

**Testing**:

- Integration test: navigate to thread A display in display window via ctrl-o → input window syncs
- Integration test: `:b <magenta_buf>` in a code window → code window restored, magenta sidebar switches to that thread

---

### Step 7: Update `renderInputHeader` and token count

The input window title shows the active profile and token count. Since each thread may have different token counts, the title should update when switching threads.

`renderInputHeader()` already reads from the active thread's token count. Since switching threads updates `activeThreadId`, the title will be correct after a switch — we just need to call `renderInputHeader()` after every buffer switch.

**Testing**: Switch between threads with different token counts → title updates.

---

### Step 8: Clean up removed concepts

- Remove `Chat.view()` — no longer needed as a single entry point
- Remove the single `chatApp` / `mountedChatApp` from Magenta
- Update `Magenta.dispatch` to route renders through BufferManager
- Update `Magenta.onKey` to forward to the correct mounted app (the one for the active buffer)
- Update `Magenta.command("send")` to read from the active thread's input buffer
