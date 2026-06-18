# Objective and Context

User request, verbatim:

> I want to give Magenta access to the neovim instance that it's running inside of. In particular I want it to be able to execute arbitrary Lua code. I think there is a neovim API already that allows you to run Lua code so take a look at what that API looks like. I think we even exercised it in a couple of places in the code already. Write a plan for what it would look like to expose it as a tool. The tool interface should just be that the agent generates Lua code and neovim runs it and then the agent gets the response, the result of that execution.

We want a new static tool — call it `nvim_lua` — that lets the agent send a chunk of Lua source to the host neovim instance, have it evaluated, and receive the return value (or error) back as the tool result.

Neovim already exposes this via the RPC method `nvim_exec_lua(code, args)`. The codebase already uses it (e.g. `node/nvim/nvim.ts` `notify()` calls `nvim.call("nvim_exec_lua", [luaScript, []])`). Its typed signature lives in `node/nvim/nvim-node/neovim-api.types.ts`:

- `nvim_exec_lua: { parameters: [code: string, args: unknown[]]; return_type: unknown }`

The whole value of the tool is that it bridges from the agent into the live editor. That has an important architectural consequence: the `nvim` handle lives only in the **root** (neovim) layer, while tools are defined in **core** (`@magenta/core`), which by design has no neovim dependency. So we cannot call `nvim.call` directly from the tool. We must follow the existing **capability** pattern: define an abstract capability interface in core, implement it in the root using the real `nvim` handle, and inject it through the existing context plumbing.

## Key entities and how they relate

- `nvim_exec_lua` — the underlying neovim RPC method.
- A new core capability interface, e.g. `LuaExecutor` (in `node/core/src/capabilities/lua-executor.ts`), with a single method like `execLua(code: string): Promise<unknown>`. This mirrors `LspClient`, `Shell`, `FileIO`, `HelpTagsProvider`.
- A new tool module `node/core/src/tools/nvimLua.ts` exporting `execute`, `spec`, `Input`, `validateInput` — following the shape of `hover.ts` / `bashCommand.ts`.
- A root-side implementation of `LuaExecutor`, e.g. `node/capabilities/nvim-lua-executor.ts`, wrapping `nvim.call("nvim_exec_lua", [code, []])`.
- A new `ToolCapability` value `"nvim"` (in `tool-registry.ts`) gating the tool to environments that actually have a live neovim (local only — not docker, which has no nvim).

## Relevant files

- `node/core/src/tools/tool-registry.ts` — tool-name lists, `TOOL_CAPABILITIES`, `TOOL_REQUIRED_CAPABILITIES`. Add `nvim_lua` and `"nvim"` capability.
- `node/core/src/tools/toolManager.ts` — `StaticToolMap`, `TOOL_SPEC_MAP`. Register the new tool's input type and spec.
- `node/core/src/tools/create-tool.ts` — `CreateToolContext` and the dispatch switch. Add `luaExecutor` to context and a `case "nvim_lua"`.
- `node/core/src/tools/helpers.ts` — `validateInput` dispatch switch. Add the new tool's `validateInput`.
- `node/core/src/thread-core.ts` — `ThreadCoreContext` and the `CreateToolContext` construction (~line 676). Thread the `luaExecutor` through.
- `node/environment.ts` — `Environment` interface + `createLocalEnvironment` / `createDockerEnvironment`. Provide a `LuaExecutor` (local) and `undefined`/absent (docker), and add `"nvim"` to local `availableCapabilities`.
- `node/chat/thread.ts` — passes environment capabilities into `ThreadCore` context (~lines 296-305, 527-533). Thread `luaExecutor` through.
- `node/capabilities/lsp-client-adapter.ts` (reference pattern) and a new `node/capabilities/nvim-lua-executor.ts` (the implementation).

# Design

The flow mirrors every other capability-backed tool:

1. The agent calls `nvim_lua` with `{ code: string }`.
2. The tool's `execute` calls `context.luaExecutor.execLua(code)`.
3. The root implementation calls `nvim.call("nvim_exec_lua", [code, []])`, which evaluates the Lua chunk in the host neovim and returns whatever the chunk `return`s (msgpack-decoded into a JS value), or rejects if the Lua raises an error.
4. The tool formats the result into a text tool-result and returns it.

## Result formatting

