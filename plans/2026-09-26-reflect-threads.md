# Objective and Context

"see ~/src/edulab/ for a design exploration. I want to apply a similar design pattern to magenta. In particular:

- a special "reflect" fork behavior, which brings up a child thread with a dedicated "reflect" prompt oriented at helping the user understand what's happening.
- the ability to have two threads shown side by side (we will need to amend how we handle "current' threads)
- reflect threads should be highlighted visually and via extmarks underneath the highlighted text. We should have a way to jump between highlight locations
- the new thread should come up to the right of the current thread, with only 2 ever visible side by side. So the way we have magenta on the left sidebar now, we should take up 2 full columns on the left.
- We should support the recursive descent (going into deeper layers) for reflect threads. "-" when a reflect thread is visible, in any of the 4 buffers (displays or inputs for the 2 threads) should pop us "up" a level."

Follow-up: "I don't want it to just be a fork. I think we'll be using a different system prompt (one oriented at understanding), so the cache will be invalid anyway, and so we can be more flexible with what we do with the thread up to that point. For instance, I think we can avoid sending in file contents, but just show file paths, and we can abridge some tool calls and such... for now let's start by just pushing in a summary (as we do for the compact threads)"

Follow-up 1b: "I do not want this much delay. Compaction can be really slow. Let's use the summary mechanism that seeds compaction, but not run an actual compact. I think we should make a new thing that turns a history of ProviderMessage into a seed for the reflect thread... but one that's deterministic and fast."

Follow-up 1c: "the seed is just a user message, so every nested thread just renders the history up to the selected message. This will naturally capture the history of the root thread and all threads up to the current one."

Follow-up 4: "when I press "r", I'd like the thread to be created, the split to be created, and to place the focus inside of the input buffer. I would not want the thread to be submitted yet. Also, let's make sure that we save some structuredData around the seed. It should display as [thread context] in the reflect thread, and be expandable with =. We have similar patterns for other user messages, like system info, system reminders, etc..."

Follow-up 2: "fork links should be on the server entirely, even the existing ones. "r" when in normal mode, but inside a reflection region, should also pull up the reflection pane. We should also have an reflection overview pane. This should list reflections for the thread on the left, in a read-only buffer. Cursoring through them should scroll the thread on the left to center the reflection highlight. <CR> already has a role in the display buffer, so I want to use a dedicated key. r in normal mode. [-:] right, so if the lhs is a root, first "-" closes the reflect thread"

Follow-up 3: "I think we just update all of these commands to be buffer-level, and get rid of the notion of sending commands to the "active" thread. Let's unwind the concept of a single "active" thread as much as possible... I think we still need it for things like paste, but for that we should paste to the visible thread. If multiple threads are visible, or no threads are visible, then do a tie break using whichever thread held the cursor last."

The edulab reference is `~/src/edulab/plans/2026-09-05-nested-learning-threads.md`: a tree of threads where each child is opened from an `(anchor, action)` pair on its parent, the anchor _is_ the highlight/edge, the left pane is `focus`, the right pane is `focus.activeChild`, and navigation only moves `focus` on explicit request. Two lessons carry over: context stays flat as depth grows (each child's context is its parent's context plus the parent's transcript up to the selection, never re-wrapped), and navigation is decoupled from selection.

Magenta already has most of the mechanism:

- Fork: `F` (normal + visual) binding on message content in `node/nvimclient/chat/thread-view.ts` dispatches `fork-message` → `Magenta.forkAtMessageAndSwitch` (`node/nvimclient/magenta.ts`) → `Chat.handleForkThread` (`node/nvimclient/chat/chat.ts`) → `Session.forkThread(sourceId, nativeMessageIdx)` (`node/server/src/session.ts`) → `create({ type: "fork", source, nativeMessageIdx })`. `ThreadCore` truncates native history and appends a `<fork-notification>` user turn (`node/server/src/thread-core.ts`). Fork inherits the source system prompt and thread type (`node/nvimclient/chat/session-host.ts`, `node/server/src/thread-assembly.ts` `ThreadInitialization`).
- History rendering: `renderThreadToMarkdown(messages): { markdown, messageBoundaries }` in `node/server/src/compact-renderer.ts` is the deterministic, synchronous first step of compaction. It emits a `# user:` / `# assistant:` header per message and drops thinking, system reminders/info, fork notifications and comment updates. It reduces context updates to file paths, omits `get_files` result contents, renders `tool_use` as a JSON code block of the full input, and renders other tool results in full. `ThreadCompactor` (`compaction/compactor.ts`) then chunks that markdown and runs LLM compact threads over it, which is the slow part we avoid.
- Visual selection reaches bindings as `BindingCtx.selection: string[]` (lines only, `lua/magenta/init.lua` ~L353-371, `node/nvimclient/tea/bindings.ts`). No columns/positions today.
- Fork bookkeeping is view-side: `NvimThread.state.forkedTo` and `MessageViewState.forkedFrom` (`node/nvimclient/chat/thread.ts`).
- Layout: `Sidebar` (`node/nvimclient/sidebar.ts`) owns one display + one input window; `BufferManager.switchToThread(threadId, displayWindow, inputWindow)` (`node/nvimclient/buffer-manager.ts`) rebinds them; `Magenta.syncActiveView` maps `Chat.state` → `BufferKey` via `getActiveKey`.
- Current thread: `ChatState` in `chat.ts` (`thread-overview | thread-selected | archive | archive-thread-selected`), `activeThreadId`, plus `Chat.getActiveThread()`, which commands in `magenta.ts` use as their target (send, abort, retry, context-files, paste, sidebar winbar getters). `threads-navigate-up` (`chat.ts` ~L352, dispatched from `magenta.ts`) is the existing "up" action.
- Highlights: `withExtmark(node, opts)` in `node/nvimclient/tea/view.ts`, `HL_GROUPS` + stub `initializeMagentaHighlightGroups` in `node/nvimclient/nvim/extmarks.ts`, namespace `MAGENTA_HIGHLIGHT_NAMESPACE` in `node/nvimclient/nvim/buffer.ts`. Lua jump keymaps `]m`/`[m` in `lua/magenta/keymaps.lua` scan text headers.
- System prompts: `createSystemPrompt(threadType, …)` in `node/server/src/providers/system-prompt.ts`; `ThreadType = "subagent" | "compact" | "root" | "docker_root"` (`node/server/src/chat-types.ts`).

# Design

## Reflect is a fresh thread seeded with a rendered transcript

A reflect thread is not a fork. It is a fresh chat thread of a new `ThreadType` `"reflect"`, with its own system prompt (`node/server/src/providers/reflect-system-prompt.md`: orient the user, explain what the agent did and why, answer at the user's level, ask what's unclear, don't continue the task). Since the system prompt differs, the parent's prompt cache is lost anyway, which means we don't have to replay the parent's native history. We can send whatever representation of it helps most with understanding.

The seed is built **deterministically and synchronously**: no LLM call, no compaction. Nothing is sent on creation. The seed is written straight into the new thread's native log as an ordinary user message, the same way fork appends its `<fork-notification>` (`ThreadCore.clone` in `thread-core.ts`). The user's first submission then joins that user turn.

1. `Session.reflectThread(sourceId, anchor)` computes the seed, then creates the reflect thread (fresh, `threadType: "reflect"`, same profile/cwd/environment as the source, no context files, read-only tool policy) with **no bootstrap submission**. A `ThreadInitialization` variant `{ type: "reflect"; seed: AgentInput[] }` makes `ThreadCore.create` call `manager.appendUserMessage(seed)` on the fresh manager. From then on, it is just native history: the view, forks, retries and compaction all see it like any other user message, and no new Thread machinery is needed. It records `origin: { type: "reflect", sourceThreadId, anchor }`.
2. The history is `source.getProviderMessages().slice(0, anchor.messageIdx + 1)`: the transcript through the message containing the selection, so the model doesn't see later work (edulab's rule).
3. `buildReflectSeed({ history, anchor })` (`node/server/src/reflect/seed.ts`, pure) returns two text inputs. The first is the tagged context, which excludes the selection:

```
<thread-context>
<rendered history>
</thread-context>
```

The second is a plain, untagged text block:

```
The user selected:
> anchor text
```

The anchor text is emitted with every line prefixed by `> `.

4. The user's first message (whatever they type in the reflect input, which is the actual question) is sent as the same user turn, after the two seed blocks. There is no canned question. The reflect system prompt tells the model to interpret the user's message in terms of the selection.

On `r`, the client creates the thread, opens the right column showing it, and puts the cursor in the right input buffer in insert mode (see Pane state). Until the user submits, the reflect thread's display shows only the pending seed: the collapsed `[thread context]` block, then the plain `The user selected:` text block (see below).

## `[thread context]` content block

The seed follows the existing tagged-content pattern for structured user content (`system_info`, `system_reminder`, `context_update`, `fork_notification`):

- Add `["<thread-context>", "thread_context"]` to `TAGGED_CONTENT` in `providers/tagged-content.ts`. Add `ProviderThreadContextContent = { type: "thread_context"; text: string; nativeMessageIdx: NativeMessageIdx }` to the `ProviderMessageContent` union in `provider-types.ts`. Both providers' conversions already route text through `classifyTextContent`, so the block comes back tagged after it is sent.
- The structured data (source thread, anchor, and the range of messages covered) is not packed into the text. It is `SessionThread.origin`, which the view reads. The block renders as follows. The collapsed form:

```
[thread context]

The user selected:
> anchor text
```

Only `[thread context]` is the `thread_context` block. `=` on it expands it in place to the rendered history, using `toggle-expand-content` like `system_info` in `thread-view.ts`. The selection is an ordinary user text block, so it renders as normal user text, not as part of the collapsible block, and it is always visible.

- The special treatment is display-only. The `thread_context` classification exists so the view can collapse it. Everything else (the selection block, the user's messages) is a normal part of the log, and it is visible before the first submission because it is already in the provider messages.
- Both `renderThreadToMarkdown` (compaction) and `renderReflectHistory` (below) render `thread_context` blocks **verbatim** (not dropped like `system_info`). That's what carries ancestors' context when reflecting on a reflect thread. `archive-renderer.ts` and every exhaustive switch over content types get a case.

Nesting needs no special case. The seed is just the reflect thread's first user message, so reflecting on a reflect thread renders its history up to the selection like any other thread's history, and that history begins with its own seed. Each level therefore carries the root transcript and every intermediate reflection up to the current one. Nothing walks the tree. The rendered text nests one `<thread-context>` per level. That's acceptable: it reads chronologically, and each level adds only its own transcript.

The rendered history comes from a separate renderer, `renderReflectHistory(messages): string` in `reflect/seed.ts`. It does not generalize `renderThreadToMarkdown` with options; compaction's renderer is untouched. The two share per-block helpers where the output is the same (message headers, context-update → file paths, `get_files` result → paths, dropping thinking/system reminders/system info/fork notifications), which are exported from `compact-renderer.ts` as-is. Reflect-specific rendering lives in the new function: `tool_use` renders as one line (tool name + salient input such as file paths, command or query, input JSON truncated to 200 chars), and tool result text is cut at 1000 chars with `[… n chars omitted]`. EDL scripts and bash output become one-liners plus a truncated head. Assistant and user text is always kept in full, since that's what the user is reflecting on. If the rendered history still exceeds a budget (`REFLECT_SEED_MAX_CHARS`, ~200k chars), tool results are dropped entirely, oldest message first, until it fits. If it still doesn't fit, the oldest messages are replaced with `[n earlier messages omitted]`. The message containing the selection is never dropped.

The seed builder is the piece meant to evolve, e.g. per-tool renderers or cheaper representations of file edits. Nothing outside `reflect/seed.ts` depends on its format.

Reflect threads get a read-only tool set, so a reflection cannot mutate the workspace the parent is working in. They may still read files/hover/search to explain things.

## Thread origins live on the server

Fork and reflect links both move into Session. Today's view-only `NvimThread.state.forkedTo` and `MessageViewState.forkedFrom` are deleted, and the view derives them from Session.

```ts
// node/server/src/chat-types.ts
export type ThreadOrigin =
  | { type: "fork"; sourceThreadId: ThreadId; nativeMessageIdx: NativeMessageIdx }
  | { type: "reflect"; sourceThreadId: ThreadId; anchor: ReflectAnchor };
```

`SessionThread` records gain `origin?: ThreadOrigin`, set once at creation by `forkThread`/`reflectThread` and persisted with the other session metadata. It is separate from `parentThreadId`: a fork is not a subagent child, and reflect subtrees need their own delete/abort semantics. Session exposes `getOrigin(id)` and `listDerived(id, type)`. The fork seam rendering ("forked from/to") reads these. The fork-seam message index is `origin.nativeMessageIdx`, so the child needs no view state.

## Anchors

```ts
// node/server/src/chat-types.ts
export type ReflectAnchor = {
  messageIdx: number;     // index into the source's ProviderMessage[] (what the view renders)
  contentIdx: number;     // content block within that message (any block type)
  reflectionText: DisplayBufferText; // the selected text exactly as it appeared in the display buffer
};
```

An anchor names a content block and the text the user selected from its rendered form. It stores no offsets. Any content block can be anchored: text, tool use/result summaries, collapsed placeholders, context updates. The selected text can include decoration, because it's matched against what was displayed, not against the block's source. `ProviderMessage` indices are used rather than native indices because the display renders provider messages and the seed consumes them. Selections must lie within a single content block: if either end of the selection falls outside the range of the block under the cursor (`ctx.node`, below), `r` creates nothing and shows a notification.

Capturing it: lua's visual handler already sends `selection` (lines). Charwise `v` selections need the exact text, so the handler also sends `{ start = {row,col}, ["end"] = {row,col}, linewise }` from `getpos("'<")`/`getpos("'>")`. Node slices the displayed lines to get `reflectionText`. A new binding key `r` is added to `BINDING_KEYS` with `BINDING_MODES.r = ["n", "v"]`. Each content-block node in `thread-view.ts` gets a visual-mode `r` binding whose closure knows `{messageIdx, contentIdx}`. `BindingCtx` gains `range`. In normal mode, `r` inside a resolved reflection range shows that reflection (next section). Elsewhere it falls back to a binding on the thread view's root node, which opens the reflection overview for that buffer's thread.

Two reflections on the same block with the same `reflectionText` are rejected with a notification.

### Display buffer text vs message text

Two kinds of string are involved: provider-message text (what the agent is sent and sees) and display buffer text (what the view rendered, including decoration, collapsed placeholders and summaries). They look alike but are not interchangeable: display buffer text must never be compared against message content, and it only reaches the agent through one explicit, labelled path. A nominal type keeps them apart, following the existing pattern (`Line`, `DisplayPath`):

```ts
// node/server/src/chat-types.ts (server-side, since ReflectAnchor is persisted by Session)
export type DisplayBufferText = string & { __displayBufferText: true };
```

- It's produced only in the client, where text is read from a display buffer: the visual-selection capture (sliced from buffer `Line`s) and TEA's `withHighlights` matching (joining a highlighted node's mounted string contents). Those are the only places that cast to `DisplayBufferText`.
- It's consumed by:
  - `findInDisplayBufferText(lines: DisplayBufferText[], needle: DisplayBufferText)` inside TEA's highlight matching. The node's rendered text is branded `DisplayBufferText` where TEA joins it, so the search can't be handed message text.
  - `buildReflectSeed`, which is the one place display buffer text becomes message text. It renders the selection under `The user selected:` and states that the quote is display buffer text. Nothing else turns `DisplayBufferText` into `AgentInput`/`string` message content.
  - The overview and fallback labels, which render it back into a buffer.
- Message text stays plain `string` as today. `renderReflectHistory` and `thread_context` produce message text, and the `[thread context]` expansion in the reflect display renders that message text; it never reads it back as `DisplayBufferText`.

## Highlights and jumping

Highlighting is declarative, as part of TEA. Each content-block node is wrapped in `withHighlights(block, reflectionsFor(messageIdx, contentIdx))`, which the view builds from `session.listDerived(thread, "reflect")`. The view doesn't split text or compute positions, and no node keys are exposed outside TEA.

```ts
// tea/view.ts
export type NodeHighlight = {
  id: string;                     // stable: the reflect child's ThreadId
  text: DisplayBufferText;        // searched for within this node's rendered text
  extmarkOptions: ExtmarkOptions; // hl_group + virt_lines label
  fallback: ExtmarkOptions;       // placed at the node's end when `text` isn't found
  bindings?: Bindings;            // active when the cursor is inside the match
};
export function withHighlights(node: VDOMNode, highlights: NodeHighlight[]): VDOMNode;
```

Per reflection, the view supplies:

- `extmarkOptions`: `MagentaReflect` over the match, or `MagentaReflectActive` when that child is the one in the right pane, plus a `virt_lines` label below it: `  ↳ reflect: <child title | streaming… | n messages>`.
- `fallback`: a highlighted `virt_lines` entry at the end of the block, `  reflection → <truncated reflectionText> (<child title>)`, used when the text isn't found (e.g. the block was collapsed/expanded or rendered differently).
- `bindings`: normal-mode `r` → `show-reflection` for that child.

If the block isn't rendered at all (e.g. after compaction), there's no node and nothing is drawn. The reflection is still reachable from the overview.

TEA mechanics:

- `VDOMNode` variants and their `Mounted*` counterparts gain `highlights?: NodeHighlight[]`, and mounted nodes also get `highlightExtmarks?: Map<string, ExtmarkId>`. This extends the existing single `extmarkOptions`/`extmarkId` handling in `update.ts` (`handleExtmarkUpdate`) to a list keyed by `id`.
- Positions: the node's rendered text is the joined contents of its mounted string descendants, so the search is a pure string search in node (`findInDisplayBufferText`) with no buffer read. The match is converted to byte positions offset from the node's `startPos` (mounted positions are `ByteIdx` columns).
- Re-applying only on re-render: `visitNode` in `update.ts` already knows when a subtree's text changed (a string node's content differed, or a node was replaced). It returns a `changed` flag that bubbles up. A highlighted node recomputes its matches only when its subtree changed or its `highlights` differ (compared by `id`, `text` and options, like `extmarkOptionsEqual`). Otherwise its extmarks are left alone, and neovim moves them with edits above. Streaming only changes the last message, and reflecting on a streaming message is disallowed, so per-token renders do no highlight work.
- Cleanup: `cleanupExtmarks` also deletes `highlightExtmarks` when a node is removed or replaced.
- Bindings: `getBinding` checks a node's highlight ranges (live extmark positions via `nvim_buf_get_extmark_by_id`, or the positions recorded when last placed) before the node's own bindings. So `r` on a match picks that highlight's binding, and elsewhere it falls through to the block's visual `r` or the root's overview binding. `<CR>` keeps its existing meaning.
- Capture: `getBinding` passes the owning node's `{ startPos, endPos }` into `BindingCtx` as `node`. After `<Esc>`, the cursor sits at whichever end of the visual selection it was on, and `getBinding` resolves the innermost visual-`r` binding there, which is the content-block wrapper whose closure holds `{messageIdx, contentIdx}`. Both `ctx.range` ends must lie within `ctx.node`, otherwise the notification fires.
- Lookup for the overview: `MountedApp.getHighlightPos(id): { startPos, endPos } | undefined` returns the current range of the match (or fallback) with that id, by highlight id, not by view structure.

`MagentaReflect`/`MagentaReflectActive` are added to `HL_GROUPS` and defined (default-linked, `default = true`, e.g. to `Search`/`IncSearch`) in lua `magenta/init.lua` setup, replacing the no-op stub path.

Jumping: `]r` / `[r` in `set_display_buffer_keymaps` call `nvim_buf_get_extmarks(buf, ns, 0, -1, { details = true })` on the highlight namespace, filter to the reflect namespace (matches and fallbacks), and move to the next/prev start. Lua-only, same style as `]m`.

## Reflection overview

The right column can also show a **reflection overview** for the left thread: a read-only buffer (`BufferKey` `{ kind: "reflections"; threadId }`, a small TEA app like the thread overview). It lists `session.listDerived(left, "reflect")` in anchor order (`messageIdx`, then `contentIdx`, then creation time). Each entry shows the quoted `reflectionText` (truncated), the child's title, and status.

- It opens with normal-mode `r` anywhere in a display buffer that isn't on a highlight (also `:Magenta reflections`). So `r` always opens the reflect split: on a highlight it shows that reflection, and elsewhere it shows the overview.
- The input window of the right column is closed while the overview is shown. It is a display-only column.
- A buffer-local `CursorMoved` autocmd (set in lua alongside the display keymaps) rpcnotifies `magentaReflectionsCursor` with the line. Node maps the line to its entry and reads `leftApp.getHighlightPos(childId)`. Via `nvim_win_call` on the left display window, it sets the cursor there and runs `normal! zz`, so the highlight is centred without moving focus. That entry's highlight becomes `MagentaReflectActive` while it is under the cursor.
- `<CR>` on an entry (the overview is its own buffer, so `<CR>` is free there) shows that reflection on the right, replacing the overview. `-` from the overview closes the right column.
- With no reflections, the buffer says so and explains how to create one.

## Two columns and "current" threads

Replace the single active thread with a pane pair:

```ts
// chat.ts
type SidebarState = { visible: boolean } & ( // replaces ChatState and Sidebar's hidden/visible state
  | { state: "thread-overview"; left: ThreadId | undefined }
  | { state: "thread-selected"; left: ThreadId; right?: RightPane }
  | ...archive variants unchanged
);

type RightPane =
  | { type: "reflection"; threadId: ThreadId }
  | { type: "reflections-overview" }
```

`left` is the left pane (edulab `focus`). `right`, when set, is either a reflect child of it (edulab `activeChild`) or the reflection overview for it. Invariant: a `reflection` right pane is always a direct reflect child of `left`.

Transitions (all through `Chat.myUpdate`):

- `reflect-created { parent, child }`: if `parent === left`, the right pane becomes `child`. If `parent` is the right pane's thread (reflecting in the right pane), descend: `left = parent`, right = `child`. Reflecting from the right pane is what drives recursive descent, so no separate "go deeper" key is needed. In both cases, after `syncActiveView` binds the right column, focus moves to the right input window in insert mode (`nvim_set_current_win` then `startinsert`). This is the only transition that moves the cursor.
- `show-reflection { parent, child }` (normal `r` on a highlight, or `<CR>` in the overview): same rule as above, without creating anything.
- `show-reflections-overview { thread }` (normal `r` off a highlight): if `thread === left`, the right pane becomes the overview. If `thread` is the right pane's thread, descend: `left = thread`, and the right pane becomes its overview. Same rule as `show-reflection`, so `r` in the right column always goes one level deeper. Focus moves to the overview window.
- `reflect-navigate-up` (`-`):
  - Right is a reflection and the left thread is itself a reflection: shift right. The right pane becomes the current left thread, and the left becomes its parent (edulab `←`).
  - Right is a reflection and the left thread is a root: the first `-` just closes the right column.
  - Right is the overview: close the right column.
  - No right pane: fall through to the existing `threads-navigate-up`.
  - So `-` pops exactly one level, and repeated `-` walks all the way out.
- `set-active-thread` from the thread overview clears `right`. Selecting a reflect thread opens its parent on the left and it on the right.

## No single "active" thread

`Chat.getActiveThread()` and command handlers reading `chat.state.left` go away. `left` is renamed `left`: it only says what the left column displays, never where a command goes. Commands fall into two groups.

**Buffer-scoped** commands act on the thread that owns the buffer they were invoked from: `send`/retry, `abort` from sidebar keymaps, `scroll-to-last-user-message`, `set-cursor-to-bottom`, `sandbox-bypass`, `profile`, and all TEA bindings (already buffer-scoped through their mounted app). The lua `:Magenta` command handler adds `vim.api.nvim_get_current_buf()` to the rpc payload. Node resolves it with `BufferManager.keyForBuffer(bufnr): BufferKey | undefined`, which covers display and input buffers of every registered thread. If the buffer isn't a thread buffer, the command falls back to the external rule below. The one exception is `send`, which is a no-op because it only makes sense from an input buffer. `send` reads the input buffer it was invoked from, not `activeBuffers.inputBuffer`.

**External** commands come from outside magenta (code buffers, pickers): `paste-selection`, `:Magenta paste`, `append-to-input`, `context-files`, the global `<leader>ma` abort, and `profile` when invoked outside the sidebar. They target `Chat.externalTarget()`:

- exactly one thread visible (sidebar shows one column): that thread.
- two visible, or none (sidebar hidden, or overview/archive shown): whichever thread most recently held the cursor, taken from `lastCursorThreadId`. When two are visible, this considers only those two.
- none ever focused: the most recently created thread, else a notification.

`lastCursorThreadId` is maintained by a lua `WinEnter`/`BufEnter` autocmd on magenta thread buffers (display and input). It rpcnotifies `magentaThreadBufEnter { bufnr }`, and Chat records the owning thread. This is the only remaining "current thread" concept, and it's used only for this tie break.

Per-column chrome (winbar token count, busy/✓/✗ status, sandbox-bypass indicator, profile) is computed from each column's own thread. `Sidebar` takes a `(column) => ThreadId | undefined` lookup instead of the current single-thread getters.

## Sidebar layout

```ts
// sidebar.ts
type SidebarColumn = { displayWindow: NvimWindow; inputWindow?: NvimWindow };
class Sidebar {
  // window handles only; no state enum
  private windows: { left?: SidebarColumn; right?: SidebarColumn };
  sync(state: SidebarState): Promise<void>;
}
```

There is exactly one sidebar state: `SidebarState` in `Chat`. It says what is shown: whether the sidebar is visible, what the left column shows, and what the right column shows (if anything). `Sidebar` loses its own `state: hidden | visible` enum and becomes a reconciler. It holds the window handles it created, and `Sidebar.sync(state)` opens, closes and splits windows so they match `SidebarState`. It never decides anything on its own. Visibility moves into `SidebarState` (a `visible: boolean` alongside the pane fields), so toggle is a `Chat` transition, and the right column coming back after a toggle follows directly from `right` still being set. Window events that change what is shown (`onWinClosed`, `:bd`) dispatch transitions on `SidebarState`, then `sync` reconciles. They never mutate `Sidebar` directly. `SidebarColumn` handles are an implementation detail of `Sidebar` and are not a second source of truth: when they disagree with `SidebarState`, `sync` fixes the windows.
```

The configured sidebar width becomes the per-column width. Opening the right column does a `vsplit` to the right of `left.displayWindow` and sets `winfixwidth` on both, so the sidebar occupies 2 × `columnWidth` on the left edge. Closing it removes the right windows and restores 1 ×. The right column gets its own input window when it shows a reflection, and none when it shows the overview. `syncActiveView` calls `Sidebar.sync(state)` and then binds buffers for each column. Only `left`/`right` sidebar positions support the second column in v1. `above/below/tab` show only the left pane, with a notice that a reflection is open. `onWinClosed` for a right-column window dispatches a transition that clears `right`, rather than hiding the sidebar.

`:bd` closes, it never deletes. Today `Magenta.onBufDelete` dispatches `delete-thread-subtree` for a thread buffer, which makes `:bd` destroy the thread; that path is removed. Instead, `:bd` on a thread's display or input buffer drops that thread's buffers from `BufferManager` (like `removeThread`, without touching Session), and `BufferManager` recreates them lazily the next time the thread is shown (the same pattern as `recreateOverview`). Threads are deleted only by an explicit `dd` in an overview: the existing thread overview `dd` (`delete-thread`), and a new `dd` on a reflection overview entry that deletes that reflect thread and its reflect subtree.

`:bd` also exits reflection mode:

- A right-column buffer (the reflect thread's display/input, or the overview): clear `right` and close the right column. The left column is untouched, and the reflect thread stays alive and reachable from the overview.
- A left-column buffer: clear `right` and close the right column too, then leave the left column the way closing a thread does today. `right` lives in `SidebarState` (owned by `Chat`), not in `Sidebar`'s window state, so toggling the sidebar or re-selecting the thread later doesn't bring the split back.


`-` is bound in all four buffers, plus the overview: in display buffers via `set_display_buffer_keymaps`, and in input buffers in normal mode only via `set_sidebar_buffer_keymaps`. All of them dispatch `:Magenta reflect-up`. In insert mode `-` is a literal character.

## Interfaces

```ts
// node/server/src/session.ts
reflectThread(sourceId: ThreadId, anchor: ReflectAnchor): Promise<ThreadId>;
getOrigin(id: ThreadId): ThreadOrigin | undefined;
listDerived(id: ThreadId, type: ThreadOrigin["type"]): Array<{ threadId: ThreadId; origin: ThreadOrigin }>;

// tea
export function withHighlights(node: VDOMNode, highlights: NodeHighlight[]): VDOMNode;
MountedApp.getHighlightPos(id: string): { startPos: Position0Indexed; endPos: Position0Indexed } | undefined;

// chat-types.ts
export type ThreadType = "subagent" | "compact" | "root" | "docker_root" | "reflect";

// thread-assembly.ts
type ThreadInitialization =
  | ... existing
  | { type: "reflect"; seed: AgentInput[] }; // appended to the fresh native log, not sent

// provider-types.ts
export type ProviderThreadContextContent = {
  type: "thread_context";
  text: string;
  nativeMessageIdx: NativeMessageIdx;
};

// node/server/src/reflect/seed.ts
export function buildReflectSeed(args: {
  history: ReadonlyArray<ProviderMessage>;
  anchor: ReflectAnchor;
}): AgentInput[]; // [thread-context block, selection block]

export function renderReflectHistory(messages: ReadonlyArray<ProviderMessage>): string;

// tea/bindings.ts
export const BINDING_KEYS = [..., "r"] as const;
BINDING_MODES.r = ["n", "v"];
export type BindingCtx = {
  selection?: string[];
  range?: { start: Position0Indexed; end: Position0Indexed; linewise: boolean };
};

// root-msg / chat.ts
| { type: "reflect-selection"; sourceThreadId: ThreadId; anchor: ReflectAnchor }
| { type: "show-reflection"; parent: ThreadId; child: ThreadId }
| { type: "reflect-navigate-up" }
| { type: "show-reflections-overview" }
| { type: "reflections-cursor"; line: number }

// buffer-manager.ts
keyForBuffer(bufnr: BufNr): BufferKey | undefined;

// chat.ts
externalTarget(): ThreadId | undefined;
lastCursorThreadId: ThreadId | undefined;

// node/nvimclient/chat/reflect-highlights.ts
// pure: find the anchor's display buffer text within the block's buffer lines
export function findInDisplayBufferText(lines: DisplayBufferText[], needle: DisplayBufferText): { start: Position0Indexed; end: Position0Indexed } | undefined;
```

## Invariants

- A `reflection` right pane is a direct reflect child of `left`, and an overview right pane lists `left`'s reflections. At most 2 threads are visible.
- No command handler reads `left` to pick a target. Buffer-scoped commands resolve from the invoking buffer, and external ones go through `externalTarget()`.
- Fork/reflect relationships have exactly one source of truth: `SessionThread.origin`. No view state duplicates them.
- What the sidebar shows has exactly one source of truth: `SidebarState` in `Chat`. `Sidebar` only holds window handles and reconciles them to it.
- `-` changes pane state by exactly one level. `left` only changes on reflect creation from the right pane, normal `r` in the right pane (on a highlight or not), `-`, or explicit thread selection. Streaming and overview cursoring never move panes; the overview only scrolls the left window.
- `<CR>` in display buffers keeps its current meaning.
- A reflect thread's anchor is immutable; reflections are never reparented. Deleting a parent deletes its reflect subtree (reuse subtree abort/delete).
- `:bd` never deletes a thread. Deletion only happens through an explicit `dd` in the thread overview or the reflection overview.
- Anchors reference complete provider messages, which are immutable. Reflecting on a still-streaming message is disallowed.
- Every reflection is always shown: either a text match within its block, or the fallback marker at the end of the block. The only exception is a block that isn't rendered.
- A reflect thread never receives the source's native history, only the seed. The seed covers messages `[0, anchor.messageIdx]` of the source and nothing after.
- The seed is the first content of the reflect thread's first user turn (message 0), and it is sent together with the user's first message, never on its own. Creating a reflect thread makes no network calls.
- Right after creation, the reflect thread's native log is exactly one user message (the seed), and no request has been made.
- Seed construction is the same for every source. There is no special case for reflect sources. Ancestors' context arrives only through the source's message 0.
- `renderThreadToMarkdown` output is byte-identical to today, so compaction is unaffected. Extracting shared block helpers is a pure refactor.
- The message containing the anchor is always present in full in the seed.
- Reflect threads cannot write to the workspace.
- Compaction of the parent after a reflection exists: anchors reference pre-compaction provider-message indices. The parent's display shows the archived/compacted history. v1 hides highlights whose `messageIdx` is no longer rendered, and the reflect thread stays reachable from the overview.
- Existing `F` fork behavior is unchanged apart from where its links are stored.

# Stages

## Server-side thread origins

Status: DONE. `ThreadOrigin` (fork variant only for now) in `chat-types.ts`; `Session.create` records it from the fork request; `getOrigin`/`listDerived` added. `forkedTo`/`forkedFrom` view state deleted; `thread-view.ts` reads Session. Deviation: Session has no save/load path for metadata, so persistence is not tested (nothing to persist to yet). Tests: `session.test.ts` "records fork origins on the server", `fork-thread.test.ts` updated. Review follow-up: `listDerived` is generic and narrows `origin` to the requested variant; `SessionThread.origin` is `ThreadOrigin | undefined` (set explicitly at construction); tests cover creation order, per-source filtering, grandchild origin, subagents having no origin, and the fork indicator's position after the forked messages.

- Goal: `SessionThread.origin` records forks, and `getOrigin`/`listDerived` replace `NvimThread.state.forkedTo` and `MessageViewState.forkedFrom`, which are deleted. Fork seam rendering is unchanged for the user.
- Tests:
  - Tier A: after `forkThread(a, k)`, `getOrigin(fork)` is `{ type: "fork", sourceThreadId: a, nativeMessageIdx: k }` and `listDerived(a, "fork")` contains it. It survives the session save/load path used for other metadata.
  - Existing fork tests (`fork-keybinding.test.ts`) still pass, with "forked from/to" rendering now fed by Session. Disposing and recreating the `Chat` view adapter still renders the links.

## Server: reflect creation

Status: DONE. `ThreadType` `"reflect"`, `ReflectAnchor`, `DisplayBufferText` and the reflect `ThreadOrigin` variant in `chat-types.ts`; `thread_context` tagged content; `REFLECT_STATIC_TOOL_NAMES` (`get_files`, `hover`, `find_references`); `reflect/seed.ts` (`buildReflectSeed`, `renderReflectHistory`) reusing `buildToolInfoMap`/`renderContentBlock`/`extractFilePathsFromContextUpdate` exported from `compact-renderer.ts`; `Session.reflectThread`; deleting a thread deletes its reflect children. Tests: `reflect/seed.test.ts`, `session.test.ts` "creates a reflect thread seeded from the source without sending". Deviations:
- The reflect system prompt is the `REFLECT_SYSTEM_PROMPT` constant in `providers/system-prompt.ts`, not a `.md` file (no md-loading path for built-in prompts). Reflect threads also get a short standing system reminder.
- Seeding is a `ThreadInitialization` `{ type: "fresh"; threadType: "reflect"; seed }` variant (policy is still needed for auto-compaction); `Thread`'s constructor takes `{ type: "seed" }` and appends it to the fresh core's manager. `ThreadPreparation` gains a `reflect` variant that hosts treat as fresh.
- The selection block is exactly `The user selected:\n> …`; the note that the quote is display text lives in the system prompt.
- Review follow-up: `ReflectAnchor` uses branded `MessageIdx`/`ContentBlockIdx`. `threadType: "reflect"` is unrepresentable in `SessionCreateOptions` and `ThreadManager.spawnThread` (`Exclude<ThreadType, "reflect">`); records use `ThreadOptions` (full union), so the runtime guard was removed. `thread-assembly` narrows on `threadType === "reflect"`. Tests cover anchor/source validation throws, nested + pending reflection cascade delete, and archive meta with `threadType: "reflect"` (archive meta carries no origin).
- Read-only is enforced by the tool list (no edl/bash/subagents/nvim_lua); there is no separate "mocked edit call rejected" test, and the openai-side `thread_context` classification relies on the shared `classifyTextContent` rather than a dedicated test.

- Goal: `Session.reflectThread` creates a fresh `"reflect"` thread with the reflect system prompt and read-only tools, and the seed appended to its native log, without sending anything. It records the thread's origin. `thread_context` round-trips as tagged content.
- Tests:
  - `buildReflectSeed` unit tests: the seed contains messages ≤ k and no text from message k+1. `get_files` contents are absent but their paths are present. A long bash result is truncated with an omission marker. Tool uses render as one line. Assistant text is intact, and the selection is a separate second block, `The user selected:` followed by `> `-prefixed lines, outside `<thread-context>`.
  - Composition at depth: reflecting on a reflect thread, and then on that one, yields a seed containing the root transcript text, the first selection and the first reflection's replies, in that order. Text after each selection point is absent at every level.
  - Budget: an oversized history drops old tool results first, then old messages. The anchor message survives.
  - Existing compaction renderer tests pass unchanged after the shared helpers are extracted.
  - Tier A (harness + mock provider): after `reflectThread`, no request has been made, and `getProviderMessages()` is one user message whose content is a `thread_context` block then the selection text block. Submitting "why?" makes one request with the reflect system prompt (not the parent's). Its only user message has the `<thread-context>` block, then the `The user selected:` block, then "why?", and none of the parent's native blocks.
  - After that request, `getProviderMessages()[0].content[0].type === "thread_context"` for both the anthropic and openai mock providers. `renderReflectHistory` of that thread includes the seed text verbatim.
  - The reflect thread's tool list excludes edit/write tools. A mocked edit tool call is rejected.
  - `getOrigin`/`listDerived(_, "reflect")` round-trip. Deleting the parent deletes the reflect child.

## Anchor capture

Status: DONE. `r` added to `BINDING_KEYS` (`n`/`v`); `BindingCtx` gains `range` (`start`, inclusive `end`, `linewise`, and the sliced `text: DisplayBufferText`) and `node` (extent of the node owning the binding, injected by `getBinding`). Lua's visual handler sends `range` plus the full spanned lines (and now handles `V` correctly); `Magenta.onKey` slices them with `sliceDisplayBufferSelection` (`chat/reflect-anchor.ts`, the only cast to `DisplayBufferText`). The content-block wrapper in `thread-view.ts` binds visual `r`: out-of-block selections notify, otherwise it dispatches thread msg `reflect-selection`, handled in `Magenta.reflectAndSwitch` (duplicate check → `session.reflectThread` → show → input window, `startinsert`). `thread_context` renders collapsed as `[thread context]` + blank line, `=` expands. Tests: `reflect-anchor.node.test.ts`, `reflect-anchor.test.ts`. Deviations:
- No right column yet: the reflect thread replaces the source in the single sidebar column until the pane/two-column stages.
- Normal-mode `r` does nothing yet (highlight/overview stages).
- The reflect display also shows the `# user:` header above `[thread context]`.
- Review follow-up: `BindingCtx` is `{ selection?: { lines; range? } }` (range only exists with a selection); bindings receive `BoundBindingCtx` with a required `node: NodeExtent`. `VisualRange = Omit<BindingRange, "text">`. The RPC payload is validated in `parseVisualRange` (`magenta.ts`) instead of cast. `renderMessageContent` takes branded `MessageIdx`/`ContentBlockIdx`. Bug fix: `V` reported MAXCOL as the end column, which msgpack decodes as a BigInt, so the range was dropped; lua now clamps linewise columns to the line (`0`..`#lastLine`). Tests: `tea/bindings.node.test.ts` (`isRangeWithinNode` boundaries), a positive `V` case, and per-step assertions in the rejection test. No separate `F`-under-`V` test was added.

- Goal: visual `r` in a display buffer over a text block dispatches `reflect-selection` with a correct `ReflectAnchor`.
- Tests:
  - Pure unit tests for buffer-range → `reflectionText`: charwise within one line, across lines, linewise, multibyte characters.
  - Tier C (`withDriver`): render a thread with a known assistant message, visually select a word and press `r`. The reflect thread exists with the right `messageIdx`/`contentIdx`/`reflectionText`, the right column is open, the cursor is in the right input buffer in insert mode, and no provider request has been made.
  - Tier C: the reflect display's text is exactly `[thread context]`, a blank line, `The user selected:`, then `> <word>`. `=` on `[thread context]` expands it to the rendered history, leaving the selection lines in place, and `=` collapses it again, both before and after the first submission.
  - Selecting over an existing reflection notifies and creates nothing.
  - A selection spanning two content blocks notifies and creates nothing.

## Highlights and jumping

Status: DONE. `NodeHighlight`/`withHighlights` in `tea/view.ts`; placement, `findInDisplayBufferText`, `clearHighlights`, `getHighlightPos` in `tea/highlights.ts`; `MountedApp.getHighlightPos`; highlight bindings in `getBinding` (normal mode, match only, checked after children and before the node's own bindings); marks live in a new `MAGENTA_REFLECT_NAMESPACE` (`magenta-reflect`), which `]r`/`[r` (`keymaps.lua`) scan; `MagentaReflect`/`MagentaReflectActive` are default-linked to `Search`/`IncSearch` in `init.lua` setup. `thread-view.ts` wraps each content block with its reflections (label: child title / `streaming…` / `n messages`). Tests: `tea/highlights.node.test.ts`, `tea/highlights.test.ts`, and a tier C case in `chat/reflect-anchor.test.ts`. Deviations:
- Change detection is a post-pass (`syncHighlights`, after `render`/`update`) rather than a `changed` flag from `visitNode`: each highlighted node keeps a signature of its rendered text + highlights and only re-places marks when it differs. Unhighlighted nodes cost nothing; highlighted ones cost a string join per render.
- `findInDisplayBufferText(haystack, needle)` takes the node's joined text (not lines) and returns byte offsets; it lives in `tea/highlights.ts`, not `chat/reflect-highlights.ts`.
- Recorded positions are stored relative to the node's `startPos` (which `update` keeps current), so bindings and `getHighlightPos` need no extmark RPC.
- No right pane yet: `MagentaReflectActive` is defined but unused, and normal `r` on a highlight dispatches `select-thread-effect` for the child (replaces `show-reflection` until the pane-state stage). Normal `r` off a highlight still does nothing (overview stage).
- The parent's labels refresh only when the parent re-renders.
- Not covered by tests: fallback toggling in tier C, resize stability.
- Review follow-up: `PlacedHighlight` is a union (`matched` with start/end, `fallback` with an anchor) that carries its `spec`, so bindings iterate `highlightState.placed` and only matched extents can bind; `HighlightState.signature` is a branded `HighlightSignature`; lua `jumpToReflection`. Tests added for inactive fallback bindings and for a mid-line node whose prefix changes. Not done (nits): branded highlight ids, removing the index/text casts in `thread-view.ts`/`mountedText`.

- Goal: reflected passages render highlighted with a virt-line label. Normal `r` on a highlight shows the child, `<CR>` is unchanged, and `]r`/`[r` jump. `withHighlights`/`getHighlightPos` work.
- Tests:
  - `findInDisplayBufferText` unit tests: single line, spanning lines, not found, repeated text (first occurrence).
  - Type-level: passing a plain `string` or provider-message text to `findInDisplayBufferText` or `ReflectAnchor.reflectionText` fails `tsc`.
  - Tier C: a selection over a tool summary or header text highlights in place. A selection whose text disappears when its block is toggled falls back to the `reflection →` marker and comes back when the block is toggled again.
  - Tier C: after two reflections in one message, the display buffer has two `MagentaReflect` extmarks at the expected ranges and a virt_lines label; the active one uses `MagentaReflectActive`.
  - Tier C: `]r` from the top lands on the first highlight, again on the second, `[r` returns.
  - Toggling expansion of another message and resizing the window leave highlights on the same text.
  - Normal `r` on a highlight dispatches `show-reflection` for that child. On plain text, a tool block or a header, it dispatches `show-reflections-overview` for that buffer's thread.
  - TEA unit tests (`withHighlights`): a match gets an extmark over the right byte range, including multibyte text. A missing match gets the fallback. Changing the node's text re-places the mark. Re-rendering an unrelated sibling or an earlier node makes no extmark calls for it, and its mark still covers the same text. Removing the node deletes its marks. `getHighlightPos` tracks the match after an earlier node grows.

## Reflection overview
Status: DONE. `chat/reflections-overview.ts`: `orderedReflections` (anchor order, creation order breaks ties), `renderReflectionsOverview` (one line per entry: quoted text + child display name; `<CR>` opens), and `ReflectionsOverview`, which owns the overview buffer, its TEA app and a window split right of the sidebar display window. `Magenta.showReflectionsOverview`/`closeReflectionsOverview`/`onReflectionsCursor`; RootMsg `show-reflections-overview`; `:Magenta reflections`; lua `set_reflections_buffer_keymaps` (CursorMoved → `magentaReflectionsCursor`). Normal `r` on a content block (no selection) or on the thread view's root opens the overview. `Chat.activeReflectionId` drives `MagentaReflectActive`. Tests: `chat/reflections-overview.test.ts`. Deviations:
- No `SidebarState`/right pane yet: the overview window is an ad-hoc `nvim_open_win` split managed by `ReflectionsOverview`, not a `BufferKey` in `BufferManager` (stages 7/8 should fold it into `RightPane`/`Sidebar.sync`). It closes on `-` (`threads-navigate-up` closes it first), toggle, or when its window closes. `onKey` routes to the overview app when the current buffer is the overview buffer.
- `<CR>` on an entry closes the overview and selects the child in the single column (replaced by `show-reflection` in the pane-state stage).
- `r` in a reflect thread doesn't descend yet (no right column); `dd` on entries is stage 8.
- Not tested: "highlight line near the middle row" (the test asserts the left cursor lands on the highlight's line).
- Review follow-up: the active entry is `ReflectionsOverview.activeReflectionId` (Chat exposes it via a `getActiveReflectionId` getter supplied by Magenta), so it can't outlive the overview. `entryAt` computes `orderedReflections` on demand (no mutable `entries` field). The `magentaReflectionsCursor` payload is validated (`parseReflectionsCursorLine`). Tests: `reflections-overview.node.test.ts` (messageIdx/contentIdx/creation ordering, `entryAtLine` header/past-end), header-row cursor clears the active highlight, re-open reuses the same window, and `:q` on the overview cleans up so `r`/`-` work again.

- Goal: normal `r` off a highlight shows the overview in the right column. Moving the cursor through it centres the matching highlight in the left window, `r` opens the entry, and `-` closes it.
- Tests (tier C):
  - With the cursor on plain text and the right column closed, `r` opens the right column with the overview and focuses it. With no reflections, it shows the empty-state text.
  - `r` off a highlight in the right column's reflect thread moves that thread to the left and shows its overview on the right.
  - With three reflections, the overview lists them in anchor order with their quoted text.
  - Moving the cursor to entry 3 puts the left window's cursor on that highlight, with the highlight line near the window's middle row. Focus stays in the overview, and that highlight uses `MagentaReflectActive`.
  - `<CR>` on an entry swaps the overview for that reflection thread, and the right input window appears.
  - `-` from the overview closes the right column.

## Buffer-scoped commands

Status: DONE. `Chat.getActiveThread` (and the unused root-thread getters) removed; `Chat.getThread(id)`, `Chat.externalTarget(sidebarVisible)` over the pure `pickExternalTarget`, and `Chat.lastCursorThreadId`. `BufferManager.keyForBuffer`. Lua `:Magenta` sends the current bufnr; `Magenta.command(input, bufnr?)` resolves `send`/`abort`/`reflections`/`sandbox-bypass` from it, while `paste-selection`, `:Magenta paste`/clipboard paste and `context-files` use `externalTarget` (paste reveals the target thread first). `Sidebar` takes one `getColumnChrome(column)` callback (`SidebarColumnName` is just `"left"` for now); chrome is empty/default when the column shows no thread. Tests: `chat/external-target.node.test.ts`, `chat/buffer-scoped-commands.test.ts`. Deviations:
- `lastCursorThreadId` is fed by the existing global `magentaBufEnter` notification (no new autocmd). Because `nvim_win_set_buf` on a non-current window also fires BufEnter, it is only recorded if the entered buffer is still current when node checks.
- Programmatic `command()` calls without a bufnr act as if invoked from the sidebar's input buffer (so driver `send()`/`abort()` keep working). `send` from a non-thread input buffer (e.g. the overview's shared input) is a no-op.
- `profile` still just sets the global active profile (it never targeted a thread).
- `ChatState.activeThreadId` is not renamed yet (pane-state stage); tests read it via `test/left-thread.ts` `leftThread(chat)`. Driver gained `assertVisibleInputThread` for waiting until `send` would hit a switched-to thread.
- The newest-thread fallback only considers initialized root (parentless) threads.
- Review follow-up: `Chat.lastCursorThreadId` is a read-only getter; Magenta writes it via `recordCursorThread(id)` (ignores unknown ids) and `removeThreadView` clears it, so `externalTarget` no longer re-checks existence. `ColumnChrome.status` is a `ColumnStatus` union (`none|busy|failed|ok`) the sidebar maps to icons. The `MAGENTA_COMMAND` handler checks `typeof args[0] === "string"`. Tests: `send` from a display buffer is a no-op; deleting the last-cursor thread clears it and the fallback picks the newest root thread, not a subagent.

- Goal: `getActiveThread` is removed. Every command resolves its thread from the invoking buffer or from `externalTarget()`, and per-column chrome reads its own thread. This stage lands before two columns exist, and is observable with one column plus the thread overview.
- Tests:
  - Unit (`node` project): `externalTarget()` with one visible thread returns it. With none visible, it returns `lastCursorThreadId`. With two visible, it returns whichever of the two held the cursor last, ignoring a more recently focused thread that isn't visible. With no history, it falls back to the newest thread.
  - Tier C: `:Magenta send` in thread A's input submits to A even after `lastCursorThreadId` moved to B (buffers are scoped regardless of recency). Enter on an empty input retries that buffer's thread.
  - Tier C: `paste-selection` from a code buffer with the sidebar hidden goes to the thread whose buffer was last entered.
  - Tier C: `:Magenta abort` from a display buffer aborts that thread only.
  - Existing command tests pass unchanged, since they run with a single visible thread.

## Pane state

Status: DONE. `ChatState` → exported `SidebarState` in `chat.ts`; `activeThreadId` renamed `left`; `thread-selected` gains `right?: RightPane`. Pure transitions `paneTransition` (`reflect-created`, `show-reflection`, `show-reflections-overview`, `close-right-pane`), `reflectNavigateUp` and `selectThreadPanes` are exported and wrapped by Chat msgs (plus `reflect-navigate-up`, which falls through to `threads-navigate-up` with no right pane). Magenta dispatches `reflect-created` on creation, `show-reflection` on overview `<CR>`, `show-reflections-overview`/`close-right-pane` around the ad-hoc overview window, and `-` dispatches `reflect-navigate-up`. Normal `r` on a highlight still goes through `select-thread-effect`, which now uses `selectThreadPanes` (parent left, child right), equivalent to `show-reflection`. Removing the right thread clears `right`. Tests: `chat/pane-state.node.test.ts`. Deviations:
- `visible` is not in `SidebarState` yet; `Sidebar` still owns visibility (moved in the two-column stage).
- Since `parent` is always either `left` or the right pane's thread, the transitions just set `left = parent`; descent falls out of that.
- Single column still: `Chat.shownThreadId` (right reflection ?? `left`) is what the column, chrome, `getMessages`, external-target visibility and `revealThread` use. Tests that meant "shown" use it.
- Pane tests exercise the pure functions with a fake `getOrigin` rather than a `Chat` with a test session.
- Review follow-up: `thread-selected.right` is required (`RightPane | undefined`), so every construction decides it. `chat/pane-state.test.ts` (tier C) covers deleting the shown reflection (→ `{left, right: undefined}`), deleting `left` (→ overview), `-` beside a root closing the right pane and marking the reflection viewed, then falling through to navigate-up. `reflections-overview.test.ts` asserts `chat.state` after opening the overview, `-` closing it, and `<CR>` showing the child beside the source.

- Goal: `SidebarState` (replacing `ChatState`) carries `left`/`right`. Creation, `r` (on and off highlights), `-`, and thread-overview selection follow the transition rules.
- Tests (tier A/`node` project on `Chat` with a test session, no nvim):
  - Reflect from left: right pane = child. Reflect from right: shift left. `-` from depth 2 goes to depth 1 with the former left thread on the right. `-` with a root on the left closes the right pane on the first press. `-` with the overview open closes it. `-` with no right pane falls through to the existing navigate-up.
  - Depth 3 works (no cap).
  - Selecting a reflect thread in the overview opens parent left, it right.

## Two-column sidebar

Status: DONE. `Sidebar.syncRight(target)` reconciles the right column (display window split right of the left display at the left column's current width, both `winfixwidth`; an input window below it only when a thread is shown) and `hide` closes it; `columnOfWindow`/`getRightWindows` expose the handles. `Magenta.syncActiveView` binds the left column and then `syncRightColumn` (right thread buffers, lazily recreated via `ensureActiveIsMounted`, or the overview buffer). `ReflectionsOverview` no longer owns a window: it is a buffer + TEA app shown in the right display window, created/disposed from `SidebarState.right` (a replaced overview is closed only after its buffer has left the window, since deleting a shown buffer closes the window). Overview `dd` deletes that reflection (and its reflect subtree via `session.deleteThread`). `:bd` on a thread buffer drops its buffers (`BufferManager.removeThread`) and never deletes: right thread → `close-right-pane`, left thread → thread overview; `:bd` on the overview → `close-right-pane`. Closing a right window (`:q`) dispatches `close-right-pane`. Keys route to the mounted app of the buffer they were pressed in. `-` is now also bound in input buffers (normal mode) via `sidebarKeymaps`. Chat exposes `leftThreadId`/`rightThreadId`/`shownThreadIds()` (replacing `shownThreadId`); both are visible for external targets and viewed-marking. TEA fix: a render that races an unmount finishes against the root it started with. Tests: `chat/two-column.test.ts`; `buffer-manager.test.ts` `:bd` tests now assert the thread survives and buffers are recreated. Deviations:
- `visible` is not in `SidebarState`: `Sidebar` still owns left-column visibility; toggle re-syncs the right column from `right` after showing, so it comes back.
- There is no configured per-column width option; the right column copies the left column's width when opened.
- `-` keeps dispatching `:Magenta threads-navigate-up` (which runs `reflect-navigate-up`), not a new `reflect-up` command.
- `above/below/tab` positions don't open the right column; creating a reflection there notifies instead.
- Not tested: `-` from each of the four buffers individually, the left-buffer `:bd` with a reflection open, per-column abort/paste in two columns.

- Goal: the sidebar opens a second display+input column to the right of the first, total width 2×, and closes it when `right` clears.
- Tests (tier C):
  - Reflecting opens 4 magenta windows; the left column still shows the parent, the right shows the reflect thread, widths equal the configured column width.
  - `-` from each of the four buffers (normal mode) pops one level; in input insert mode `-` inserts text.
  - Closing a right-column window with `:q` clears `right` and leaves the left column open.
  - `:bd` on the reflect thread's display or input buffer, or on the overview, clears `right` and closes the right column, leaving the left column open.
  - `:bd` on a left-column buffer with a reflection open closes the right column: after toggling the sidebar or re-selecting the left thread, only one column opens.
  - `:bd` never deletes: after `:bd` on a thread's or reflection's buffer, `session.listThreads()` still has it, and re-selecting it recreates its buffers with its history intact.
  - `dd` on a reflection overview entry deletes that reflect thread and its reflect subtree; its highlight disappears from the left display.
  - Submitting from the right input goes to the reflect thread. `:Magenta abort` with the cursor in the left column aborts the left thread only. After focusing the right column and then a code buffer, `paste-selection` pastes into the right thread's input.
  - Each column's winbar shows its own thread's status.
  - Toggle hides/shows both columns and restores the right column if `right` is set.
