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

1. **Hello.** In-process HTTP server bound to `0.0.0.0` (dev), serving a static vamp page at `/`. Test: open in laptop browser. Proves the web-client workspace, vamp build/serve, in-process server, and options wiring.
2. **See the chat.** `GET /events` SSE + render tap; vamp client renders `chatText` in a scrolling window (read-only mirror). Test: type in nvim, watch it appear in the browser live.
3. **Send a prompt.** Textarea + Send → `POST /action {type:"send"}` → `preprocessAndSend`. Test: send a prompt from the browser, watch the agent respond in the mirror.
4. **Abort.** Add `status.running` to the SSE payload + Abort button + `POST {type:"abort"}`. Test: send a long prompt, abort it from the browser.
5. **Approve tools.** Add `status.pendingApproval` + Approve/Reject buttons + those POST actions. Test: trigger a tool that needs approval, approve from the browser.
6. **Tailscale hardening.** Detect the `100.x.y.z` interface and bind only to it. Test: connect from a phone over Tailscale.

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
