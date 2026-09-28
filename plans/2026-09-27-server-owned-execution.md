# Objective and Context

"we've been working towards splitting magenta into a server-client architecture. We did 1 so far. Take a look at the current state of the code and let's take a look at doing 2. All fs interactions should be moved to the server."

This is stage 2 of `plans/2026-09-16-client-server-protocol.md`: "Make execution independent of Neovim. Move filesystem/shell execution, configuration, approval state, and agent cwd into server-owned services. Isolate editor-dependent functionality behind explicit optional capabilities. A session should keep running with no attached editor."

Key entities:

- `Session` (`node/server/src/session.ts`) owns the thread registry and delegates per-thread collaborator construction to a `SessionHost`.
- `NvimSessionHost` (`node/nvimclient/chat/session-host.ts`) is currently the only host. It builds environments, the system prompt/info, auto context, hierarchy discovery, the submission resolver, agents, MCP and providers, and it holds approval/bypass state. Most of this has no editor dependency.
- `Environment` (`node/nvimclient/environment.ts`) bundles `fileIO`, `shell`, `gitClient`, `sandboxViolationHandler`, `lspClient`, `luaExecutor`, `cwd`, `homeDir`, `availableCapabilities` and `environmentConfig`.
- `SandboxViolationHandler` (`node/nvimclient/capabilities/sandbox-violation-handler.ts`) holds pending write/shell/network approvals and also renders them (`view()`, which imports `tea/view.ts`).
- `Sandbox` (`node/nvimclient/sandbox-manager.ts`) is a process-global sandbox-runtime wrapper, initialized in `magenta.ts` with the options' sandbox config.
- `CommandRegistry` (`node/nvimclient/chat/commands/`) expands `@file:`, `@diff`, `@staged`, `@compact`, `@implementplan` (fs/git) and `@buf`, `@qf`, `@diag` (editor state) when a submission is delivered.
- `DynamicOptionsLoader` / `loadUserSettings` / `loadProjectSettings` (`node/nvimclient/options-loader.ts`, `options.ts`) read `~/.magenta/options.json` and `<cwd>/.magenta/options.json` and merge them over the lua-supplied options.

Relevant files:

- `node/nvimclient/capabilities/sandbox-file-io.ts`: sandbox-checked FileIO (only uses `nvim.logger`).
- `node/nvimclient/capabilities/sandbox-shell.ts`, `shell-utils.ts`, `strace.ts`: sandboxed local shell.
- `node/nvimclient/capabilities/docker-file-io.ts`, `docker-shell.ts`: docker environment.
- `node/nvimclient/capabilities/git-client.ts`: local/docker git clients.
- `node/nvimclient/capabilities/lsp-client-adapter.ts`, `nvim-lua-executor.ts`, `noop-lsp-client.ts`: editor-backed capabilities (stay in the client).
- `node/nvimclient/capabilities/render-pending-approvals.ts`, `chat/chat.ts`, `chat/thread-view.ts`, `chat/thread.ts`: read `sandboxViolationHandler` for rendering and approval actions.
- `node/nvimclient/auth/anthropic.ts`: OAuth token store on disk.
- `node/nvimclient/providers/`: provider construction (`getProvider(nvim, profile)`).
- `node/nvimclient/utils/pdf.ts`: PDF reading for file context.
- `node/nvimclient/magenta.ts`: constructs options loader, sandbox, host, session.
- `node/server/src/capabilities/`: server capability interfaces (`FileIO`, `Shell`, `GitClient`, `LspClient`, `LuaExecutor`, ...).

# Design

The server gets a `ServerSessionHost` that owns everything the current host does except editor collaborators. The client attaches an optional `EditorCapabilities` to the session. When no editor is attached, new threads get no `lsp`/`nvim` tools and the resolver skips editor commands. Execution, approvals and config reads happen in the server even while it still runs in-process. The stage 3 API boundary then only has to serialize state that already lives on the server.

Approvals become server state: `SandboxViolationHandler` loses `view()` and becomes a plain store with approve/reject by id. The session exposes the pending set per thread and emits `changed` when it changes. The client renders it (`render-pending-approvals.ts` gains the view function) and calls session operations to approve or reject. Bypass state (`bypassed`, `sandboxRoots`) moves onto the session, since it is keyed by root ancestor, which the session already computes.