`nvim_exec_lua` returns `unknown` — it could be nil, a number, a string, a table, etc. Two options for presenting it to the agent:

- (A) Format on the **Lua side**: wrap the user code so the return value is passed through `vim.inspect` and returned as a string. This gives human-readable, faithful output for tables. Downside: requires wrapping the user's code (e.g. `return vim.inspect((function() <code> end)())`), which subtly changes semantics — a bare statement chunk vs. an expression.
- (B) Format on the **JS side**: pass the code through unmodified, take the decoded return value, and `JSON.stringify` it (with a fallback to `String()` for non-JSON-able values like functions/undefined).

Recommended: **(B)** for the capability boundary (keep `execLua` a thin, faithful pass-through returning `unknown`), and let the **tool** decide presentation — `JSON.stringify(result, null, 2)` when serializable, else `String(result)`, and a special-case message when the result is `undefined`/nil ("executed successfully, no return value"). This keeps the capability minimal and testable, and avoids mutating the user's Lua.

## Error handling

If the Lua chunk raises, `nvim.call` rejects. The tool catches and returns a `status: "error"` result containing the error message — same shape as the `catch` blocks in `hover.ts`. No partial state to clean up.

## Capability gating

Add `"nvim"` to `TOOL_CAPABILITIES` and set `TOOL_REQUIRED_CAPABILITIES.nvim_lua = new Set(["nvim"])`. Local environment advertises `"nvim"`; docker environment does not, so `getToolSpecs` filters the tool out there automatically. The tool is added **only** to `CHAT_STATIC_TOOL_NAMES` (root). It is deliberately **not** added to `SUBAGENT_STATIC_TOOL_NAMES`, `DOCKER_ROOT_STATIC_TOOL_NAMES`, or `COMPACT_STATIC_TOOL_NAMES`.

## No confirmation

The tool runs the supplied Lua immediately, with no approval/confirmation step — matching the "just run it" request.

## Abort

Match the existing `ToolInvocation` contract: provide an `abort` that flips an `aborted` flag and short-circuits the result, as in `hover.ts`. The underlying RPC call itself isn't cancelable, but the tool can ignore a late result once aborted.

Invariants:
- Core must not import anything neovim-specific; the tool only ever touches the `LuaExecutor` interface. The concrete `nvim` handle stays in the root.
- `execLua` is a faithful pass-through: it must not swallow Lua errors (they must reject) and must not reformat successful return values.
- The tool must be unavailable in environments lacking a live neovim (docker), enforced via the `"nvim"` capability, not ad-hoc checks.
- Internals use `undefined`, never `null`; convert any `null` from the msgpack boundary to `undefined` immediately.
- No new `any` types — the capability returns `unknown` and the tool narrows it.

# Stages

## Stage 1 — Core capability + tool module (no wiring)

**Status: COMPLETE.** Created `node/core/src/capabilities/lua-executor.ts` (`LuaExecutor` interface with `execLua(code): Promise<unknown>`) and `node/core/src/tools/nvimLua.ts` exporting `execute`, `spec`, `Input`, `validateInput`. Result formatting: undefined/null → "no return value" message; serializable → `JSON.stringify(value, null, 2)`; otherwise `String(value)`. Deviation: `ToolRequest` is defined inline (not via `GenericToolRequest`) and `structuredResult.toolName` is cast `as ToolName`, because `"nvim_lua"` is not yet a `StaticToolName` — that registration happens in Stage 2. Tests in `nvimLua.test.ts` cover table/undefined/null/error/validateInput. Following code review, added tests for the abort path (abort before both resolve and reject of `execLua`) and the `formatResult` non-serializable fallback (circular object → `String()`). Full `npx tsgo -b`, `npx vitest run node/core/...`, and `npx biome check .` pass.

- Goal: `LuaExecutor` interface exists in core; `nvimLua.ts` tool exports `execute`, `spec`, `Input`, `validateInput`, and correctly formats success/error/empty results given a mock `LuaExecutor`. Tool not yet reachable by the agent.
- Verification:
  - Behavior: returns serialized result for a table return value.
    - Setup: a stub `LuaExecutor` whose `execLua` resolves to `{ a: 1, b: [2,3] }`.
    - Actions: call `execute({ code: "return {...}" })`.
    - Expected: `status: "ok"` text result containing the JSON-formatted table.
  - Behavior: nil/undefined return value.
    - Setup: stub resolves `undefined`.
    - Expected: `status: "ok"` with a "no return value" style message.
  - Behavior: Lua error.
    - Setup: stub `execLua` rejects with `Error("...")`.
    - Expected: `status: "error"` containing the message.
  - Behavior: `validateInput` rejects non-string `code`.
