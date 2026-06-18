# Objective and Context

## User request (verbatim)

> Okay next up I'd like to make Magenta even more closely integrated with Neovim by exposing a programmatic interface to Neovim so that it can drive Magenta. In particular I want to expose a thread primitive. This should be similar to the script SDK.
>
> From the Lua side if Magenta is running you should be able to require Magenta if the bridge is active and send a request through it to execute a thread. You should be able to provide a prompt, context, files, system reminder, and a result schema and then the thread should appear in a similar manner as the script invocations. Maybe there's another section in thread overview that is kind of like Lua invocations or something like that instead of scripts. The thread runs until it yields and then it returns the result back through the yield tool, wired up very very similarly to how a script thread is wired up.
>
> The idea would be that if you are configuring your Neovim and you want to do something using Magenta, a Magenta thread, you can just write some Lua which triggers this through this API, this communication channel. I think we should start by just having a Lua invocations flat array instead of grouping them by scripts like we do in the scripts. Whenever you create a thread it just goes in this flat list and it's displayed under that section. There won't be any sort of log message or anything like that. It's just going to be the threads and they run until they yield and then we notify the Lua side of the result. Come up with a plan for how this might look like.

## What we're building

A Lua-facing API, `require("magenta").thread(opts, callback)`, that lets a
user's Neovim config drive Magenta. When the bridge is active, Lua sends a
request to Node to spawn a real Magenta thread seeded with a prompt (plus
optional context files, system reminder, and a result schema). The thread runs
until it calls `yield_to_parent`, at which point Node notifies the Lua side
with the yielded result.

This mirrors the existing **script SDK** thread primitive
(`thread(prompt, yieldSchema, options)` in scripts), but the orchestrator lives
in Lua instead of a forked Node script subprocess, and the spawned threads are
displayed in their own flat "Lua Threads" overview section rather than grouped
under a script invocation.

## Key entities

- **`LuaThreadInvocation`** (new): one Lua-driven thread request. Fields:
  `id` (branded `LuaThreadInvocationId`), `luaRequestId` (number, supplied by
  Lua to correlate the eventual result), `prompt`, optional `resultSchema`,
  `status` (`"running" | "yielded" | "error"`), and `threadId` (the spawned
  thread once created). Unlike `ScriptInvocation` there are **no logs and no
  entries array** — a single thread per invocation, displayed flat.
- **`LuaThreadManager`** (new): owns a flat `Map<LuaThreadInvocationId,
  LuaThreadInvocation>`, handles create requests, registers the yield callback,
  notifies Lua of results, and renders the "# Lua Threads" overview section.
  Analogous to `ScriptManager` but much smaller.
- **`chat.spawnLuaThread(...)`** (new): spawns a `threadType: "subagent"` thread
  tagged with a new `luaThreadInvocationId` on its `ThreadWrapper`, equipped
  with the `yield_to_parent` tool whose input schema is `resultSchema`.

## Relevant files

- `lua/magenta/init.lua` — bridge; will gain the public `thread()` API, a
  pending-callback table, and a `_resolve_lua_thread()` dispatcher.
- `node/magenta.ts` — registers RPC notification handlers; constructs managers;
  composes the overview (`renderThreadOverview() + scriptManager.view()`).
- `node/scripts/script-manager.ts` — reference implementation for the
  create-thread → spawn → onThreadYielded → resolve flow, and for `view()`.
- `node/chat/chat.ts` — `spawnScriptThread`, `onThreadYielded`,
  `getThreadResult`, `renderScriptThreadSubtree`, and the top-level overview
  filter that excludes script-owned threads; the `ThreadWrapper` type.
- `node/core/src/tools/yield-to-parent.ts` — yield tool spec with custom schema.
- `node/capabilities/nvim-lua-executor.ts` — example of Node→Lua via
  `nvim.call("nvim_exec_lua", ...)`, the channel we use to deliver results.

# Design

## Communication channel

We reuse the two existing primitives of the bridge, mirroring the LSP
request/response pattern but in the opposite direction:

- **Lua → Node (request)**: Lua calls `vim.rpcnotify(channel_id,
  "magentaLuaThread", payload)` (fire-and-forget) where `payload` carries a
  `luaRequestId` plus the thread spec. This is exactly how `magentaLspResponse`
  travels, just for a new method name.
