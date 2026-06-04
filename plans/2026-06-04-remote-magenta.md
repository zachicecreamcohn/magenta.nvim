# Objective and Context

The goal is to build on top of magenta to serve up a clean UI built with [vamp](https://github.com/dlants/vamp) which cleanly exposes the magenta buffer UI so we can interact with and control magenta from across the network.

We will serve the frontend over tailscale so other devices can use it.


## UI
Aside from being built with [vamp](https://github.com/dlants/vamp), it needs to be mobile friendly.

# Decisions

- **MVP = mirror.** The web UI mirrors the rendered chat/display output; the polished v2 (later) re-renders from the underlying controller state in vamp.
- **In-process.** The web server lives inside the existing node process (`node/magenta.ts`), so it can tap the render pipeline and call the existing central `dispatch` directly.
- **Companion only.** Magenta runs on the host machine with an nvim session; the web UI is a remote control, not a standalone runtime.
- **Transport: SSE down, POST up.** Traffic is asymmetric — a stream of agent output downstream, discrete user actions upstream. SSE gives free browser reconnection and is plain HTTP (nice over Tailscale); commands (send/abort/approve/reject) are one-shot `POST`s that route into the same `dispatch` path a local user triggers. Their effects show up in the SSE stream.
- **Full interaction from day one** (send prompt, abort, tool-use approval). No `@`-command autocomplete in MVP (v2).
- **Tailscale only (final state).** Detect the `100.x.y.z` Tailscale interface address at startup and bind only to it. No extra auth beyond Tailscale. During development we bind to `0.0.0.0` for easy local/LAN testing and switch to Tailscale-only as the last slice.
- **vamp is vendored.** Copy `vamp.ts` into `node/web-client/` and import locally (`./vamp.js`). No npm dependency; we own the file.

# Architecture

## Server (in `node/magenta.ts`'s process)

HTTP server bound to the detected Tailscale IP, configurable port (default in `options.lua`).

- `GET /` → serves the vamp web client (static HTML/JS from `node/web-client/`).
- `GET /events` → SSE stream. On every render, pushes a snapshot:
  `{ chatText: string, status: Status }`.
- `POST /action` → body is one of:
  `{ type: "send", text } | { type: "abort" } | { type: "approve", id } | { type: "reject", id }`.
  Each maps to the **same** dispatch/command path a local nvim user triggers:
  - `send` → `preprocessAndSend(text)` (node/magenta.ts:829) — reuses command parsing, resubmit, context, etc.
  - `abort` → dispatch `{ type: "thread-msg", id, msg: { type: "abort" } }` (node/magenta.ts:511).
  - `approve`/`reject` → dispatch the corresponding tool-approval message for the pending tool `id`.

## Mirror tap

The render pipeline flattens the VDOM tree to a string in `node/tea/render.ts` (`traverse()`), then writes it to the buffer via `replaceBetweenPositions()` (node/tea/util.ts). Tap the flattened `content` string *before* the buffer write and emit it to connected SSE clients. This keeps the web text decoupled from buffer mechanics so v2 can style it separately.

## Status object (drives the action buttons)

The pure text mirror can't carry interactivity, so the SSE payload includes a small status object describing currently-available actions:

```
type Status = { running: boolean; pendingApproval?: { id: string; toolName: string } };
```

Derived from thread/tool state on each render. The client uses it to decide which buttons to show.

# Implementation Plan (vertical slices)

Build end-to-end (nvim → server → browser) slices so each is manually testable, then widen. Infra risk is front-loaded; Tailscale is deferred so dev testing needs no Tailscale.

1. **[DONE] Hello.** In-process HTTP server bound to `0.0.0.0` (dev), serving a static vamp page at `/`. Test: open in laptop browser. Proves the web-client workspace, vamp build/serve, in-process server, and options wiring.
2. **[DONE] See the chat.** `GET /events` SSE + render tap; vamp client renders `chatText` in a scrolling window (read-only mirror). Test: type in nvim, watch it appear in the browser live.
3. **[DONE] Send a prompt.** Textarea + Send → `POST /action {type:"send"}` → `preprocessAndSend`. Test: send a prompt from the browser, watch the agent respond in the mirror.
4. **[DONE] Abort.** Add `status.running` to the SSE payload + Abort button + `POST {type:"abort"}`. Test: send a long prompt, abort it from the browser.
5. **[DONE] Approve tools.** Add `status.pendingApproval` + Approve/Reject buttons + those POST actions. Test: trigger a tool that needs approval, approve from the browser.
6. **[TODO — next] Tailscale hardening.** Detect the `100.x.y.z` interface and bind only to it. Test: connect from a phone over Tailscale.

## Progress log

### Slice 1 — Hello (DONE, commit 4660931 on branch zach/remote-magenta)

Delivered:

- New `@magenta/web-client` npm workspace (`node/web-client/`) with `package.json`, browser `tsconfig.json` (DOM libs, not composite), a vendored `vamp.ts` (verbatim from dlants/vamp), `index.ts` (minimal vamp `RootView` rendering a hello heading), and `index.html` loading `/web-client.js` into `#root`.
- `node/web-server.ts` — `WebServer` class using `node:http` only (no new deps). Binds `0.0.0.0` on the configured port; serves `GET /` → `index.html` and `/web-client.js` from the dist dir (resolved via `import.meta.url`); 404 otherwise. Has `start()`/`close()`.
- Wired into `node/magenta.ts`: `WebServer` is constructed + started at the end of the `Magenta` constructor when `options.webServerPort !== undefined`, and closed in `destroy()`.
- Options: `webServerPort?: number` on `MagentaOptions` (`node/options.ts`), parsed in the main `parseOptions` path (positive-integer validation, warn otherwise); lua default `webServerPort = 8765` in `lua/magenta/options.lua`.
- Build: `scripts/build.mjs` gained a second esbuild invocation bundling `node/web-client/index.ts` → `dist/web-client.js` (`--platform=browser --format=esm`), and copies `index.html` → `dist/index.html`. `node/web-client/**` excluded from the root `tsconfig.json` (built separately).

Verified: `npx tsgo -b`, `npx tsgo -p node/web-client/tsconfig.json --noEmit`, `npm run bundle` all clean; page renders "magenta remote — hello" in the browser via nvim-launched server. Build note: run `npm run bundle` (not bare `node scripts/build.mjs`) so `esbuild` resolves from `node_modules/.bin`.

### Slice 2 — See the chat (DONE, branch zach/remote-magenta)

Delivered a read-only live mirror of the chat transcript:

- **Render tap (full transcript only).** `node/tea/tea.ts` owns an optional `renderTap` + `setRenderTap(tap)`, fired from the *top-level* render cycle (after `root.render()`, plus the error-recovery re-mount path) with `flattenMountedNode(root._getMountedNode())` — the complete app tree. `node/tea/view.ts` gained `flattenMountedNode()` (recursive string/node/array flatten). The tap is deliberately NOT in the low-level `render()` in `node/tea/render.ts`, which is also used for incremental sub-tree updates and would emit fragments. The tea layer stays generic (no web-server import); the root layer wires it.
- **Server.** `node/web-server.ts` adds a `GET /events` SSE endpoint (text/event-stream, keep-alive), a connected-client set, `pushSnapshot(chatText)`, latest-snapshot replay on connect, and client cleanup on close. Exported `Status = { running: boolean }` (extensible for slices 4/5; `running` hardcoded `false` for now). Payload per message: JSON `{ chatText, status }`.
- **Wiring.** `node/magenta.ts` imports `setRenderTap` from `./tea/tea.ts`; in the `webServerPort` block it registers `setRenderTap((content) => webServer.pushSnapshot(content))`, and clears it (`setRenderTap(undefined)`) + closes the server in `destroy()`.
- **Client.** `node/web-client/index.ts` is now a full vamp app: opens `EventSource('/events')`, parses snapshots into state, renders `chatText` in a full-height scrolling read-only `<pre>` via XSS-safe `bindText`, mobile-first CSS. Auto-scroll sticks to the bottom only when already near it (within 40px) so you can scroll up through history without being yanked down.

Bug fixed during this slice: initial tap placement in `render.ts` captured per-render fragments, so the client showed only the last line; moved to the top-level render in `tea.ts` (see above).

Verified: `npx tsgo -b`, web-client typecheck, `biome check`, and `npm run bundle` all clean; confirmed live in the browser (full scrollable transcript, appends live).

### Slice 3 — Send a prompt (DONE, branch zach/remote-magenta)

Upstream interaction: send a prompt from the browser into the same path local nvim input takes.

- **Server.** `node/web-server.ts` adds `export type Action = { type: "send"; text: string }` (union, extensible for abort/approve/reject) and a `POST /action` endpoint (`handleAction`/`parseAction`/`respondError`). Routes on method+path; reads + JSON-parses + shape-validates the body; **204** on success, **400** invalid JSON/unknown action, **413** body >1MB, **500** if the handler throws. Never throws out of the request handler. The `WebServer` constructor gained an `onAction: (action: Action) => void` param so the server stays decoupled from `Magenta` internals.
- **Routing.** `node/magenta.ts` passes an `onAction` handler that switches on `action.type`; for `send` it calls the existing **private** `this.preprocessAndSend(action.text)` (unchanged — same @fork/@compact/@async + command-expansion path a local user triggers), logging rejections; `assertUnreachable` default. The agent's response surfaces via the existing SSE mirror.
- **Client.** `node/web-client/index.ts` adds a bottom input row (`<textarea>` + Send button) below the transcript; `Msg` union gains `input`/`send`; sends via `fetch("/action", { method: "POST", ... })`. Enter sends, Shift+Enter inserts a newline; Send is `bindDisabled` when the trimmed input is empty; the textarea is cleared after a successful send (DOM reconciled in `sync()`).

Verified: `npx tsgo -b`, web-client typecheck, `biome check`, `npm run bundle` all clean; confirmed live in the browser (sent a prompt, agent responded in the mirror).

### Slice 4 — Abort (DONE, branch zach/remote-magenta)

Real `running` status + remote abort.

- **Real status.** The SSE `status.running` is now live (was hardcoded `false`). `WebServer` gained a `getStatus: () => Status` constructor callback; `snapshot()` calls it on every push. `node/magenta.ts` provides it, computing `running` from the active thread: `const id = this.chat.state.activeThreadId; running = id !== undefined && this.chat.getThreadSummary(id).status.type === "running"`. `Chat.getThreadSummary()` (node/chat/chat.ts:1069) reports `type:"running"` while streaming a response or executing tools — the abortable states. Server stays decoupled (Magenta injects the value).
- **Abort action.** `Action` union extended with `{ type: "abort" }`; `parseAction` accepts it. `onAction`'s `case "abort"` reuses the EXACT dispatch the local `command()` abort triggers — `this.dispatch({ type: "thread-msg", id: activeThreadId, msg: { type: "abort" } })` — guarded on `activeThreadId !== undefined`. Switch exhaustiveness is now `assertUnreachable(action)`.
- **Client.** `node/web-client/index.ts` adds an Abort button in the input row, shown only when `status.running` via `bindVisible`; click POSTs `/action {type:"abort"}` through the existing `postAction` helper. `Action`/`Msg` unions extended.

Verified: `npx tsgo -b`, web-client typecheck, `biome check`, `npm run bundle` all clean; confirmed live (long prompt → Abort button appears → click stops the run in the mirror).

### Slice 5 — Approve tools (DONE, branch zach/remote-magenta)

Remote tool-approval (sandbox violation) prompts.

- **Status.** `Status` gains `pendingApproval?: { id: string; toolName: string }`. `node/magenta.ts`'s `getStatus` now resolves the active thread's `SandboxViolationHandler` (via a new private `getActiveSandboxViolationHandler()` — reads `chat.state.activeThreadId`, the `threadWrappers[id]` initialized wrapper, and `thread.sandboxViolationHandler`), takes the first of `handler.getPendingViolations()`, and surfaces `{ id, toolName }`. `toolName` comes from a new `sandboxPromptLabel()` helper that maps each `PendingViolation["prompt"]` kind (`violation` → command, `approval-prompt` → command, `write-approval` → `Write to <absPath>`) to a label.
- **Actions.** `Action` union extended with `{ type: "approve"; id: string }` and `{ type: "reject"; id: string }`; `parseAction` accepts them (string `id` required). `onAction` routes them to `getActiveSandboxViolationHandler()?.approve(id)` / `.reject(id)`. Switch stays exhaustive via `assertUnreachable`.
- **Client.** `node/web-client/index.ts` adds an approval row (label + Approve/Reject buttons) above the input row, gated on `status.pendingApproval !== undefined` via `bindVisible`; the label shows `pendingApproval.toolName`. `Msg`/`Action` unions gain `approve`/`reject`; the handlers read the id from `state.status.pendingApproval` at click time (no stale capture) and POST `/action { type, id }`.

Verified: `npx tsgo -b`, web-client typecheck, `biome check` all clean; committed (dea6331).

# UI (vamp, in `node/web-client/`)

New workspace under `node/` (outside `@magenta/core` and the nvim root) with a vendored `vamp.ts`. Mobile-first.

MVP layout:
- Full-height scrolling chat window showing the mirrored `chatText`.
- A row of **action buttons above the textarea**, hidden until needed: **Abort** shown when `status.running`; **Approve**/**Reject** shown when `status.pendingApproval` is set (the button POSTs the relevant `id`). Markdown-ish text is preserved as-is for now.
- A `<textarea>` + Send at the bottom that POSTs `{ type: "send", text }`.

# Polish (v2, later)

- Re-render from the underlying controller state in vamp instead of mirroring rendered text.
- Inline approval controls that match how magenta's buffer renders them, instead of a separate action-button row.
- Collapsible side panel for thread switching.
- `@`-command autocomplete in the input.
