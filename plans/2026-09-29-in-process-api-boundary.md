# Objective and Context

Step 3 of `plans/2026-09-16-client-server-protocol.md`: "Introduce the API boundary in-process. Define serializable snapshots and ID-addressed operations. Make the Neovim client render those snapshots and invoke operations instead of reading live `Thread` objects. Keep transport out of this step so ownership and serialization problems are easier to isolate."

User direction, verbatim:

> ProviderMessage is fine.
>
> For any additional live objects, we'll need to expose those as part of the state of the other objects. So:
>
> - structured state, like structured tool results are part of the thread state
> - file context is part of the thread state
> - edited files is part of the thread state
> - compaction is part of the thread state
>
> Let's not call them snapshots. They are:
>
> - global state
> - session state
> - script state
> - thread state

Today the client reads live server objects directly:

- `NvimThread` (`node/nvimclient/chat/thread.ts`) and `thread-view.ts` read `Thread`: `getProviderMessages()`, `state` (`ThreadState`, incl. `activeTools` with live `ToolInvocation` handles and `unknown` progress), `completedTools` (`CompletedToolInfo` with `structuredResult`), `title`, `threadType`, `systemPrompt`, `toolSpecs`, `contextFiles` (a `FileSupervisor` pick with mutators), `getContextDelivery(nativeIdx)`, `editedFileGroups`, `latestUsage`, `lastResult()`, `yielded`, `queued`, `isBusy`. Compaction is read from `ThreadCompactor.current`/`runs` and its `transition` event.
- `Chat` (`chat/chat.ts`), `reflections-overview.ts`, and `render-pending-approvals.ts` read `Session`: `listThreads()` (`SessionThread`, incl. `error: Error` and `options`), `getThread`, `getOrigin`, `getRootAncestorId`, `buildChildrenMap`, `listDerived`, `isSandboxBypassed`, `getPendingApprovals` (`PendingViolation`, holding `resolve`/`reject` closures), `teardownMessages`, and subscribe to `changed`/`removed`.
- `ScriptController` (`scripts/script-manager.ts`) reads `ScriptManager`: `getCatalog`, `listInvocations`/`getInvocation` (`ScriptInvocation`), `getThreadYield`, and its four events.
- Writes go straight to methods on those objects (`submit`, `enqueue`, `retry`, `ToolInvocation.abort`, `setTitle`, `destroy`, `createRootThread`, `forkThread`, `approve`, `toggleInvocationSandbox`, ...). `Session.registerSandboxRoot(threadId, getSandboxRoot)` passes a function.
- Server→client: `ClientCapabilities` (`capabilities/client.ts`). `createLspClient(cwd, homeDir)` returns an `LspClient` object; everything else is already plain async calls/notifications.

Relevant files:

- `node/server/src/session.ts`: thread registry and session operations.
- `node/server/src/thread.ts`, `thread-state.ts`, `thread-supervisor.ts`, `thread-core.ts`: thread data the view reads.
- `node/server/src/compaction/compactor.ts`: `CompactionRunState`.
- `node/server/src/scripts/script-manager.ts`: script catalog and invocations.
- `node/server/src/capabilities/client.ts`, `lsp-client.ts`, `sandbox-violation-handler.ts`: client capabilities and approvals.
- `node/server/src/index.ts`: barrel the client imports from.
- `node/nvimclient/magenta.ts`: composition root and command handlers.
- `node/nvimclient/chat/{chat,thread,thread-view,reflections-overview}.ts`, `capabilities/render-pending-approvals.ts`, `scripts/script-manager.ts`: the views to migrate.
- `node/nvimclient/fs-boundary.node.test.ts`: pattern for the new import-boundary test.

# Design

Add a `protocol` module to the server (`node/server/src/protocol/`), the only thing the client talks to. It has three parts:

- **State types**: `ProtocolGlobalState`, `ProtocolSessionState`, `ProtocolScriptState`, `ProtocolThreadState`. They are plain, readonly, JSON-serializable data, with no functions, class instances, `Error`s, `Map`s, or handles. `ProviderMessage` is included as is.
- **Operations**: one discriminated union `Operation`, where every target is addressed by ID. `MagentaServer.execute(op)` returns a serializable `OperationResult`.
- **Subscriptions**: `MagentaServer.subscribe(topic, listener)` delivers the whole state for a topic right away, and again on every change. It returns an unsubscribe function. Topics are `global`, `session`, `script`, and `thread`, and a client may hold any number of them.