- Before moving on: confirm tests, type checks (`npx tsgo -b`), and linting (`npx biome check .`) pass.

## Stage 2 — Register the tool in core plumbing

**Status: COMPLETE.** Registered `nvim_lua` as a `StaticToolName` in `tool-registry.ts` (added to `STATIC_TOOL_NAMES` and `CHAT_STATIC_TOOL_NAMES` only), added the new `"nvim"` capability to `TOOL_CAPABILITIES`, and set `TOOL_REQUIRED_CAPABILITIES.nvim_lua = new Set(["nvim"])`. Wired into `StaticToolMap`, `TOOL_SPEC_MAP`, `create-tool.ts` dispatch (new `case "nvim_lua"` reading `context.luaExecutor`, throwing if absent), and `helpers.ts` validate switch. Added `luaExecutor?: LuaExecutor | undefined` to both `CreateToolContext` and `ThreadCoreContext`, threaded through the `toolContext` construction in `thread-core.ts`. Deviation: made `luaExecutor` optional (like `scriptRunner`) since docker/non-nvim environments won't provide it; the tool's capability gating prevents it from being reachable there, and `create-tool` throws defensively if invoked without it. Also had to add exhaustive `case "nvim_lua"` branches to the root render switches in `node/render-tools/index.ts` (renderSummary, renderResultSummary) and `node/render-tools/streaming.ts` to keep the project's typecheck green. Added a `getToolSpecs` test in `toolManager.test.ts` asserting `nvim_lua` is present for root with the `"nvim"` capability and absent without it. Full `npx tsgo -b`, `npx vitest run node/core/`, and `npx biome check .` pass.

- Goal: `nvim_lua` is a known `StaticToolName`, wired into `StaticToolMap`, `TOOL_SPEC_MAP`, `create-tool.ts` dispatch (reading `context.luaExecutor`), `helpers.ts` validate switch, `tool-registry.ts` name-lists and `TOOL_REQUIRED_CAPABILITIES` with the new `"nvim"` capability. `CreateToolContext` and `ThreadCoreContext` carry `luaExecutor`.
- Verification:
  - Behavior: `getToolSpecs` includes `nvim_lua` for a root thread whose `availableCapabilities` has `"nvim"`, and excludes it when it doesn't.
    - Setup: call `getToolSpecs("root", mockMcp, new Set([... ,"nvim"]))` vs a set without `"nvim"`.
    - Expected: spec present / absent accordingly.
  - Behavior: type-level — `createTool` compiles with the new `case` and required context field.
- Before moving on: confirm tests, type checks, and linting pass.

## Stage 3 — Root implementation + environment wiring

- Goal: `NvimLuaExecutor` in `node/capabilities/nvim-lua-executor.ts` implements `LuaExecutor` via `nvim.call("nvim_exec_lua", [code, []])`; `createLocalEnvironment` provides it and adds `"nvim"` to `availableCapabilities`; `createDockerEnvironment` omits it; `thread.ts` threads `luaExecutor` into the `ThreadCore` context at both construction sites.
- Verification:
  - Behavior: end-to-end integration — agent invokes `nvim_lua`, code runs in the real neovim and the return value comes back.
    - Setup: `withDriver()` integration test; mock provider issues an `nvim_lua` tool call with code like `return 1 + 2` and code with a side effect (e.g. `vim.g.magenta_test = 42; return vim.g.magenta_test`).
    - Actions: drive the thread to execute the tool.
    - Expected: tool result contains `3` / `42`; the side effect is observable via the driver/nvim.
  - Behavior: Lua error surfaces as an error tool result.
    - Setup: code `error("boom")`.
    - Expected: `status: "error"` containing `boom`.
- Before moving on: confirm full test suite, type checks, and linting pass.

# Resolved decisions

- Tool exposure: **root only**. Not available to subagents, docker-root, or compact threads.
- No confirmation/approval step — Lua runs immediately.