- **Node → Lua (result)**: when the thread yields, Node calls
  `nvim.call("nvim_exec_lua", ["require('magenta')._resolve_lua_thread(...)",
  [luaRequestId, resultJson]])` — the same mechanism the `nvim_lua` tool and
  the bridge handshake already use. Lua looks up the pending callback by
  `luaRequestId` and invokes it.

Lua cannot block, so the public API is **callback-based**:

```lua
local magenta = require("magenta")
magenta.thread({
  prompt = "…",
  context_files = { "/abs/path/a.ts" },   -- optional
  system_reminder = "…",                   -- optional
  result_schema = {                        -- optional JSON Schema
    type = "object",
    properties = { summary = { type = "string" } },
    required = { "summary" },
  },
}, function(err, result)
  -- err is non-nil on failure; result is the decoded yielded value
end)
```

If the bridge is not active (`M.channel_id == nil`) the call fails fast with an
error (returned/raised synchronously) and the callback is not registered.

Lua keeps a module-local table `pending_threads[luaRequestId] = callback` and a
monotonically increasing counter. `_resolve_lua_thread(requestId, payload)`
decodes `payload` with `vim.json.decode`, pops the callback, and invokes it
(wrapped in `vim.schedule` / `pcall` for safety).

## Node-side flow

1. `magenta.ts` registers an `onNotification("magentaLuaThread", …)` handler
   that forwards the payload to `luaThreadManager.createThread(payload)`.
2. `LuaThreadManager.createThread` allocates a `LuaThreadInvocationId`, stores a
   `running` invocation, and calls `chat.spawnLuaThread({ luaThreadInvocationId,
   prompt, yieldSchema: resultSchema, contextFiles?, systemReminder?, cwd? })`.
3. On the returned `threadId`, it records `invocation.threadId` and registers
   `chat.onThreadYielded(threadId, …)`. When the thread reaches `yielded` mode,
   the callback reads `chat.getThreadResult(threadId)`, and on `status: "done"`
   delivers the result to Lua (decoding the JSON-stringified yield back into a
   value if a `resultSchema` was used, exactly as `ScriptManager.resolveThread`
   does), sets `invocation.status = "yielded"`, and refreshes the overview.
4. Spawn failures set `invocation.status = "error"` and notify Lua with an error.

`spawnLuaThread` is a near-copy of `spawnScriptThread`: same
`createThreadWithContext` call with `threadType: "subagent"` and the
`yieldSchema` passed through to the `yield_to_parent` tool, except it tags the
`ThreadWrapper` with `luaThreadInvocationId` instead of `scriptInvocationId`,
and it does not wire a sandbox-bypass `getSandboxRoot` (Lua threads have no
sandbox-toggle UI in v1; they inherit the default sandbox). Consider
generalizing the two into one `spawn` taking an owner tag, but a parallel method
is acceptable for the first cut.

## Rendering

Add `luaThreadManager.view()` to the overview composition in `magenta.ts`
alongside `scriptManager.view()`, producing a `# Lua Threads` section. Because
there are no logs, the view is a flat list: for each invocation render the
spawned thread (and any descendants it itself spawns) using the existing
`chat.renderScriptThreadSubtree(threadId, depth)` helper — that helper is
already generic over any thread, despite its name. Each row shows the same
status indicators / token counts / attention bell and navigation keybindings as
script-spawned threads.

The top-level overview filter in `chat.ts` (which currently excludes threads
with `parentThreadId !== undefined` or `scriptInvocationId !== undefined`) must
**also** exclude threads with `luaThreadInvocationId !== undefined`, so Lua
threads appear only under the new section, never at top level.

Invariants:

- A `luaRequestId` is owned by exactly one pending callback on the Lua side and
  is delivered to at most once (pop-on-resolve); a thread that never yields
  never resolves its callback (acceptable — matches script threads, which also
  hang until yield).
- Result decoding must match the yield encoding: with a `resultSchema`, the
  yielded value is the JSON-stringified `yield_to_parent` input; without one, it
  is the `{ result: string }` default. Lua receives the **decoded** value.
- Lua threads must never render at the top level of the overview.
- If the bridge is torn down, in-flight Lua threads keep running in Node but
  their result delivery (`nvim_exec_lua`) will fail; this is logged, not fatal —
  same resilience posture as other Node→Lua calls.

## Alternatives considered