The state is projected on demand from the live objects by pure functions, such as `threadState(thread, compactor, session)`. The protocol plan says to send the whole state on every update, so no incremental bookkeeping is needed. Change detection reuses the existing signals: thread `onUpdate`, compactor `transition`, session `changed`/`removed`/`settings-changed`, and script manager events. `MagentaServer` coalesces them per topic on a microtask, then projects and delivers. In-process, the state is passed by reference without cloning. Serializability is enforced by types and by a JSON round-trip test, not at runtime.

Existing type names are unchanged. The protocol types are prefixed `Protocol*`, and `ProtocolThreadState.run` holds the existing `ThreadState`.

The live objects the user listed become fields of thread state:

- Structured tool results: `tools` maps each `ToolRequestId` to its request, status, progress, result and `structuredResult`. It covers both active and completed tools, which replaces `toolResultMap` rebuilding in `NvimThread`. Tool `progress` must be JSON-serializable. This is an invariant each tool's progress type must meet.
- File context: `contextFiles` (the current tracked files) and `contextDeliveries` (the structured `ContextDelivery` keyed by native message index). Mutations such as add/remove file context become operations.
- Edited files: `editedFileGroups`.
- Compaction: `compaction: { current, runs }`, from `CompactionRunState`.

Approvals become data plus operations. The session state lists `{ id, threadId, prompt }` without the closures, and `approval.approve/reject` carry IDs. Session thread entries replace `error: Error` with `{ message }`, and drop `options` except for the fields the view shows (profile name, environment).

The client keeps its UI state (expansion, view states, selection, buffers, scroll) and holds only the latest received state per subscription. `Chat` subscribes to the session state. Each `NvimThread` subscribes to its thread's state while it exists, and `ScriptController` to the script states it shows. Every mutation goes through `execute`. The composition root, the only place that constructs `Session` and `ScriptManager` and attaches the client, moves into `createInProcessServer(...)`. `Magenta` receives a `MagentaServer` and nothing else from the server side. In step 4, that interface is implemented by a WebSocket client.

Anything that is a function at the boundary is split into data plus an effect handler. Each direction has one data union and one handler:

- Client→server: `Operation` (data), handled by `MagentaServer.execute`. This includes things that are closures or handles today: approval `resolve`/`reject` become `approval.*` operations, `ToolInvocation.abort` becomes `tool.abort`, and `FileSupervisor` mutators become `thread.*ContextFile*` operations.
- Server→client: `ClientCapabilities` is replaced by `ClientRequest` (data that expects a response: LSP, lua, client command expansion, OAuth URL prompt, file written) and `ClientNotification` (fire-and-forget: login progress, auth errors). The client registers one `ClientEffectHandler` `{ info, request(req), notify(n) }`. On the server, adapters (`LspClient`, `LuaExecutor`, `AuthUI`, the client command expansion, `onFileWritten`) turn their calls into `ClientRequest`s, so tools and providers don't change. `createLspClient(cwd, homeDir)` goes away, because each `lsp` request carries `cwd`/`homeDir`.
- Server→client state: the subscription listener is the client's handler for state deliveries. In step 4 it becomes a message type.

The session keeps `ClientEffectHandler` as its attached client, so `awaitClient` and delivery-time resolution work unchanged.

`registerSandboxRoot(threadId, fn)` follows the same rule. Whatever it computes becomes data, either moved server-side or passed in an operation, and is examined in the session-view stage.

## Interfaces

