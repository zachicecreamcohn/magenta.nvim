# Progress Tracker

- [x] **Stage 1** — Generalize `yield_to_parent` to schema-driven structured yield. DONE.
- [x] **Stage 2** — Standalone `sdk/` library + IPC protocol + test harness. DONE.
- [x] **Stage 3** — `ScriptManager` controller + script-owned thread spawning. DONE.
- [x] **Stage 3.5** — SDK shim + built-in authoring skill. DONE.
- [x] **Stage 4** — Scripts section in the thread overview. DONE.
- [x] **Stage 4.5** — Script invocation as permission root (sandbox state + expand/collapse + pending permissions). DONE.
- [x] **Stage 5** — Expose scripts to agents via a `run_script` tool. DONE.
- [x] **Stage 6** — Full end-to-end test. DONE.

Per-stage status notes and any deviations are recorded inline under each stage's heading below. The full test suite has known pre-existing failures (≈17, e.g. `node/tools/spawn-subagents.test.ts` display-buffer assertions, some `thread.test.ts` snapshots, `completions.test.ts` timeouts) that reproduce on clean `main` and are unrelated to this work.

# Objective and Context

## Original request (verbatim)

> I want to create support for being able to invoke an agent from a script via a thread() function.
>
> This function should take 3 parameters:
>
> - the prompt
> - a schema documenting the desired yield type
> - an optional options param documenting the type of model we want to invoke, settings on that model, available tools, cwd, and other things (we will extend this later)
>
> The underlying mechanism is that this script will run inside a magenta / neovim session. When the thread function is triggered, it will create a thread - visible in magenta and interactive in the same way as any other thread. The thread will run with the prompt. The thread will be spawened with a yield_to_parent tool that matches the schema provided in the yield type. So when the agent is done, it will yield back to the script.
>
> I think there should be 2 interfaces for the script:
>
> 1. lua, through the magenta plugin command api. [...]
> 2. typescript. the magenta node process spawns a subprocess that runs a typescript script. The script has a small shell magenta sdk library that assumes it's running as a subprocess and uses ipc to invoke the agent command. The magenta node process monitors the ipc sockets and is able to receive the thread parameters, and send the results back. This means we need to write a small typescript lib that users can use to create these scripts (which are intended to run as subprocesses).
>
> I think beyond the agent() function we'll create a more rich communication mechanism so the script can drive the magenta ui better:
>
> On the magenta side, these scripts are placed in a `.magenta/scripts` directory and discovered. The sdk provides a registerScript function:
>
> ```
> function registerScript('name', 'description', parameterSchema, async runner(parameters, thread, log) => Promse<void>): void
> ```
>
> This exposes the script by name/description/parameterSchema to agents running in magenta, so they can trigger them. Once triggered, they live outside of the lifecycle of the thread that triggered them.
>
> When a script is invoked, it establishes a communication with magenta, and gives the inner runner access to the parameters, thread & report functions. When executed, on the magenta side, this makes the script show up in the thread overview, under a new scripts section. Threads and logs spawned by the script end up showing up in that section.
>
> log just allows the script to report on its progress, as threads run. This shows up within the script section.

## Scope adjustment (from follow-up)

Drop the lua interface entirely for now. Build **only the TypeScript subprocess pathway**.

## What we're building

A `@magenta/sdk` library plus a magenta-side `ScriptManager` that lets users author TypeScript scripts (placed in `.magenta/scripts/`) which run as child processes of the magenta node process. Inside a script, an author calls `registerScript(name, description, parameterSchema, runner)`. The `runner` receives `(parameters, thread, log)` where:

- `thread(prompt, yieldSchema, options?)` spawns a real, sidebar-visible magenta thread seeded with `prompt`, equips it with a `yield_to_parent` tool whose `input_schema` is `yieldSchema`, and resolves to the structured value the agent yields (typed by a TS generic).
- `log(message)` reports progress, surfaced in the magenta UI.

Scripts are discovered and exposed to in-magenta agents (by name/description/parameterSchema) via a new tool, so an agent can trigger a script. A triggered script runs **outside** the lifecycle of the thread that triggered it. Running scripts, their logs, and the threads they spawn appear in a new **scripts** section of the thread overview.

## Key entities and how they relate

- **`@magenta/sdk`** (new **standalone top-level directory**, `sdk/`, at the repo root — NOT a `node/` workspace) — the only thing user scripts import. It is fully self-contained: no imports from `node/core` or the root project, no build step, no separate `npm install`. It contains `registerScript`, the `thread` / `log` functions, the `ThreadFn` / `LogFn` / `ThreadOptions` types, the IPC protocol types, the child-side IPC client, JSON-schema-driven typing helpers, **and a testing harness** (`sdk/testing.ts`) script authors import to unit-test their runners in-process — no subprocess, no magenta. See "SDK module structure & test harness" below.
 Assumes it runs as a child process with an IPC channel to its parent. The root project imports the shared protocol types FROM `sdk/` (one-directional dependency), but `sdk/` imports nothing back. See "Distribution" below.
- **IPC protocol** (shared types, see below) — discriminated-union messages exchanged over the child-process IPC channel between the SDK (child) and `ScriptManager` (parent).
- **`ScriptManager`** (new root-layer controller, `node/scripts/script-manager.ts`) — discovers scripts, forks subprocesses, brokers IPC, owns the `scripts` UI section, and translates `invoke-thread` IPC into thread spawns via `Chat`.
- **`Chat`** (`node/chat/chat.ts`) — gains the ability to spawn a top-level, script-owned thread (no parent *thread*; the script is the logical parent) and to attach a custom yield schema.
- **`ThreadCore`** (`node/core/src/thread-core.ts`) + **`yield-to-parent.ts`** (`node/core/src/tools/`) — generalized so a thread can carry a custom yield JSON schema and yield a structured (JSON) value rather than only a bare string.
- **`RootMsg` / dispatch** (`node/root-msg.ts`, `node/magenta.ts`) — gains a `script-msg` variant routed to `ScriptManager`.