- **Lua→Node as an rpcrequest (synchronous)**: rejected — threads are
  long-running and Lua must not block; a notify + async callback fits the
  existing bridge and the LSP precedent.
- **Reusing `ScriptManager` with a synthetic invocation**: rejected — scripts
  model a subprocess with logs and a one-to-many script→threads relationship.
  The user explicitly wants a flat list with no logs, so a dedicated, smaller
  manager is cleaner.

# Stages

## Stage 1 — Node core: LuaThreadManager + spawnLuaThread + yield resolution

- Goal: Node can, on receiving a create request (called directly in a test),
  spawn a subagent thread seeded with a prompt + optional context/system
  reminder/result schema; when that thread yields, the manager invokes a
  result-delivery callback with the correctly decoded value. No Lua, no
  rendering yet.
- Build: `LuaThreadInvocation`/`LuaThreadInvocationId` types and
  `LuaThreadManager` (create + onThreadYielded + resolve, delivery via an
  injected `notifyLua(requestId, payload)` seam); `chat.spawnLuaThread`;
  `luaThreadInvocationId` field on `ThreadWrapper`.
- Verification (node integration test, following script-manager tests +
  doc-testing skill with a mock provider):
  - Behavior: a create request spawns a subagent thread whose `yield_to_parent`
    input schema is the supplied `result_schema`.
    - Setup: driver with mock provider; call `luaThreadManager.createThread`
      with a prompt and a `result_schema`.
    - Actions: drive the mock thread to call `yield_to_parent` with a structured
      value.
    - Expected: the injected `notifyLua` seam is called once with the matching
      `luaRequestId` and the decoded structured value.
  - Behavior: default schema path — no `result_schema` yields `{ result }`.
  - Behavior: spawn/error path delivers an error to `notifyLua`.
- Before moving on: confirm tests, type checks, and linting all pass.

## Stage 2 — Overview rendering

- Goal: running and yielded Lua threads render in a flat `# Lua Threads`
  section; they no longer appear at the top level of the overview.
- Build: `LuaThreadManager.view()` using `renderScriptThreadSubtree`; compose it
  into the overview in `magenta.ts`; extend the top-level overview filter in
  `chat.ts` to exclude `luaThreadInvocationId` threads.
- Verification:
  - Behavior: a spawned Lua thread shows under `# Lua Threads` and is absent
    from the top-level thread list.
    - Setup: driver; create a Lua thread via the manager.
    - Actions: render the overview.
    - Expected: overview text contains the `# Lua Threads` section with the
      thread row, and the thread id is not present in the top-level listing.
  - Behavior: navigation/expand keybindings on the rendered row resolve to the
    spawned thread (smoke check mirroring script-subtree rendering).
- Before moving on: confirm tests, type checks, and linting all pass.

## Stage 3 — Lua API + bridge wiring (end to end)

- Goal: `require("magenta").thread(opts, cb)` drives a thread end-to-end and the
  callback fires with the yielded result; bridge-inactive calls fail fast.
- Build: in `init.lua`, the public `thread()` (validates bridge active,
  allocates `luaRequestId`, stores callback, rpcnotifies `magentaLuaThread` with
  the serialized spec) and `_resolve_lua_thread(requestId, payload)` dispatcher;
  in `magenta.ts`, the `magentaLuaThread` notification handler and a real
  `notifyLua` that calls `nvim.call("nvim_exec_lua", …)`; a new notification
  constant.
- Verification:
  - Behavior: end-to-end — a `magentaLuaThread` notification spawns a thread,
    and on yield Node calls `nvim_exec_lua` with `_resolve_lua_thread`, the
    request id, and the encoded result.
    - Setup: driver with mock provider; deliver the notification through the
      handler (as the bridge would).
    - Actions: drive the thread to yield.
    - Expected: a recorded `nvim_exec_lua` call carries the right
      `luaRequestId` and JSON result payload.
  - Behavior: calling `thread()` with the bridge inactive raises/returns an
    error and does not register a callback (lua-level unit test if feasible,
    else asserted via the guard in code review).
- Before moving on: confirm tests, type checks, and linting all pass.

# Out of scope (v1)

- Sandbox-bypass toggle UI for Lua threads.
- Streaming progress / logs back to Lua (none, by request).
- Cancellation API from Lua.
- A typed Lua SDK / type annotations beyond the raw callback API.