```ts
// protocol/state.ts
export type ProtocolGlobalState = {
  sessions: ReadonlyArray<{ id: SessionId; title?: string; threadCount: number; running: number }>;
};

export type ProtocolSessionState = {
  id: SessionId;
  activeProfile: ProfileSelection;          // existing type, serializable
  threads: ReadonlyArray<SessionThreadSummary>;
  scripts: { catalog: ReadonlyArray<ScriptMeta>; invocations: ReadonlyArray<ScriptInvocationSummary> };
  pendingApprovals: ReadonlyArray<PendingApproval>;
  awaitingClient: number;
};

export type SessionThreadSummary = {
  id: ThreadId;
  parentThreadId?: ThreadId;
  scriptInvocationId?: ScriptInvocationId;
  origin?: ThreadOrigin;
  rootAncestorId: ThreadId;
  lastActivityTime: number;
  title?: string;
  threadType: ThreadType;
  sandboxBypassed: boolean;
  teardownMessage?: string;
} & (
  | { state: "pending" }
  | { state: "error"; error: { message: string } }
  | { state: "ready"; run: ThreadState }
);

export type PendingApproval = { id: string; threadId: ThreadId; prompt: PendingShellPrompt | PendingWriteApprovalPrompt /* ... */ };

export type ProtocolScriptState = ScriptInvocationSummary & {
  logs: ReadonlyArray<string>;
  entries: ReadonlyArray<ScriptInvocationEntry>;
  threadYields: Readonly<Record<ThreadId, ScriptThreadResult>>;
};
export type ScriptInvocationSummary = Omit<ScriptInvocation, "logs" | "entries">;

export type ProtocolThreadState = {
  id: ThreadId;
  title?: string;
  threadType: ThreadType;
  cwd: Cwd;
  run: ThreadState;
  busy: boolean;
  yielded?: YieldState;
  lastResult?: SubmissionResult;
  messages: ReadonlyArray<ProviderMessage>;
  tools: Readonly<Record<ToolRequestId, ToolState>>;
  queued: Queues;
  latestUsage?: Usage;
  systemPrompt: SystemPrompt;
  toolSpecs: ReadonlyArray<ProviderToolSpec>;
  contextFiles: ReadonlyArray<TrackedContextFile>;   // from FileSupervisor.files
  contextDeliveries: Readonly<Record<NativeMessageIdx, ContextDelivery>>;
  editedFileGroups: ReadonlyArray<EditedFileGroup>;
  compaction: { current?: Extract<CompactionRunState, { type: "running" }>; runs: ReadonlyArray<CompactionRunState> };
  derived: { forks: ReadonlyArray<ThreadId>; reflections: ReadonlyArray<ThreadId> };
};

export type ToolState = {
  request: ToolRequest;
} & (
  | { status: "running"; progress: JsonValue }
  | { status: "done"; result: ToolResultInput; structuredResult?: ToolStructuredResult }
);

// protocol/operations.ts
export type Operation =
  | { type: "thread.create"; sessionId: SessionId; agent?: string }
  | { type: "thread.fork"; threadId: ThreadId; messageIdx: number }
  | { type: "thread.reflect"; threadId: ThreadId; anchor: ReflectAnchor }
  | { type: "thread.delete"; threadId: ThreadId }
  | { type: "thread.submit"; threadId: ThreadId; input: SubmissionInput; delivery?: Delivery }
  | { type: "thread.retry"; threadId: ThreadId }
  | { type: "thread.abort"; threadId: ThreadId }
  | { type: "thread.setTitle"; threadId: ThreadId; title: string }
  | { type: "thread.recordActivity"; threadId: ThreadId }
  | { type: "thread.addContextFiles"; threadId: ThreadId; files: ReadonlyArray<AbsFilePath> }
  | { type: "thread.removeContextFile"; threadId: ThreadId; file: AbsFilePath }
  | { type: "tool.abort"; threadId: ThreadId; toolRequestId: ToolRequestId }
  | { type: "approval.approve" | "approval.reject"; threadId: ThreadId; approvalId: string }
  | { type: "approval.approveAll" | "approval.rejectAll"; threadId: ThreadId }
  | { type: "approval.approveAllInSubtree"; threadId: ThreadId }
  | { type: "sandbox.toggleBypass"; threadId: ThreadId }
  | { type: "session.setActiveProfile"; sessionId: SessionId; name: string }
  | { type: "script.run"; sessionId: SessionId; name: string; parameters: unknown }
  | { type: "script.abort" | "script.delete" | "script.toggleSandbox"; invocationId: ScriptInvocationId }
  | { type: "script.discover"; sessionId: SessionId };

export type OperationResult =
  | { type: "ok"; threadId?: ThreadId; invocationId?: ScriptInvocationId; submission?: SubmissionResult }
  | { type: "aborted" }
  | { type: "error"; message: string };

// protocol/server.ts
export type Topic =
  | { type: "global" }
  | { type: "session"; sessionId: SessionId }
  | { type: "script"; invocationId: ScriptInvocationId }
  | { type: "thread"; threadId: ThreadId };
export type StateFor<T extends Topic> = /* ProtocolGlobalState | ProtocolSessionState | ProtocolScriptState | ProtocolThreadState */;

export interface MagentaServer {
  subscribe<T extends Topic>(topic: T, listener: (state: StateFor<T> | undefined) => void): () => void; // undefined = gone
  execute(op: Operation): Promise<OperationResult>;
  attachClient(handler: ClientEffectHandler): void;
  detachClient(): void;
  dispose(): Promise<void>;
}

export function createInProcessServer(deps: InProcessServerDeps): MagentaServer;

// protocol/client.ts
export type ClientInfo = { neovimVersion: string; supportsAuthUI: boolean; notifiesFileWritten: boolean };

export type ClientRequest =
  | ({ type: "lsp" } & LspRequest)
  | { type: "lua"; code: string }
  | { type: "expandClientCommand"; command: ClientCommandName; match: string }
  | { type: "oauth"; authUrl: string }
  | { type: "fileWritten"; absPath: AbsFilePath };

export type ClientResponse<R extends ClientRequest> =
  R extends { type: "lsp" } ? LspResponse :
  R extends { type: "lua" } ? JsonValue :
  R extends { type: "expandClientCommand" } ? AgentInput[] :
  R extends { type: "oauth" } ? { code: string } :
  R extends { type: "fileWritten" } ? undefined : never;

export type ClientNotification =
  | { type: "loginProgress"; chunk: string }
  | { type: "authError"; message: string };

export interface ClientEffectHandler {
  info: ClientInfo;
  /** Rejection surfaces as the caller's error (e.g. `Error fetching ...`).
   * Cancellation is a later `cancel` request by id once there's a transport;
   * in-process the server drops the result. */
  request<R extends ClientRequest>(req: R): Promise<ClientResponse<R>>;
  notify(n: ClientNotification): void;
}

export type LspRequest = {
  cwd: Cwd; homeDir: HomeDir;
  kind: "hover" | "references" | "definition" | "typeDefinition";
  filePath: AbsFilePath; position: { line: number; character: number };
};
```