## Relevant files

- `node/chat/chat.ts` — thread creation/spawn (`createThreadWithContext`, `spawnThread`, `getThreadResult`, `onThreadYielded`, yield-callback machinery). Will host script-thread spawning.
- `node/core/src/capabilities/thread-manager.ts` — `ThreadManager` interface; extend for script threads + yield schema.
- `node/core/src/tools/yield-to-parent.ts` — fixed `{result: string}` tool; generalize to a schema-driven spec + structured value.
- `node/core/src/thread-core.ts` — yield detection (`maybeAutoRespond`, ~930-957), `yielded` mode (`response: string`), `getToolSpecs`.
- `node/core/src/chat-types.ts` — `ThreadType`, `SubagentConfig`.
- `node/core/src/tools/tool-registry.ts` / `toolManager.ts` — tool gating by thread type/capabilities.
- `node/magenta.ts` — central `dispatch`, controller wiring, `command()`, startup.
- `node/root-msg.ts` — root message union.
- `node/chat/thread-view.ts` / overview rendering — where the scripts section will render.
- `package.json` (root) — script runner is `node --experimental-transform-types` (already used by the `start` script). The SDK lives in standalone `sdk/`, NOT added to `workspaces`.
- `sdk/` (new, repo root) — standalone, dependency-free script-side library shipped with the plugin; imported by user scripts from the installed plugin location.
- `skills/` (new, repo root) + default `skillsPaths` (`node/options.ts:1044`) — a built-in skill teaching agents how to author scripts; the plugin's own skills dir is added to the default `skillsPaths`.
- `node/options.ts` (~line 10, `__dirname`; ~line 1044, default `skillsPaths`) — derives the plugin install dir and seeds default skill paths.

# Design

## Runner and process model

User scripts are TypeScript. Node runs TypeScript natively (the project already does this — see the root `start` script `node --experimental-transform-types node/index.ts`), so `ScriptManager` launches a script with `child_process.spawn(process.execPath, ["--experimental-transform-types", scriptPath], { stdio: ["inherit","inherit","inherit","ipc"] })`, giving a Node IPC channel (`child.send` / `child.on("message")`, and `process.send` / `process.on("message")` inside the SDK). Using the IPC stdio channel (rather than a hand-rolled unix socket) keeps message framing and lifecycle handling to Node. (No `tsx` runner is needed.)

Two distinct moments:

1. **Discovery / registration.** At startup (and/or on demand) each `.magenta/scripts/*.ts` is run once in a short-lived "registration" mode. The SDK collects all `registerScript(...)` calls, emits a single `register` IPC message listing `{name, description, parameterSchema}` for each, then the process can exit (it does no work until invoked). `ScriptManager` records the catalog (name → script file + metadata).
2. **Invocation.** When a script is invoked (by an in-magenta agent via the new tool), `ScriptManager` forks the script's file again in "run" mode, sends an `invoke` message `{scriptName, parameters}`, and the SDK calls the matching `runner(parameters, thread, log)`.

(For the first cut, registration can simply be "fork, capture `register`, keep the child alive and reuse it for the subsequent invoke" — but separating discovery from invocation keeps the catalog available to agents before any invoke. The plan treats them as separate IPC phases; the implementer may collapse them if a single long-lived child per invocation is simpler.)
### Process lifecycle and cleanup

Each script subprocess is spawned `detached: true` so it becomes a **process-group leader** (matching `node/capabilities/sandbox-shell.ts`). This is important because a script's runner can transitively spawn its own children, and we want a single signal to clean up the whole tree. `ScriptManager` tracks every live `ChildProcess` and, on script completion, abort, or magenta shutdown, terminates the **process group** (not just the immediate child) reusing the existing helpers `terminateProcess` / `escalateToSigkill` from `node/capabilities/shell-utils.ts`: `process.kill(-pid, "SIGTERM")` first, then `escalateToSigkill` (SIGKILL on the group) after a short grace period if it hasn't exited. The spawn options combine `detached: true` with the IPC channel (`stdio: ["inherit","inherit","inherit","ipc"]`).

On `child.on("exit")`, `ScriptManager` rejects any outstanding `thread()` promises for that invocation and marks it done/error. On magenta teardown, `ScriptManager.terminateAll()` group-kills every tracked subprocess so no orphaned script (or its grandchildren) survives the root process.

## Distribution and authoring (skill)