Submission resolution is split by who owns the data. The client expands commands that read editor state (`@buf`, `@buffers`, `@qf`, `@quickfix`, `@diag`, `@diagnostics`) into text before submitting, and makes `@file:` paths absolute against its own cwd. The server resolver handles everything that touches fs or git (`@file:` type detection and context tracking, `@diff`, `@staged`, `@implementplan`, `@compact`, custom commands). The raw message still crosses as `PendingMessage`, and the server resolves it at delivery time exactly as today.

Configuration is server-owned: the server reads its options only from JSON files (`~/.magenta/options.json`, plus project `<cwd>/.magenta/options.json`), so a server started without Neovim is fully configured. The lua `setup()` options stop configuring server behavior (profiles, sandbox, MCP, agents, auto context, compaction, ...). Lua keeps only client/editor options (keymaps, sidebar layout, display). The server owns reading and watching the files and the merge, and exposes `getOptions()`. It also owns sandbox initialization and config refresh.

Working directories are split by type. `NvimCwd` stays in the client: it is Neovim's cwd, used to resolve client-selected paths into absolute ones and to shorten displayed paths. The server gets a new `Cwd` brand (`AbsFilePath & { __cwd: true }`). It is the directory a thread's environment operates in, fixed at thread creation (from `EnvironmentConfig` or the server's configured default) and immutable. There is no API or tool to change it; `change_directory` is a later, separate plan. Every server use of `NvimCwd` (22 files, including `utils/files.ts` path helpers, `ThreadCoreContext.cwd`, `EnvironmentConfig.cwd`) becomes `Cwd`. Path helpers that both sides need take a plain `AbsFilePath` base. The only conversion point is the client choosing the initial cwd of a thread it creates, which is an explicit `Cwd` in the create options.

Unsaved editor buffers are never sent to the server. The server only sees what is on disk; the client keeps reloading buffers when files change.

Auth, providers and pdf reading move as-is; the only change is replacing `Nvim` parameters with a `Logger`.

## Interfaces

```ts
// node/server/src/capabilities/editor.ts
export interface EditorCapabilities {
  neovimVersion: string;
  /** Per-thread, since LSP paths are resolved against the thread cwd. */
  createLspClient(cwd: NvimCwd, homeDir: HomeDir): LspClient;
  luaExecutor: LuaExecutor;
}

// node/server/src/environment.ts (moved)
export interface Environment {
  fileIO: FileIO;
  shell: Shell;
  gitClient: GitClient;
  approvals?: ApprovalStore; // renamed SandboxViolationHandler, no view()
  lspClient: LspClient; // NoopLspClient when no editor
  luaExecutor?: LuaExecutor;
  cwd: NvimCwd;
  homeDir: HomeDir;
  availableCapabilities: Set<ToolCapability>;
  environmentConfig: EnvironmentConfig;
}

// Session additions
class Session {
  attachEditor(editor: EditorCapabilities): void;
  detachEditor(): void;
  getPendingApprovals(id: ThreadId): ReadonlyMap<string, PendingViolation>;
  approve(id: ThreadId, approvalId: string): void;
  reject(id: ThreadId, approvalId: string): void;
  approveAll(id: ThreadId): void;
  isSandboxBypassed(id: ThreadId): boolean;
  toggleSandboxBypass(id: ThreadId): void;
  registerSandboxRoot(id: ThreadId, get: () => SandboxRoot | undefined): void;
}

// node/server/src/config/options-store.ts
export class OptionsStore {
  constructor(homeDir: HomeDir, logger: Logger);
  /** ~/.magenta/options.json merged with <cwd>/.magenta/options.json; re-reads on mtime change. */
  getOptions(cwd: Cwd): ServerOptions;
}

// node/server/src/utils/files.ts
export type Cwd = AbsFilePath & { __cwd: true };
// NvimCwd moves to node/nvimclient/utils/files.ts

// node/server/src/submission/commands/types.ts
export interface MessageContext {
  cwd: NvimCwd;
  homeDir: HomeDir;
  fileSupervisor: ContextFileAccess;
  options: MagentaOptions;
  logger: Logger;
}
```

`MagentaOptions` is split: `ServerOptions` (everything the server consumes) and its parsers (`parseOptions`, `parseProjectOptions`, `mergeOptions`) move to the server. The client keeps `ClientOptions`, which are parsed from lua `setup()`. `MessageContext.options` and the other server fields use `ServerOptions`, and every `cwd` in the server interfaces above is `Cwd`.

## Invariants

- `nvimclient` imports neither `node:fs` nor `node:child_process` outside an explicit allowlist. The allowlist covers `open-target-under-cursor.ts` (opening files in the editor), the `LOGO` read in `thread-view.ts`, and lua bridge boot. A test enforces this, like `abort-listeners.test.ts`.
- Server code never imports from `nvimclient` (already enforced by project references).
- Detaching the editor must not abort, fail or pause any running thread. Pending approvals stay pending and are visible to the next attached client.
- Threads created before an editor attaches keep their capability set. Attaching later does not retroactively add `lsp`/`nvim` tools, because the tool specs are fixed per core.
- Auto context and hierarchy discovery still use the host filesystem, never a thread's sandboxed/docker `fileIO`.
- Forks keep inheriting the source's bypass state, system prompt and system info.
- The sandbox stays process-global; per-command network-ask routing (`NetworkAskStack`) is unchanged.
- `release()` still rejects outstanding approvals.
- A thread's `Cwd` never changes after creation, and no server operation or tool can change it. Changing Neovim's cwd never affects running or existing threads.
- No `NvimCwd` appears under `node/server`.
- The server never receives buffer contents; reads always hit the filesystem (or the thread's sandbox/docker `fileIO`).

# Stages

## Split Cwd from NvimCwd ✅ done

- Progress: `Cwd` (`AbsFilePath & { __cwd: true }`) lives in `node/server/src/utils/files.ts`; every server `NvimCwd` became `Cwd`. `NvimCwd` is defined in `node/nvimclient/utils/files.ts`, which also exports `threadCwdFromNvimCwd` — the single conversion point, used in `magenta.ts` for the host's default thread cwd, the ScriptManager cwd and sandbox init.
- Decisions:
  - `resolveFilePath`, `relativePath`, `displayPath` and `DisplayContext.cwd` take a plain `AbsFilePath`, as do editor-side helpers (`utils/buffers.ts`, `utils/diagnostics.ts`, `openFileInNonMagentaWindow`, `displaySnapshotDiff`, `open-target-under-cursor`).
  - Server-bound client code that has not moved yet (`environment.ts`, `capabilities/*`, `sandbox-manager.ts`, `chat/session-host.ts`, `chat/commands/types.ts`/`diff.ts`, `render-tools/*`, `context/context-manager.ts`, `NvimThreadContext.cwd`) already uses `Cwd`, since it holds a thread's cwd.
  - The harness's `TestSessionHost.cwd` is now mutable (the default for new threads), and preparation honors `environmentConfig.cwd` for local threads. Test: `node/server/src/test/harness.test.ts` "keeps a thread's cwd fixed after creation" (relative `get_files` resolves against the thread's cwd after the host cwd changes).
  - Review follow-up: `toCwd` (`node/server/src/utils/files.ts`) is the single checked constructor for the `Cwd` brand (asserts absolute, normalizes). Used by `threadCwdFromNvimCwd`, the docker environment, `spawn_subagents` directories, and script `create-thread` cwds, which are now resolved (tilde + relative) against the ScriptManager cwd instead of cast. `buildLoadedFiles` has a unit test in `file-supervisor.test.ts`. Deferred: tests for the reflections work (reflect-thread initial context, `reflectionTree`/`reflectionRoot`, overview UX) and the `rowLabel` `ThreadId` typing / `Object.keys` cast in `session.ts` belong to that separate in-progress work, not this plan.
  - `reflect-anchor.test.ts` now asserts the per-row `rowLabel` extmark (`↳ N reflection(s)`) instead of a per-highlight virt_line, matching the reflections work included here. `]r`/`[r` (`lua/magenta/keymaps.lua`) skip those label extmarks, since they share the reflect namespace but have no `hl_group`.

- Goal: Add `Cwd` in the server and move `NvimCwd` into the client. Server code, capability constructors and `EnvironmentConfig` take `Cwd`. The client converts explicitly when it picks a new thread's initial cwd. No behavior change.
- Tests:
  - Type checks are the main test: `npx tsc -b` fails if a `NvimCwd` is passed where `Cwd` is expected.
  - Tier A: a thread created with an explicit `Cwd` runs its shell commands there. Changing the harness's client cwd afterwards does not move it.

## Move capabilities to the server ✅ done

- Progress: `sandbox-file-io`, `sandbox-shell`, `shell-utils`, `strace`, `docker-file-io`, `docker-shell`, `sandbox-violation-handler`, `noop-lsp-client` and the local/docker git clients (`capabilities/git-clients.ts`, beside the existing `git-client.ts` interface) now live in `node/server/src/capabilities/`; `sandbox-manager.ts` and `environment.ts` in `node/server/src/`; `mock-sandbox-manager.ts` in `node/server/src/test/`. Their tests moved with them into the `server` project and run without nvim. All are exported from the server barrel.
- Decisions:
  - `SandboxConfig`, `OnUnknownHostBehavior` and `DEFAULT_SANDBOX_CONFIG` moved to `node/server/src/sandbox-config.ts` (re-exported from client `options.ts`); `SandboxShell` takes `getSandboxConfig` instead of `getOptions`.
  - `SandboxFileIO` takes a `Logger` and an optional `onFileWritten(absPath)` callback in place of the buffer reload; the client supplies `reloadBufferIfOpen` (`nvimclient/utils/buffers.ts`).
  - `createLocalEnvironment` takes `logger`, `getSandboxConfig` and optional `lspClient`/`luaExecutor`/`onFileWritten`; the `lsp`/`nvim` capabilities are only offered when the respective collaborator is supplied (today `NvimSessionHost` always supplies both, so no behavior change).
  - `SandboxViolationHandler.view()` became `renderApprovals(handler)` in `nvimclient/capabilities/render-pending-approvals.ts` (uses the exported `deduplicateViolations`); its rendering tests moved to `render-approvals.node.test.ts`.
  - Review follow-up: `Environment` no longer stores `availableCapabilities`; `environmentCapabilities(env)` derives them from the optional `lspClient`/`luaExecutor` (and `environmentConfig.type` for `scripts`), so a capability cannot exist without its collaborator. `NvimSessionHost` supplies `NoopLspClient` to the thread context when `lspClient` is absent. Docker home dir goes through the new checked `toHomeDir`. Tests: `environment.test.ts` (capabilities with/without editor collaborators), `sandbox-file-io.test.ts` "onFileWritten" (called with the absolute path, skipped on rejected approval, rejecting callback does not fail the write). `reloadBufferIfOpen` is covered by existing tier-C `nvim/buffer-reload.test.ts` (agent edit reloads a clean buffer; "a buffer with unsaved user changes is left untouched"). Handler-logic tests (reject stderr note, network approve/reject, approveAll/rejectAll, write rejection) are all still in `sandbox-violation-handler.test.ts`; only rendering moved.
  - Not done: making `Environment` a local/docker discriminated union. The test-only `fileIO` override in `NvimSessionHost.prepare` produces a local environment without a handler, and approvals move to the session in the next stage anyway, which will reshape this field.

- Goal: `SandboxFileIO`, `SandboxShell`, `shell-utils`, `strace`, `DockerFileIO`, `DockerShell`, the git clients, `sandbox-manager.ts` and `environment.ts` live under `node/server/src`, taking a `Logger` instead of `Nvim`. `createLocalEnvironment` takes the LSP client and lua executor as optional inputs. `SandboxViolationHandler` moves with its rendering split out into `render-pending-approvals.ts`. No behavior change.
- Tests:
  - Move the existing capability tests with the code into the `server` vitest project. The sandbox-file-io and sandbox-shell tests should run without nvim (tier A/B).
  - The full suite stays green.

## Approval and bypass state on the session ✅ done

- Progress: `Session` (`node/server/src/session.ts`) owns per-thread approval stores (`approvalsFor(id)` lazily creates a `SandboxViolationHandler` whose change callback is `recordActivity`, i.e. the session `changed` event), bypass state (`bypassed`, `sandboxRoots`) and the operations `getPendingApprovals`, `approve`, `reject`, `approveAll`, `rejectAll`, `approveAllPendingInSubtree`, `isSandboxBypassed`, `toggleSandboxBypass`, `registerSandboxRoot`. Abort/delete reject a thread's approvals directly; `SessionHost.rejectApprovals` is gone. `permission-pending-change` RootMsg is removed.
- Decisions:
  - `createLocalEnvironment` takes `approvals` (the session store) instead of `onPendingChange`. `Environment.sandboxViolationHandler` stays for now (host `release` still rejects through it); the rename to `approvals` can happen with the server host stage.
  - Fork bypass inheritance happens inside `Session.create` for `fork` requests; `setSandboxBypassed` is gone (tests use `toggleSandboxBypass`).
  - Views: `renderApprovals` takes an `ApprovalActions` (structural subset of the handler); `sessionApprovals(session, id)` adapts session methods; `renderPendingApprovals(session, id)`. `NvimThread` no longer holds the handler; it notifies the user in `onThreadUpdate` when the pending count grows.
  - Tests: `session.test.ts` "owns approvals and bypass..." (child approval resolved by toggling bypass on root, fork inherits, independent afterward) and the deletion test now asserts a pending write is rejected. End-to-end tool completion under approval stays covered by the nvim tests (`fork-thread`, `thread-abort`, `script-manager`).
  - Review follow-up: `SandboxViolationHandler.getPendingViolations` returns `ReadonlyMap`, so `ApprovalActions` needs no cast. `Session.isSandboxBypassed` takes a `ThreadId`; callers with an optional id (`Chat.isSandboxBypassed`, the status in `magenta.ts`) handle `undefined`. Tests in `session.test.ts`: "delegates bypass of an externally owned root to that root" (registered `ScriptSandboxRoot` toggled from a child, subtree approved, session bypass set untouched), and the subtree abort test asserts a grandchild's pending approval is rejected.

- Goal: The session owns bypass state and approve/reject operations. Views read pending approvals via `session.getPendingApprovals` and act through session methods. The `permission-pending-change` RootMsg is replaced by the session `changed` event.
- Tests:
  - Tier A: a sandboxed write in a subagent child raises a pending approval visible through `session.getPendingApprovals(childId)`. Toggling bypass on the root approves it, and the tool completes.
  - Tier A: deleting a thread rejects its pending approvals, and the tool result reports rejection.
  - A fork of a bypassed root is bypassed. Existing nvim tests for approval keymaps keep passing.

## Server session host and editor attachment ✅ done

- Progress: `ServerSessionHost` (`node/server/src/server-session-host.ts`) performs all of the former `NvimSessionHost.prepare` (auto context, environments, system info/prompt, MCP manager, agents, fork/reflect handling, delivery-time resolution) and records a per-thread `PreparedThreadInfo` (`getPrepared(id)`) for views. `EditorCapabilities` (`node/server/src/capabilities/editor.ts`: `neovimVersion`, `createLspClient(cwd, homeDir)`, `luaExecutor`, optional `onFileWritten`) is attached with `Session.attachEditor`/`detachEditor` and read via `getEditor()` at preparation time only. `NvimSessionHost` is deleted; `node/nvimclient/chat/nvim-editor.ts` has `createNvimEditor` and the client `resolveSubmission`. `magenta.ts` constructs the server host and attaches the editor right after constructing `Magenta`, before the first thread. `Chat` builds `NvimThreadContext` from `host.getPrepared(id)` plus its own client context (`cwd` is the thread environment's cwd).
- Decisions:
  - Things that move in later stages are injected into the host: `getOptions` (typed as the structural `ServerHostOptions` subset, satisfied by `MagentaOptions`), `getProvider` (stage 6) and `resolveSubmission(message, { cwd, homeDir, getContextFiles, canCompact })` (stage 5; the client still runs `CommandRegistry`).
  - With no editor, the system info reports `neovimVersion: "none (no editor attached)"`. The editor's version is evaluated once at attach time instead of per thread.
  - Buffer reload after writes (`onFileWritten`) is an optional editor capability, resolved against Neovim's cwd.
  - Tests: `node/server/src/server-session-host.test.ts` (tmp dir cwd for the real local git client, `InMemoryFileIO` via the `fileIO` thread option): no-editor thread lacks `hover`, edits a file with `edl`; attaching later only affects new threads; detaching mid-stream does not abort the submission.
  - Review follow-up: `getPrepared(id)` returns `PreparedThreadInfo` and throws if missing (it is recorded before the session registers the thread), so `Chat.syncThread` has no silent-return branch. `PreparedThreadInfo.initialGitState` is a required `GitState | undefined` (undefined for forks). `onFileWritten` is spread conditionally. New tier-B test "wires editor capabilities into threads with the thread's cwd": real tmp dir, `createLspClient` receives the thread's `environmentConfig.cwd`, systemInfo carries the editor's `neovimVersion`, and `onFileWritten` fires with the absolute path only for threads created after attach.

- Goal: `ServerSessionHost` lives in the server and performs all of today's `prepare` except editor collaborators, which come from `session.attachEditor`. `NvimSessionHost` is deleted; `magenta.ts` constructs the server host and attaches the editor.
- Tests:
  - Tier A: a session with no attached editor creates a root thread whose `toolSpecs` exclude the lsp/nvim tools. It completes a turn that reads and edits a file through `InMemoryFileIO`.
  - Tier A: attaching an editor after creation does not change an existing thread's tool specs, but new threads get the lsp tools.
  - Tier A: detaching the editor mid-turn does not abort the running submission.

## Split submission resolution ✅ done

- Progress: `CommandRegistry`, `Command`/`MessageContext`/`CustomCommand` types and the `@file:`, `@diff:`, `@staged:`, `@implementplan`, `@compact` commands live in `node/server/src/submission/commands/`; `resolveSubmission` (`node/server/src/submission/resolve.ts`) builds a registry per delivery from `getOptions().customCommands` and is called directly by `ServerSessionHost` (the injected `resolveSubmission` context field is gone; `customCommands` joined `ServerHostOptions`). The client's `expandEditorCommands` (`node/nvimclient/chat/commands/editor-commands.ts`) runs in `Magenta.preprocessAndSend` after `parseDelivery`: it rewrites every `@file:` to an absolute `formatFileRef` path against `NvimCwd` and appends `@buf`/`@buffers`/`@qf`/`@quickfix`/`@diag`/`@diagnostics` expansions (`Current <label>:\n...`) to the submitted text. `CommandRegistry` is gone from `Magenta`, `Chat` and `NvimThread`.
- Decisions:
  - Editor expansions are appended to the message text (separated by blank lines) instead of separate content blocks, and are captured at submit time rather than delivery time, since the server cannot reach the editor. Tier-C tests in `chat/thread.test.ts` updated accordingly (3 content blocks; relative `@file:` becomes absolute in the submitted text).
  - `@file:` type detection uses `detectFileTypeViaFileIO` with the thread's `fileIO` (`MessageContext.fileIO`), so sandbox/docker/in-memory threads resolve through their own fileIO. `MessageContext` carries a `Logger` instead of `nvim`, and no `options`.
  - `@diff:`/`@staged:` use `execFile("git", ["diff", "--", path])` in the thread cwd instead of `zx` (not a server dependency).
  - Tests: `registry.test.ts` moved to the server (editor-command cases now use `@implementplan`/custom commands); `server-session-host.test.ts` "submission resolution": `@file:` adds context through `InMemoryFileIO` and custom commands expand, missing file error text, `@diff:` in a real tmp git repo. `chat/resolve-submission.test.ts` was deleted (its `@compact` cases are covered by `thread-compact.test.ts`).


- Goal: The fs/git commands and their registry move to the server resolver. The client pre-expands editor commands into text and makes `@file:` paths absolute before submitting.
- Tests:
  - Tier A: submitting `@file:/abs/path` adds context through `InMemoryFileIO`. A missing file produces the existing error text.
  - Tier B: `@diff <file>` in a real tmp git repo produces the diff content.
  - Tier C: `@buf` in the input buffer is expanded by the client before it reaches the thread (assert on the submitted provider message). A relative `@file:` is resolved against the client cwd.

## Options, auth and providers

- Goal: `OptionsStore`, `ServerOptions` parsing/merging, sandbox initialization/refresh, `auth/anthropic.ts`, `providers/` and `utils/pdf.ts` live in the server. Server options come only from `~/.magenta/options.json` and the project `.magenta/options.json`. Lua `setup()` is reduced to `ClientOptions`. Server-relevant keys still passed via lua produce a warning pointing at `~/.magenta/options.json`.
- Tests:
  - Tier B: with a tmp home dir, `~/.magenta/options.json` alone fully configures a session (profiles, sandbox). Editing the project `.magenta/options.json` is picked up by `getOptions()` on the next call. Existing options parsing tests move with the code.
  - Tier C: passing a server-only key (e.g. `profiles`) to lua `setup()` logs the migration warning and has no effect.
  - Existing provider/auth tests move to the `server` project and pass.

## Enforce the boundary

- Goal: Add a test that scans `node/nvimclient/**/*.ts` (excluding tests) for `node:fs`, `fs`, `fs/promises`, `node:child_process` and `child_process` imports, failing on anything outside the allowlist. Update `context.md` (Architecture/Sessions sections) to describe server-owned execution and editor attachment.
- Tests:
  - The boundary test itself; it should fail if `sandbox-file-io.ts` is moved back.

# Out of scope

- Changing a thread's cwd (the `change_directory` tool) is a later, separate plan.
- Sending unsaved buffer contents to the server is not planned.