The exact fields of `TrackedContextFile`, `PendingApproval.prompt`, and the summary fields are taken from the current types while implementing each stage. The shapes above name what is exposed, not every field.

## Invariants

- Every state value survives `JSON.parse(JSON.stringify(x))` unchanged (deep-equal), with no functions, `Error`s, `Map`s, class instances, `undefined` inside arrays, or live handles.
- A subscriber receives the current state immediately, then the latest state after each change. Intermediate states can be coalesced, but the last change is never lost.
- A subscription to a thread that is deleted receives `undefined` once, and nothing afterwards.
- Across compaction replacement, the thread subscription continues seamlessly because Thread is stable, and compaction progress shows up in `compaction`.
- Every mutation from the client goes through `execute` with IDs. The client never holds `Thread`, `Session`, `ScriptManager`, `ThreadCompactor`, `FileSupervisor`, `ToolInvocation`, or approval closures.
- Operations on unknown IDs return `{ type: "error" }` and don't throw.
- Unsubscribing, or all subscriptions dropping, never affects execution. Execution still does not depend on a view.
- Nothing that crosses the boundary is a function or a handle. Each effect is a data value (`Operation`, `ClientRequest`, `ClientNotification`) handled by exactly one handler on the receiving side, and every request and response is serializable.
- The existing session invariants still hold: client-state commands resolve at delivery, and detaching never aborts threads.

# Stages

## Protocol state types and projections

Status: done.

- [x] `node/server/src/protocol/state.ts`: the four state types and projections `threadState`, `sessionState`, `scriptState`, `globalState`, plus `runState` and `pendingApproval`.
- [x] Accessors: `Thread.contextDeliveries` (backed by `ThreadCore.contextDeliveryEntries`). Context files come from the existing `thread.contextFiles.files`. Approvals are projected from `Session.getPendingApprovals`, so no new session accessor was needed.
- [x] Tier-A tests in `protocol/state.test.ts`. Tool progress is enforced by a type-level `JsonValue` check on `BashProgress` and `SpawnSubagentsProgress` (the only tools that report progress). The running bash progress also round-trips at runtime.

Decisions/deviations:

- `ThreadState` is not serializable: running tools hold live `ToolInvocation` handles, streaming holds `Date`s, and retry/failed hold `Error`s. `ProtocolThreadState.run` and `SessionThreadSummary.run` are therefore `ProtocolRunState`. It lists running tools by id (details are in `tools`), uses epoch-ms times, and replaces errors with `{ message }`. `lastResult` is `ProtocolSubmissionResult` for the same reason.
- `SessionThreadSummary` also has `profileName` and `environment` (from options). `title` falls back to `options.label` before the thread is ready.
- `PendingApprovalPrompt` drops closures. Violations carry deduplicated lines (`{ line, count }`) instead of raw events (which contain a `Date`) and the shell result.
- `TrackedContextFile` is `{ absFilePath, relFilePath, fileTypeInfo, agentView, lastStat? }`.
- The session projection takes the `ScriptManager` as a separate argument (`undefined` when absent), because `session.scriptRunner` is only the `ScriptRunner` interface.
- The projections are not yet exported from the server barrel. The next stage wires them.
- Review follow-up: `ProtocolThreadState` dropped `busy`/`yielded`/`lastResult`; `run` is the single source. `compaction` is `{ runs }` only, and the current run is the last entry with `type: "running"` (as `ThreadCompactor.current` already derives it).
- `JsonValue` lives in `utils/json.ts`. `ExecutingToolInvocation.progress?` and `ActiveToolEntry.progress` are typed `JsonValue`, so tools' progress types are checked where declared and the projection has no cast.
- Approvals use a branded `ApprovalId` (from `SandboxViolationHandler` through `Session.approve/reject`) and write approvals carry `AbsFilePath` end to end.
- The `absFilePath as AbsFilePath` cast in `threadState` remains: `FileSupervisor.files` is a string-keyed record, and changing it to a `Map` touches every supervisor consumer. Left for the thread-view stage.
- Tests added: streaming retry and `failed` projections (`state.test.ts`), `contextDeliveries` following the replacement core after compaction, and a tier-B `scriptState`/`sessionState(scripts)` test in `nvimclient/scripts/script-manager.node.test.ts` (reuses its real-script fixture). The `toolStates` completed-wins rule is defensive for the settlement overlap and not separately tested.
- For the client-effects stage, `fileWritten` responds with `undefined`, not `null`.

- Goal: Add `protocol/state.ts` with the four state types, and pure projection functions from `Session`/`Thread`/`ThreadCompactor`/`ScriptManager`. Add accessors where the data is private today: context file list, context deliveries as a record, approvals without closures. The client is not changed yet.
- Tests:
  - Tier A: drive a thread through a submission with a tool call (mock provider) that produces progress, a structured result, a file edit, and a context file delivery, then run a compaction. At each step, the projected `ProtocolThreadState` round-trips through JSON unchanged and contains the expected tools/edited files/context deliveries/compaction runs.
  - Tier A: a pending sandbox approval appears in `SessionState.pendingApprovals` without closures. A thread whose creation failed projects `error.message`.
  - Tier A: every tool's progress type round-trips through JSON. Exercise each tool that reports progress, or add a type-level `JsonValue` constraint on progress and let `tsc` enforce it.

## In-process server: subscribe and execute

Status: done.

- [x] `protocol/operations.ts`: `Operation` and `OperationResult`.
- [x] `protocol/server.ts`: `MagentaServer`, `Topic`, `StateFor`, `createInProcessServer({ session, scripts? })`.
- [x] Tier-A tests in `protocol/server.test.ts` (ordering and a final delivery equal to a fresh projection, coalescing, deletion delivering `undefined` once, unsubscribe not affecting runs, `tool.abort`, `approval.approve`, unknown ids, `thread.create`/`session.setActiveProfile`). The `script.run` test is tier B in `nvimclient/scripts/script-manager.node.test.ts` (real script fixture), and also covers `script.delete` delivering `undefined`.

Decisions/deviations:

- Change sources: thread topics listen for session `changed`/`removed` for their id (thread `onUpdate` already emits `changed`), plus the compactor `transition` once the thread is ready. Session/script topics listen to all session events and script manager events. The global topic listens to session events only. Each subscription has its own microtask flag.
- A thread subscription made while creation is still pending delivers nothing until the thread is ready. A creation error or deletion delivers `undefined`.
- `thread.fork` takes `nativeMessageIdx?: NativeMessageIdx` (what `Session.forkThread` takes), not `messageIdx`. `thread.addContextFiles` takes `UnresolvedFilePath`s (what `addFiles` takes).
- `thread.submit` with delivery `now` (or none) awaits the whole submission and returns `submission` as `ProtocolSubmissionResult`. `async`/`next` enqueue and return `ok`. `thread.abort` goes through `Session.abortThread`, and the unsent input is not returned yet.
- `script.run` starts with `sandboxBypassed: false`.
- Unknown ids throw internally, and `execute` converts every throw into `{ type: "error", message }`. Approve/reject check that the approval id is pending, and `tool.abort` checks that the tool is running.
- Until stage 3, `attachClient` takes `ClientCapabilities`. In this stage `dispose()` only closes subscriptions, because the composition root still owns the session and script manager. It isn't exported from the barrel yet.
- Review follow-up: `OperationResult` has one success variant per result shape: `created` (thread.create/fork/reflect), `started` (script.run), `submitted` (thread.retry, immediate thread.submit), `queued` (async/next thread.submit), `ok` otherwise. `Topic`/`StateFor` are derived from per-type maps, and both projection and change-source wiring go through per-topic handler maps (`projectors`, `watchers`), so `subscribe` has no casts; `SessionEvents` is exported for typed listeners. Tests added for `next` delivery and script ops without a script runner. Branded profile/script names were not introduced (existing `Session.setActiveProfile`/`startScript` take `string`).