The SDK is **not published to npm**. It ships inside the installed plugin tree as the standalone `sdk/` directory. User scripts (in a project's `.magenta/scripts/`) need a stable, statically-importable path to it — but the plugin's absolute install location varies per machine and plugin manager, and static `import` statements cannot read an env var.

Resolution: when `ScriptManager` discovers/prepares a project's `.magenta/scripts/`, it ensures a **stable shim** inside the project that points at the installed SDK. Two viable mechanisms; the plan recommends the symlink, falling back to the generated re-export when symlinks are unavailable:

- A symlink `.magenta/scripts/magenta-sdk` → `<plugin-install>/sdk`, so scripts do `import { registerScript } from "./magenta-sdk/index.ts"`.
- Or a generated `.magenta/scripts/magenta-sdk.ts` that re-exports from the absolute install path, so scripts do `import { registerScript } from "./magenta-sdk.ts"`.

The plugin install dir is derived the same way `node/options.ts` already does (`__dirname` of the running node process). `ScriptManager` writes/refreshes the shim on startup so the path the skill documents is always valid.

A **built-in skill** (`skills/authoring-scripts/skill.md`, shipped in the repo) teaches agents how to author scripts: where scripts live (`.magenta/scripts/*.ts`), the exact import path for the SDK (the stable shim above), the `registerScript(name, description, parameterSchema, runner)` contract, and the `thread(prompt, yieldSchema, options?)` / `log(message)` APIs with a minimal end-to-end example. The skill also documents the **test harness** (`sdk/testing.ts` — import via the same shim, e.g. `./magenta-sdk/testing.ts`) with a worked example of writing a test that drives a runner, asserts its `thread()` invocations, and feeds yields back — so the agent writes a test alongside each script it authors.
 The plugin's own `skills/` directory is added to the default `skillsPaths` in `node/options.ts` so the skill is always discoverable without user configuration.

## SDK module structure & test harness

`registerScript(name, description, parameterSchema, runner)` does only one thing: record `{ name, description, parameterSchema, runner }` into a module-level registry. It is deliberately decoupled from *how* the runner is driven. Two consumers drive the registry:

- **Production client** (`sdk/client.ts`, the default `index.ts` entry, auto-activated when run as a child process with an IPC channel) — on `invoke`, looks up the script and calls `runner(parameters, thread, log)` where `thread`/`log` are the IPC-backed implementations.
- **Test harness** (`sdk/testing.ts`) — invokes the same runner with **test-double** `thread`/`log`, giving the script author full control over agent invocations and yields, entirely in-process.

The runner already receives `thread` and `log` as arguments (per the requested API), which is what makes both drivers possible without the runner knowing which context it runs in.

The test harness API (sketch):

- `runScript(script | scriptModulePath, scriptName, parameters)` → returns a `handle` and a `donePromise` (resolves when the runner returns, rejects if it throws).
- `await handle.nextThread()` → resolves with the next pending `thread()` invocation, exposing `{ prompt, yieldSchema, options }` and control methods `yield(value)` / `reject(error)` that settle that specific `thread()` call. This lets the test inspect each agent invocation and feed back arbitrary yields as the script runs (including multiple sequential or concurrent `thread()` calls, correlated like the real `requestId` mechanism).
- `handle.logs` → captured `log()` messages.

This harness is the *author-side* counterpart to the magenta-side e2e test: it verifies a script's own control flow (what prompts/schemas it sends, how it reacts to particular yields) without needing a neovim/magenta process at all.

## IPC protocol (shared discriminated union)

Define once in `sdk/protocol.ts`. The root project imports these types from `sdk/` directly (relative import from the install tree); the SDK never imports the root. All payloads are JSON-serializable (IPC uses structured clone, but keep to JSON to stay schema-friendly).

Child → parent:
- `{ type: "register", scripts: Array<{name, description, parameterSchema: JSONSchema}> }`
- `{ type: "invoke-thread", requestId, prompt, yieldSchema: JSONSchema, options?: ThreadOptions }`
- `{ type: "log", message: string }`
- `{ type: "done" }` / `{ type: "error", message }` — runner finished / threw.

Parent → child:
- `{ type: "invoke", scriptName, parameters }`
- `{ type: "thread-result", requestId, result: Result<unknown> }` — resolves the `thread()` promise; `value` is the parsed structured yield.

`requestId` correlates concurrent `thread()` calls from one runner.

## The `thread()` function and custom yield schema

`thread<T>(prompt, yieldSchema, options?) => Promise<T>`:

- SDK serializes the call into `invoke-thread` and returns a promise keyed by `requestId`.
- `ScriptManager` receives it and asks `Chat` to spawn a **script-owned thread**: a top-level thread (sidebar-visible, interactive) whose logical owner is the script invocation rather than another thread.
- The thread is equipped with a `yield_to_parent` tool whose `input_schema` is the provided `yieldSchema`. The plan generalizes `yield-to-parent.ts` from a hard-coded `{result: string}` into `getSpec(yieldSchema)`; when no schema is supplied it falls back to today's `{result: string}` shape (preserving existing subagent behavior).
- When the agent calls `yield_to_parent`, the **entire validated input object** becomes the structured yield value. To avoid threading a new structured type through `getThreadResult` (today typed `Result<string>`), the yielded value is `JSON.stringify`'d into the existing string `response`/result channel; `ScriptManager` JSON-parses it back into an object before sending `thread-result`. The SDK returns it as `T` (the generic is advisory typing only; runtime validation against `yieldSchema` is a later enhancement).
- `ScriptManager` registers an `onThreadYielded` callback (existing mechanism) and, on yield, reads `getThreadResult(threadId)` and replies with `thread-result`.

`ThreadOptions` (first cut) carries: model/profile selection, model settings (thinking/effort), available tools, and `cwd`. Designed to be extended later; unknown/omitted fields fall back to the active profile and magenta cwd.

## Spawning a script-owned top-level thread

`Chat.spawnThread` today requires an initialized **parent thread** (it derives profile, cwd, and environment from it, and sets `parent` for depth/nesting). A script has no parent thread. Introduce a sibling path — e.g. `Chat.spawnScriptThread({ scriptInvocationId, prompt, yieldSchema, options })` — that:

- resolves profile from `options` or `getActiveProfile(...)` (as `createNewThread` does),
- resolves cwd from `options.cwd` or `this.context.cwd`,
- calls `createThreadWithContext` with `threadType: "subagent"` semantics (so it gets `yield_to_parent` + `SubagentSupervisor` and lands in `yielded` mode) but with **no `parent`** thread id, plus the new `yieldSchema` plumbed through to `ThreadCore` → `getToolSpecs`,
- tags the thread with its owning `scriptInvocationId` so the overview can nest it under the scripts section.

Open question for the implementer: whether to add a dedicated `threadType: "script"` rather than reusing `"subagent"`. Reusing `"subagent"` minimizes changes to yield handling and tool gating; a new type is cleaner for UI/overview logic. The plan recommends **reusing `"subagent"` + a `scriptInvocationId` tag** to start.

## Permissions: the script invocation as a permission root

Today sandbox-bypass is a per-thread `sandboxBypassed` flag; `Thread.isSandboxBypassed` (node/chat/thread.ts) delegates up the `getParentThread` chain, the `toggle-sandbox-bypass` handler walks to the topmost ancestor and flips only its flag, and `createThreadWithContext` wires `bypassRef.get = () => thread.isSandboxBypassed` so the environment's shell/fileIO read live bypass state. The topmost thread is the de-facto permission root.

A script has no parent *Thread*, so we make **the script invocation itself the permission root** for every thread it spawns. The `ScriptInvocation` owns a single `sandboxBypassed` boolean. Threads spawned via `thread()` must resolve their bypass state from this invocation rather than from a parent Thread. Generalize the bypass resolution: alongside `getParentThread`, give a script-owned thread a `getSandboxRoot()` provider that returns the owning invocation's bypass accessor. `Thread.isSandboxBypassed` checks, in order: a sandbox-root provider (if set) → parent thread chain → own flag. Toggling sandbox on any thread in the script subtree (or on the script root in the overview) flips the **invocation's** flag, and all spawned threads see it live through their `bypassRef`.

Inheritance on trigger: when a script is invoked via `run_script` from a thread, the triggering thread's `isSandboxBypassed` seeds the new invocation's `sandboxBypassed`. So a script launched from a sandbox-disabled thread starts disabled. (Scripts invoked without a triggering thread default to not-bypassed.) Note this is a snapshot at trigger time — the invocation is thereafter its own root and is toggled independently, consistent with how forks copy bypass state today.

Invariants:
- All threads under one script invocation share exactly one bypass flag (the invocation's); there is no per-thread divergence within a script.
- A `run_script` triggered from a bypassed thread yields a bypassed invocation; the snapshot is taken once at trigger time.
- `bypassRef` for each spawned thread reflects the invocation's current flag at execution time (live), so a mid-run toggle takes effect for subsequent tool calls.

## UI: scripts section

`ScriptManager` holds the list of script invocations, each with: script name, status (running/done/error), accumulated `log` lines, and the set of thread ids it spawned. The thread-overview view renders a new **Scripts** section listing active/recent invocations; under each, its log lines and links to its spawned threads (which remain fully interactive normal threads). Re-renders are driven the same way as everything else: `ScriptManager` dispatches a `script-msg` through the root `dispatch`, which triggers the active app render.

The script root row shows the invocation's **sandbox state** (e.g. a bypass/locked indicator) and carries the `toggle-sandbox-bypass` binding that flips the invocation flag. It is **expandable/collapsible** like a parent thread: reuse the existing overview machinery (`expandedThreads` set, `toggle-thread-expand`, `renderThreadSubtree`, indentation) keyed by the invocation id, so expanding reveals the script's spawned threads underneath. When running in sandbox mode, each child thread renders its **pending permissions** inline via the thread's `sandboxViolationHandler.view()`; when the script root is collapsed, surface pending permissions from the subtree using the same approach as `collectSubtreeViolationViews()` so the user is never blocked invisibly.

## Exposing scripts to agents

A new tool (e.g. `run_script`) whose dynamic `getSpec(scriptCatalog)` enumerates discovered scripts as an `enum` of names with their descriptions, and whose input is `{ scriptName, parameters }` validated against the chosen script's `parameterSchema`. Executing it asks `ScriptManager` to invoke the script. Per the request, the invoked script lives **outside** the triggering thread's lifecycle: the tool can return immediately (fire-and-forget) with an acknowledgement, OR optionally await a terminal `done`/`error`. First cut: fire-and-forget acknowledgement; the script's progress is observable in the scripts section.

## Invariants

- A script subprocess never has direct filesystem/neovim authority beyond what its spawned threads have; it only drives magenta through the IPC protocol.
- `thread()` promises are correlated strictly by `requestId`; multiple concurrent `thread()` calls from one runner must not cross-resolve.
- Generalizing `yield-to-parent` must preserve existing subagent behavior exactly when no custom schema is provided (default `{result: string}`).
- Script-owned threads are real threads: they appear in the sidebar, are interactive, and participate in the normal render/dispatch loop. They must not be garbage-collected while their owning script invocation is alive.
- A crashing/exiting subprocess must reject all its outstanding `thread()` promises and mark the invocation `error` without taking down magenta.
- Killing a script (on abort or magenta shutdown) must clean up the entire process tree: subprocesses are spawned `detached` and terminated by **process group** (`process.kill(-pid, ...)`), never leaving orphans.
- Yielded values round-trip through JSON without loss; non-JSON-serializable yields are a validation error surfaced to the script.

# End-to-end testing strategy

We already have everything needed for a true e2e test via `withDriver` (see the `doc-testing` skill). The key insight: **the mock provider is in-process and shared by the whole magenta process.** A script subprocess never talks to a provider itself — it only drives magenta over IPC — and the threads it spawns via `thread()` run inside the *test* magenta process, so they hit `driver.mockAnthropic` exactly like any normal thread. Nothing about the subprocess needs provider mocking.

The shim resolves naturally in tests: tests run from the repo root, so the install dir derived from `__dirname` is the repo, and the `.magenta/scripts/magenta-sdk` symlink points at the repo's real `sdk/`. The subprocess imports the real SDK and runs real IPC against the test `ScriptManager`.

Shape of the full e2e flow (one test):

1. `setupFiles` writes `.magenta/scripts/foo.ts`: it `registerScript("foo", ..., paramSchema, async (params, thread, log) => { log("starting"); const r = await thread(\`work on ${params.x}\`, yieldSchema); /* assert/use r */ })` importing from `./magenta-sdk/index.ts`.
2. `withDriver` starts magenta; `ScriptManager` discovers `foo`, creates the symlink shim, and the script appears in the catalog (so the `run_script` tool spec enumerates it).
3. Drive a normal chat thread: `driver.inputMagentaText(...)`, `driver.send()`; the mock agent responds with a `run_script` tool call `{ scriptName: "foo", parameters: { x: "..." } }`.
4. `ScriptManager` forks the subprocess and sends `invoke`; the runner calls `log()` then `thread()`. The `invoke-thread` IPC causes a real script-owned thread to spawn — which produces a **new pending stream** on `driver.mockAnthropic`.
5. The test disambiguates streams by prompt text (`awaitPendingStreamWithText("work on ...")`) and responds with a `yield_to_parent` tool call whose input matches `yieldSchema`.
6. The thread enters `yielded`; `ScriptManager` sends `thread-result`; the runner's `thread()` promise resolves; the runner finishes and the subprocess exits with `done`.
7. Assertions: the Scripts section shows the invocation + its `log` line + a link to the spawned (now-yielded) thread; the spawned thread is real and navigable in the UI; the invocation is marked done.

Driver/test helpers likely needed (add to `NvimDriver`): wait for a script invocation by name to reach a given state, read the Scripts section of the overview, and assert spawned-thread linkage. Subprocess teardown (group-kill) is asserted by the Stage 3 cleanup test rather than re-checked here.

# Stages

## Stage 1 — Generalize `yield_to_parent` to a schema-driven, structured yield

**STATUS: DONE.** Added `getSpec(yieldSchema?)` to `yield-to-parent.ts` (default `{result}` schema preserved); generalized `Input` to allow extra keys; loosened `validateInput` to only reject a non-string `result` key. `toolManager.getToolSpecs` gained a `yieldSchema?` param routing to `YieldToParent.getSpec`. `ThreadCoreContext` gained `yieldSchema?`; `maybeAutoRespond` JSON-stringifies the full yield input when a schema is set, else uses `input.result` (byte-for-byte unchanged default). Added a core unit test for structured yield.

- Goal: a thread can be created with an optional custom yield JSON schema; `yield_to_parent`'s spec reflects it; the yielded value is the full structured input, carried as JSON through the existing `Result<string>` channel. With no schema, behavior is byte-for-byte unchanged.
- Touch: `node/core/src/tools/yield-to-parent.ts` (add `getSpec(yieldSchema?)`, generalize `validateInput`/`Input`/structured value), `thread-core.ts` (carry optional `yieldSchema`, pass to `getToolSpecs`; in `maybeAutoRespond` encode structured input as JSON for the `yielded` response), `toolManager.ts`/`tool-registry.ts` (route the dynamic spec).
- Verification:
  - Behavior: default subagent with no custom schema yields a plain string exactly as today.
    - Setup: existing subagent spawn test harness (`node/core/` unit tests).
    - Actions: spawn a subagent, have the mock agent call `yield_to_parent` with `{result: "x"}`.
    - Expected: `getThreadResult` → `{status:"done", result:{status:"ok", value:"x"}}` (unchanged).
  - Behavior: a thread created with a custom object schema yields a structured value.
    - Setup: unit test creating a thread with `yieldSchema = {type:"object", properties:{count:{type:"number"}}, required:["count"]}`.
    - Actions: mock agent calls `yield_to_parent` with `{count: 3}`.
    - Expected: yielded result decodes (via JSON.parse) to `{count: 3}`.
- Before moving on: full test suite, `npx tsgo -b`, and `npx biome check .` pass.

## Stage 2 — standalone `sdk/` library + IPC protocol + a manual round-trip harness

**STATUS: DONE.** Created standalone `sdk/` (no workspace, no build, zero deps): `protocol.ts` (defines local `JSONSchema = Record<string, unknown>` to avoid a third-party dep, plus `Result`, `ThreadOptions`, `ScriptMeta`, `ChildToParent`/`ParentToChild` unions), `registry.ts` (module-level `registerScript`/`getRegistry`/`clearRegistry`, `LogFn`/`ThreadFn`/`Runner` types), `client.ts` (IPC child client, `invokeThread` keyed by `requestId`), `index.ts` (re-exports + auto-`activate()`), `testing.ts` (`runScript` in-process harness with `nextThread()`/`yield`/`reject`/`logs`). Tests + fixtures under `sdk/test/`.

**DECISIONS/DEVIATIONS:**
- Activation gating: a vitest worker also has an IPC channel, so `process.send` existence alone is insufficient. The client only activates when **`process.env.MAGENTA_SDK_CHILD === "1"`** AND `process.send` exists. **ScriptManager (Stage 3) MUST set `MAGENTA_SDK_CHILD=1` in the spawned child's env.**
- `runScript(scriptName, parameters)` (dropped the `script | scriptModulePath` arg form): dynamic `import()` is forbidden, so the test author statically imports their script module first (populating the registry), then calls `runScript` by name.
- Root tsconfig `include` gained `sdk/**/*` so `tsgo -b` checks the SDK; `sdk/` imports nothing back.

- Goal: a new standalone top-level `sdk/` directory (NOT a workspace, no build step, zero external deps) exporting `registerScript`, `thread`, `log`, the protocol types, and the child-side IPC client. A throwaway/integration harness can fork a sample script via `node --experimental-transform-types` and exercise `register` + `invoke` + `log` + a stubbed `thread()` round-trip without touching `Chat`.
- Touch: `sdk/{index,protocol,client}.ts`; ensure the root project type-checks when importing protocol types from `sdk/` (the core→root boundary is unaffected; `sdk/` must not import `node/core`, the root, or any third-party package).
- Verification:
  - Behavior: SDK registers scripts and reports them over IPC.
    - Setup: a fixture script calling `registerScript` twice; a test that forks it with an IPC channel.
    - Actions: read the `register` message.
    - Expected: catalog lists both scripts with descriptions + parameterSchema.
  - Behavior: a runner's `thread()`/`log()` produce correct IPC and resolve on a faked `thread-result`.
    - Setup: fixture script whose runner calls `log("hi")` then `await thread("p", schema)`; test acts as the parent, replying with a `thread-result`.
    - Actions: send `invoke`, observe `log` + `invoke-thread`, reply `thread-result`, observe `done`.
    - Expected: ordering and `requestId` correlation correct; promise resolves with the replied value.
  - Behavior: the test harness drives a runner in-process, exposes its `thread()` invocations, and feeds yields back.
    - Setup: a fixture script registering a runner that awaits two sequential `thread()` calls and uses the first yield to build the second prompt; load it via the harness.
    - Actions: `runScript`; `await handle.nextThread()`, assert prompt/schema, `yield(...)`; repeat for the second.
    - Expected: second prompt reflects the first yield; `donePromise` resolves; `handle.logs` captured. No subprocess or magenta involved.
- Before moving on: full test suite, `npx tsgo -b`, and `npx biome check .` pass.

## Stage 3 — `ScriptManager` controller + script-owned thread spawning

**STATUS: DONE.** `node/scripts/script-manager.ts` (new) holds `ScriptManager` + `ScriptInvocation` (each with its own `sandboxBypassed` flag, `logs`, `threadIds`, `pendingThreads`, `child`). It discovers `.magenta/scripts/*.ts` (forks each once to capture the `register` catalog, then kills it), forks per-invocation with `MAGENTA_SDK_CHILD=1` + `detached`, waits for the child's `register` before sending `invoke`, and on `invoke-thread` calls `Chat.spawnScriptThread`, registers `onThreadYielded`, and replies `thread-result` (JSON-parsing the yielded string back to a structured value). Group-kills via `terminateProcess`/`escalateToSigkill`. Wired into `node/magenta.ts` (constructed after `chat`, `discover()` at startup, routed via `scriptManager.update`, `terminateAll()` in `destroy()`), `node/root-msg.ts` (`ScriptMsg`). `Chat.spawnScriptThread` creates a `threadType: "subagent"` thread with no parent, a `yieldSchema`, a `getSandboxRoot` provider, and a `scriptInvocationId` tag (preserved across wrapper state transitions). `Thread.isSandboxBypassed` now consults `getSandboxRoot` before the parent chain. Integration tests cover the happy path, runner crash → `error`, and group-kill of the subprocess tree.

**DECISIONS/DEVIATIONS:**
- `ScriptInvocationId` is defined in `script-manager.ts`; `chat.ts` type-imports it.
- Tests create the SDK shim symlink manually in `setupFiles` (the auto-shim is Stage 3.5).

- Goal: `ScriptManager` is wired into `dispatch` (new `script-msg` in `RootMsg`); it discovers `.magenta/scripts/*.ts`, forks them, brokers IPC, and on `invoke-thread` spawns a real, sidebar-visible script-owned thread via a new `Chat.spawnScriptThread`, returning the structured yield as `thread-result`.
- Touch: `node/scripts/script-manager.ts` (new, holds `ScriptInvocation` with its own `sandboxBypassed` flag), `node/root-msg.ts`, `node/magenta.ts` (construct + route + render), `node/chat/chat.ts` (`spawnScriptThread`, thread tagged with `scriptInvocationId`, no parent thread, wired with a `getSandboxRoot()` provider so its `bypassRef` reads the invocation's flag), `node/chat/thread.ts` (generalize `isSandboxBypassed` to consult the sandbox-root provider before the parent chain), `thread-manager.ts` (extend interface if needed for the yield-schema path).
- Verification (integration, `withDriver()`):
  - Behavior: invoking a script that calls `thread()` spawns a visible thread, drives it to yield, and the runner receives the structured result.
    - Setup: a fixture script under a temp `.magenta/scripts/`; mock provider replies on the spawned thread with a `yield_to_parent` call matching the schema.
    - Actions: trigger the script invocation; let the mock agent yield.
    - Expected: a new thread appears in the chat/overview; the script's `thread()` promise resolves to the structured value; invocation marked done.
  - Behavior: terminating an invocation group-kills the subprocess (and its children) via `terminateProcess`/`escalateToSigkill`.
    - Setup: fixture script that spawns a long-lived child of its own.
    - Actions: trigger, then abort the invocation (or tear down magenta).
    - Expected: both the script process and its child are gone (no orphan pids).
  - Behavior: subprocess crash rejects outstanding `thread()` and marks invocation `error`.
    - Setup: fixture script that throws after calling `thread()`.
    - Actions: trigger; let the mock agent never yield, runner throws.
    - Expected: invocation state `error`; magenta stays healthy.
- Before moving on: full test suite, `npx tsgo -b`, and `npx biome check .` pass.

## Stage 3.5 — SDK shim + built-in authoring skill

**STATUS: DONE.** `ScriptManager.ensureShim()` creates `.magenta/scripts/magenta-sdk` → `<install>/sdk` (symlink), falling back to a generated `magenta-sdk/index.ts` + `magenta-sdk/testing.ts` re-export directory; both expose the same `./magenta-sdk/index.ts` import path. Called from `discover()` before forking (so discovery scripts can import the shim). Install dir derived via `fileURLToPath(import.meta.url)` in `script-manager.ts` (`../../sdk`). New built-in skill `skills/authoring-scripts/skill.md` documents script location, the SDK import path, the `registerScript`/`thread`/`log` contract, and the `sdk/testing.ts` harness with a worked example. `node/options.ts` exports `BUILTIN_SKILLS_PATH` (`<install>/skills`) and adds it to default `skillsPaths`.

**DECISIONS/DEVIATIONS:**
- The test sandbox's `fileIO` cannot read outside the temp cwd, so the skill-discovery verification is a unit test calling `loadSkills` with a real `FsFileIO` + `[BUILTIN_SKILLS_PATH]` (rather than via `withDriver`).
- The Stage 3 integration tests now rely on `ensureShim` (no manual symlink), exercising the shim end-to-end.

- Goal: a project's `.magenta/scripts/` can statically import the SDK via a stable path regardless of plugin install location, and agents have a discoverable skill describing how to author scripts.
- Touch: `ScriptManager` ensures the shim (symlink `.magenta/scripts/magenta-sdk` → `<install>/sdk`, with a generated re-export `.magenta/scripts/magenta-sdk.ts` fallback); plugin install dir derived via `__dirname` (as `node/options.ts` does); new built-in skill `skills/authoring-scripts/skill.md`; add the plugin's `skills/` dir to default `skillsPaths` in `node/options.ts`.
- Verification:
  - Behavior: shim resolves and a fixture script importing through it runs.
    - Setup: temp project with empty `.magenta/scripts/`; start magenta.
    - Actions: confirm the shim exists and points at the install `sdk/`; drop a fixture script importing from the shim and invoke it.
    - Expected: shim present; script imports cleanly and registers.
  - Behavior: the built-in skill is discovered and documents the test harness.
    - Setup: default options.
    - Actions: load skills; render the skills introduction; read `skill.md`.
    - Expected: the authoring-scripts skill appears in `<available-skills>`; its body shows both the `registerScript`/`thread`/`log` authoring example and a `sdk/testing.ts` harness test example.
- Before moving on: full test suite, `npx tsgo -b`, and `npx biome check .` pass.

## Stage 4 — Scripts section in the thread overview

**STATUS: DONE.** `ScriptManager.view()` renders a `# Scripts` section: each invocation with a status icon (⏳/✅/❌) + name, its `log` lines, and `<CR>`-bindable links to spawned thread ids (dispatch `select-thread-effect`). Composed into the overview app in `node/magenta.ts` (`d\`${chat.renderThreadOverview()}${scriptManager.view()}\``). Re-renders flow through the normal `script-msg` dispatch → active-app render. Integration test asserts the section, a log line, and the spawned thread id appear in the overview buffer.

**NOTE:** Script-owned threads currently also still appear as root rows in `renderThreadOverview` (their `parentThreadId` is undefined). Nesting them under the script row is Stage 4.5 (expand/collapse keyed by invocation id).

- Goal: running/recent script invocations render in a new Scripts section with their log lines and links to spawned threads; updates re-render through the normal loop.
- Touch: overview rendering (`node/chat/thread-view.ts` or wherever the overview is composed) + `ScriptManager` view fragment; `script-msg` updates trigger render.
- Verification (integration, `withDriver()`):
  - Behavior: an active invocation and its logs show in the overview; spawned threads are reachable from it.
    - Setup: fixture script that logs then spawns a thread.
    - Actions: trigger; read overview buffer text.
    - Expected: Scripts section lists the invocation, shows logged lines, and references the spawned thread id.
- Before moving on: full test suite, `npx tsgo -b`, and `npx biome check .` pass.

## Stage 4.5 — Script invocation as permission root (sandbox state + expand/collapse + pending permissions)
**STATUS: DONE.** `ScriptInvocation` already owned a `sandboxBypassed` flag (Stage 3); Stage 4.5 made it the live permission root and surfaced it in the overview. `SandboxRoot` (`node/chat/thread.ts`) gained an optional `toggle?()`; `ScriptManager.getSandboxRoot` now returns a root whose `toggle()` flips the invocation flag (and re-renders), and `Thread`'s `toggle-sandbox-bypass` handler calls the sandbox-root `toggle()` (after walking to the topmost parent) when present, so toggling from any thread in a script subtree flips the invocation flag. `ScriptManager` gained `expandedInvocations` + two `script-msg` variants (`toggle-invocation-expand`, `toggle-invocation-sandbox`) handled in `update()`. `view()` now renders each script row with a sandbox indicator (🔓/🔒) + expand caret, bound to `=` (expand) and `t` (sandbox toggle); when expanded it nests the spawned threads via the new `Chat.renderScriptThreadSubtree`, and when collapsed it surfaces subtree pending permissions via the new `Chat.collectScriptSubtreeViolationViews`. `renderThreadOverview` now excludes script-owned threads (those with a `scriptInvocationId`) from the top-level list so they only appear nested under their script row. Integration tests cover sandbox toggle propagation, expand/collapse, and a collapsed-row pending-permission surface+approve.

**DECISIONS/DEVIATIONS:**
- Binding keys are limited to the `BINDING_KEYS` whitelist (`<CR>`, `t`, `dd`, `=`, `F`); reused `=` for expand and `t` for the sandbox toggle (no `<CR>` on the script row).
- The Stage 4 rendering test no longer asserts the raw spawned thread id (it isn't rendered as text); it now expands the collapsed row and asserts the nested thread's `yielded` status appears.

- Goal: the script invocation is the single permission root for all its spawned threads; its sandbox state shows on the script root row and is toggleable; the row expands to reveal child threads; in sandbox mode each child thread's pending permissions are actionable (and surfaced even when the root is collapsed).
- Touch: `ScriptInvocation` bypass flag + toggle handling routed through `script-msg`; overview rendering reuses `expandedThreads`/`toggle-thread-expand`/`renderThreadSubtree` keyed by invocation id; per-child `sandboxViolationHandler.view()` and a `collectSubtreeViolationViews()`-style collapse path.
- Verification (integration, `withDriver()`):
  - Behavior: toggling sandbox on the script root flips the flag for all spawned threads.
    - Setup: fixture script spawning two threads; start with sandbox enabled.
    - Actions: toggle bypass on the script root.
    - Expected: both spawned threads report `isSandboxBypassed === true` (one shared flag); the root row shows the bypassed indicator.
  - Behavior: expand/collapse reveals/hides child threads under the script root.
    - Setup: invocation with ≥1 spawned thread.
    - Actions: trigger `toggle-thread-expand` on the invocation.
    - Expected: child threads render indented under the root when expanded, hidden when collapsed.
  - Behavior: in sandbox mode, a child thread's pending permission renders and is approvable, including when the root is collapsed.
    - Setup: sandbox enabled; mock agent in a spawned thread triggers a sandbox violation.
    - Actions: read the overview; approve via the binding.
    - Expected: the pending-permission view appears under the child (and via the collapsed-subtree path); approving resolves it.
- Before moving on: full test suite, `npx tsgo -b`, and `npx biome check .` pass.

## Stage 5 — Expose scripts to agents via a `run_script` tool

- Goal: in-magenta agents can discover and trigger scripts; triggered scripts run outside the triggering thread's lifecycle.
- Touch: new tool `node/core/src/tools/run-script.ts` with dynamic `getSpec(catalog)`; gating in `tool-registry.ts`/`toolManager.ts`; `ScriptManager` exposes the catalog + an `invokeScript(name, parameters, { sandboxBypassed })` entry point; tool execute bridges to it (root side) — respect the core/root boundary (core defines the tool spec/validation; the actual invocation goes through a capability/`ScriptManager` injected like `threadManager`). The bridge passes the triggering thread's `isSandboxBypassed` so the new invocation's permission root is seeded from it.
- Verification:
  - Behavior: the tool spec enumerates discovered scripts and validates parameters against the chosen script's schema.
    - Setup: catalog with one script.
    - Actions: build spec; validate good and bad inputs.
    - Expected: enum contains the script; bad params rejected; good params accepted.
  - Behavior (integration): an agent calling `run_script` starts the script independently of its own thread.
    - Setup: fixture script; a thread whose mock agent calls `run_script`.
    - Actions: run the tool.
    - Expected: invocation appears in the Scripts section and proceeds even if the triggering thread ends.
  - Behavior: a script triggered from a sandbox-disabled thread starts bypassed.
    - Setup: a thread with sandbox bypass enabled; its mock agent calls `run_script`.
    - Actions: run the tool; inspect the new invocation.
    - Expected: the invocation's `sandboxBypassed` is true (snapshot at trigger time).
- Before moving on: full test suite, `npx tsgo -b`, and `npx biome check .` pass.

## Stage 6 — Full end-to-end test
**STATUS: DONE.** `node/scripts/script-e2e.test.ts` drives the full flow: catalog detection → agent invokes `run_script` → subprocess runs → `thread()` spawns a real thread hitting the mock provider → schema-matching `yield_to_parent` → runner completes → Scripts overview shows the invocation, its log line, and (on expand) the yielded spawned thread.

- Goal: a single `withDriver` test exercises detect → agent invokes via `run_script` → subprocess runs → `thread()` spawns a real thread that hits the mock provider → yields structured result → runner completes → UI reflects it. This is the capstone proving all layers compose.
- Touch: a new integration test (e.g. `node/scripts/script-e2e.test.ts`) and any `NvimDriver` helpers it needs.
- Verification: implements the 7-step flow in "End-to-end testing strategy" above.
  - Behavior: end-to-end script invocation returns a structured yield and surfaces in the Scripts section.
  - Setup: `setupFiles` writes a fixture `.magenta/scripts/foo.ts` importing from the `./magenta-sdk` shim and registering a `foo` script whose runner logs then awaits one `thread()`.
  - Actions: drive a chat thread whose mock agent calls `run_script`; respond to the spawned script-thread's stream with a schema-matching `yield_to_parent`.
  - Expected: runner's `thread()` resolves to the structured value; invocation marked done; Scripts section shows the invocation, its log line, and a link to the (yielded) spawned thread.
- Before moving on: full test suite, `npx tsgo -b`, and `npx biome check .` pass.

# Deferred / open questions

- Runtime validation of yielded values and `parameters` against their JSON schemas (Stage 1/5 do structural validation; deep schema validation can come later — no schema-validation lib is currently a dependency).
- Whether to introduce a dedicated `threadType: "script"` vs. reusing `"subagent"` (recommended: reuse + tag).
- Long-lived vs. per-invocation subprocess lifecycle (registration phase vs. run phase) — collapse if a single child per invocation proves simpler.
- The lua command-API interface (explicitly out of scope for now).