- Goal: `createInProcessServer` wraps a `Session` and its `ScriptManager`, implements `subscribe` with per-topic microtask coalescing, and dispatches each `Operation` to the existing methods. It returns `OperationResult`s and turns unknown IDs and thrown errors into `{ type: "error" }`.
- Tests:
  - Tier A: subscribe to a thread, then submit via `execute`. The listener sees `busy`, streaming, and the final state in order, and the last delivered state equals a fresh projection.
  - Tier A: many synchronous updates cause a bounded number of deliveries, and the last one is current.
  - Tier A: deleting a thread delivers `undefined` once. Unsubscribing mid-run doesn't affect the run's `SubmissionResult`.
  - Tier A: `tool.abort` on a running tool aborts just that tool. `approval.approve` resolves the pending shell prompt. Operations on unknown IDs return an error.
  - Tier A: the session subscription reflects `thread.create`, `session.setActiveProfile`, and a script run.

## Client effects as data

Status: done.

- [x] `protocol/client.ts`: `ClientInfo`, `ClientRequest`, `ClientResponse`, `ClientNotification`, `ClientEffectHandler`. `ClientCapabilities` is gone; `Session`, `awaitClient`, `MagentaServer.attachClient` and the host take the handler.
- [x] Server adapters in `capabilities/client.ts`: `clientLspClient(handler, cwd, homeDir)`, `clientLuaExecutor`, `clientFileWritten` (only when `info.notifiesFileWritten`). Client commands issue `expandClientCommand`. The host's `AuthUI` issues `oauth` requests and `loginProgress`/`authError` notifications (gated by `info.supportsAuthUI`, still buffered/replayed when no client).
- [x] `createNvimClient` is one handler switching on `type`; `NvimLuaExecutor` removed.
- [x] Tests: `FakeClient` in `test/fakes.ts`; host tests assert the `lsp` request (thread cwd/homeDir/position), `fileWritten`, `oauth` and notifications, with JSON round-trips.

Decisions/deviations:

- `ServerSessionHostContext.getAuthUI` became `getClient`.
- `LspRequest` has `type: "lsp"` inline and `ClientResponse` maps `kind` to the specific LSP response type. The nvim handler has one cast from its non-generic switch to `ClientResponse<R>`.
- OAuth abort races the client request against the signal; the in-process client prompt is not cancelled, its result is dropped.
- `JsonValue` is exported from the server barrel.
- Review follow-up: `createClientEffectHandler({ neovimVersion, handlers, notify })` builds a handler from a per-type map (`ClientRequestHandlers`, each entry typed request→response), with the single correlated-lookup cast inside it. `oauth`/`fileWritten` handlers are optional and `ClientInfo.supportsAuthUI`/`notifiesFileWritten` are derived from their presence. The nvim client and `FakeClient` (which takes partial handlers) both use it.
- The `lua` response is `JsonValue | undefined`: lua `nil` maps to `undefined`, and the nvim client validates the result with `isJsonValue` (throws otherwise) instead of casting.
- `clientLspClient` builds requests with one generic `lsp(kind)` helper.
- Tests: OAuth abort while the client prompt is pending (rejects with the signal reason, late answer ignored); tier-C `chat/nvim-client.test.ts` sends `lua` (table and nil) and `lsp` hover requests through `createNvimClient`.

- Goal: Replace `ClientCapabilities` with `ClientEffectHandler`, `ClientRequest`, and `ClientNotification`. The server-side adapters (`LspClient`, `LuaExecutor`, `AuthUI`, client command expansion, `onFileWritten`) issue requests and notifications through the attached handler, so `hover`/`find_references`/`nvim_lua`/OAuth/client commands don't change. `createNvimClient` becomes one handler that switches on `type`.
- Tests:
  - Tier A: a fake handler records the `ClientRequest`s it receives. Running `hover` produces an `lsp` request carrying the thread's `cwd`/`homeDir` and the position. `@qf` produces `expandClientCommand`. An OAuth flow produces `oauth`, then progress arrives as `loginProgress` notifications. All of them round-trip through JSON.
  - Tier A: the existing `awaitClient`/OAuth-pending/client-command tests pass against the handler.

  - The existing tier-C hover/find_references/nvim_lua tests pass.

## Thread view on thread state

Status: done.

- [x] `NvimThread(id, context)` subscribes to its thread topic (the first delivery is synchronous, so construction requires a ready thread) and keeps `threadState`. `thread`/`compactor`, `toolResultMap`, the compactor `transition` listener and `destroy()` are gone. Submit/enqueue/retry/setTitle/reject-on-preempt/tool abort (`abort-tool` msg, `t` binding)/context file removal go through `execute`.
- [x] `thread-view.ts` renders from `ProtocolThreadState`: `renderStatus(run, usage, compaction, tick)` reads yield/lastResult from `run`; running compaction is the last `running` run; tools come from `tools`; `findToolResult` falls back to `tool_result` blocks in `messages` (forked history), memoized per messages array.
- [x] `context-manager.ts` takes `ContextFilesData` (`files`, `pending`, `remove`) instead of `ContextFileAccess`.
- [x] Magenta constructs the in-process server (after the script manager) and passes it to `Chat`; the `context-files` command uses `thread.addContextFiles`.
- [x] Tier C: `thread-abort.test.ts` "aborting one running tool leaves the rest of the batch running".

Decisions/deviations:

- `ProtocolThreadState` gained `pendingContextUpdates` (the context view shows undelivered changes) and `lastStopTokenCount` (sidebar chrome/thread list). Protocol types and `createInProcessServer` are exported from the server barrel.
- `Chat` reads of the wrapper's thread (display name, summary, needs-attention, token count) now use `threadState`; fork still reads `nativeMessageIdx` from the session record, left for the session-view stage. Views still read derived forks/reflections and approvals from `Session` until that stage.
- Failed submissions carry `{ message }` only, so the status line no longer prints the error stack.
- Tests reach live server objects through white-box helpers `serverThread`/`serverCompactor` in `test/left-thread.ts`.
- Review follow-up: `MagentaServer.getState(topic)` returns the current state (or `undefined`); `NvimThread` reads its initial state from it instead of capturing the synchronous first delivery, and ignores an identical re-delivery. `thread.addContextFiles`/`FileSupervisor.addFiles` accept `UnresolvedFilePath | AbsFilePath`, removing the double cast in `magenta.ts`. The running-compaction lookup uses a type-guard predicate.

- Goal: `NvimThread` holds a `ThreadId`, a subscription, and the latest `ProtocolThreadState`. `thread-view.ts` renders from it, so `toolResultMap` rebuilding and the compactor `transition` subscription are gone. Submit/enqueue/retry/tool abort/setTitle/context-file edits go through `execute`. The debounce on re-render is kept.
- Tests:
  - The existing tier-C `chat/thread.test.ts` and tool view tests pass unchanged, including separate `@buf`/`@diag` blocks, tool progress, structured results, edited files, context file updates, and compaction rendering.
  - Tier C: aborting a single running tool from the view aborts it, and the rendered state updates.

## Session and approvals views on session state

Status: done.

- [x] `chat/session-view.ts`: `SessionView` holds the latest `ProtocolSessionState` and the hierarchy lookups (`getThread`, `getOrigin`, `getRootAncestorId`, `buildChildrenMap`, `listDerived`, `getPendingApprovals`, `isSandboxBypassed`). `Chat.session` is a `SessionView`; Chat subscribes to the session topic and builds/drops `NvimThread` wrappers from each delivery.
- [x] Chat takes `{ sessionId, host, server, scriptRunner }` (no `Session`). Create/fork/reflect/delete, recordActivity, abort, sandbox bypass, approvals and profile switching go through `execute`.
- [x] `render-pending-approvals.ts`: `ApprovalActions` is `{ pending: PendingApproval[], approve/reject/approveAll/rejectAll }` routed to `approval.*` operations; `reflections-overview.ts` takes a `SessionView`.
- [x] Tier A: `approval.approveAllInSubtree resolves approvals of child threads` in `protocol/server.test.ts`.

Decisions/deviations:

- Deliveries are microtask-coalesced, so Chat methods that create or delete threads (`createThread`, `handleForkThread`, `deleteThread`, `toggleSandboxBypass`) await `execute` and then call `refreshSession()`, which pulls `server.getState` synchronously so the result is visible to the caller. `Chat.execute` throws on error results.
- `thread.abort` returns `{ type: "threadAborted", unsent: string[] }` (unsent input rendered via `renderPending`), used to restore the input buffer.
- Fork reads the fork point from the new thread's `origin.nativeMessageIdx` (session state) instead of the source thread's live `nativeMessageIdx`.
- `registerSandboxRoot` is server-to-server wiring (ScriptManager → Session) in the composition root; no view uses it. It moves with the composition root in the boundary stage.
- `magenta.ts` still owns `Session`/`ScriptManager`/host (composition root) and reads `session.getActiveProfile()` for options; `Chat` still uses `host.getPrepared`/`mcpToolManager` for `NvimThread` context. Both are left for the boundary stage.
- Tests reach the live session through `serverSession(chat)` in `test/left-thread.ts` (registered by the test driver). `pendingApproval` and `ApprovalId` are exported from the server barrel.
- Review follow-up: operation results are typed per operation. `OperationSuccessMap` (operations.ts) maps each `Operation["type"]` to its success result(s), `OperationResultFor<O>` adds the error variant, and `MagentaServer.execute`/`Chat.execute` are generic over `O`. The server's dispatch is a per-type handler map (`handlers`), with the one correlated-lookup cast in `dispatch`. Client fallbacks were removed (`abortThread` reads `unsent` directly; create/fork only branch on `aborted`). `SessionView.listDerived`'s inline type guard was kept contained. Tests added: `thread.abort` unsent (with and without queued input) in `server.test.ts`; wrapper/view removal on delete and `chat.execute` error rejection in `chat-view-adapter.test.ts` (tier C, since Chat needs nvim); `session-view.node.test.ts` for `listDerived`/`buildChildrenMap`.

- Goal: `Chat`, `reflections-overview.ts`, and `render-pending-approvals.ts` render from `SessionState`, and hierarchy helpers (`rootAncestorId`, children, derived) come from the state. Thread create/fork/reflect/delete, recordActivity, sandbox bypass, approvals, and profile switching go through `execute`. `registerSandboxRoot` is replaced with data or moved server-side.
- Tests:
  - The existing tier-C chat/thread-list, fork, reflect, approval, sandbox bypass, and `can switch profiles` tests pass.
  - Tier A: approving a subtree via `approval.approveAllInSubtree` resolves the approvals of the child threads.

## Script views on script state

Status: done.

- [x] `ScriptController` takes `{ server, sessionId }` instead of the server `ScriptManager`. It subscribes to the session topic and keeps one `script` subscription per invocation listed in `scripts.invocations`, rendering from the latest `ProtocolScriptState` (entries, `threadYields`). Abort/delete/toggle sandbox go through `execute` (errors are logged).
- [x] The finished notification is derived from a running → not-running transition in script state (or a first delivery already finished, for invocations appearing after startup).
- [x] Tests: the existing tier-C script tests pass; the tier-B `script-manager.node.test.ts` tests (from stages 1-2) cover logs arriving through the script subscription, thread yields in `scriptState`, and a single `undefined` after `script.delete`. No separate tier-A test: scripts need a real child process.

Decisions/deviations:

- The controller's unused `getCatalog`/`discover` were removed (no callers; tests read the catalog from the server `ScriptManager` via `driver.magenta.scripts`, which goes away in the boundary stage). `script.run`/`script.discover` have no client callers yet: scripts are started by the `run_script` tool server-side.
- The session delivery only re-renders when the invocation set changes. Re-rendering on every session change (every thread update) raced display-buffer key triggers in `thread-abort.test.ts`. Script topics still fire on every session event, so each live invocation re-renders on thread updates.

- Goal: `ScriptController` renders the catalog from `SessionState.scripts`, and each invocation from a `ScriptState` subscription. Abort/delete/toggle sandbox/discover/run go through `execute`.
- Tests:
  - The existing tier-C script tests pass.
  - Tier A: a script's `ScriptState` shows logs and thread yields as the run progresses, and delivers `undefined` after `script.delete`.

## Enforce the boundary

- Goal: `Magenta` receives a `MagentaServer` from `createInProcessServer`, and only the composition root constructs server objects. Add `node/nvimclient/server-boundary.node.test.ts`, in the style of `fs-boundary`. It fails if nvimclient imports `Session`, `Thread`, `ThreadCore`, `ThreadCompactor`, `ScriptManager`, `FileSupervisor`, or `ToolInvocation` (values or types), with an allowlist containing only the composition root. Update `context.md`: Sessions, Core → Root bridge, and Testing sections.
- Tests:
  - The boundary test passes with the allowlist fully used and no stale entries. `npx tsc -b` and the full suite pass.

# Out of scope

- The WebSocket transport, standalone server process, and reconnect (step 4).
- Multiple sessions in the UI and the CLI (step 5). `GlobalState` exists with the one implicit session.
- Incremental/diff updates. Every update carries the whole state.
