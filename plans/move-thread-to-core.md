# Context

**Objective:** Move the core logic of `node/chat/thread.ts` into `@magenta/core`, leaving only neovim-specific wrappers and view code in the root project.

## Current state of `Thread` class

`Thread` (~1300 lines in `node/chat/thread.ts`) is the main conversation controller. It combines:

1. **Core conversation logic** (portable): message sending, tool dispatch, auto-respond, compaction, abort, tool result handling, agent lifecycle
2. **Neovim-specific code**: `openFileInNonMagentaWindow`, `playChimeSound` (play-sound), `Nvim` logger access, sidebar scroll dispatch
3. **View-specific state**: `showSystemPrompt`, `messageViewState`, `toolViewState`, `compactionViewState` — UI expansion toggles
4. **View-specific messages**: `toggle-expand-content`, `toggle-expand-update`, `toggle-tool-details`, `toggle-system-prompt`, `open-edit-file`, `toggle-compaction-record`, `toggle-compaction-step`

## Key types already in core

- `ThreadId`, `ThreadType` — `node/core/src/chat-types.ts`
- `Agent`, `AgentMsg`, `AgentStatus`, `ProviderMessage`, `StopReason`, etc. — `node/core/src/providers/provider-types.ts`
- `ToolRequestId`, `ToolName`, `ToolRequest`, `ToolInvocation`, `createTool`, `getToolSpecs` — `@magenta/core`
- `FileIO`, `Shell`, `LspClient`, `DiagnosticsProvider`, `ContextTracker`, `ThreadManager` — core capabilities
- `ProviderProfile`, `ProviderOptions` — `node/core/src/provider-options.ts`
- `Provider`, `getProvider` — `node/core/src/providers/provider.ts`
- `EdlRegisters` — `@magenta/core`
- `getSubsequentReminder` — `node/core/src/providers/system-reminders.ts`
- `getContextWindowForModel` — `node/core/src/providers/anthropic-agent.ts`
- `SystemPrompt` — `node/core/src/providers/system-prompt.ts`

## Types NOT yet in core (needing interfaces or migration)

- `ContextManager` — root-only class with nvim deps. Thread uses: `getContextUpdate()`, `contextUpdatesToContent()`, `addFiles()`, `update()`, and it implements `ContextTracker`
- `CompactionManager` — root-only, depends on `Nvim`, `Environment`, `Chat`
- `CommandRegistry` — root-only, processes `@file`, `@diff`, etc. commands. Moved to magenta.ts — preprocessing happens before dispatching to Thread.
- `Profile` — structurally identical to `ProviderProfile` in core. Immutable per-thread (set at construction via `context.profile`). Profile changes via `:Magenta profile` only affect future threads.
- `MagentaOptions` — root-only, but core already has `ProviderOptions` for the subset it needs
- `Environment` — root-only interface wrapping core capabilities
- `PermissionCheckingFileIO` / `PermissionCheckingShell` — root-only, nvim-dependent
- `Dispatch<RootMsg>` — root-only tea system type
- `Nvim` — root-only
- `Chat` — root-only, but implements core's `ThreadManager`

## Relevant files

- `node/chat/thread.ts` — the class being split
- `node/chat/thread-view.ts` — view code (stays in root, reads Thread state)
- `node/chat/chat.ts` — creates Threads, forwards messages, implements ThreadManager
- `node/chat/compaction-manager.ts` — compaction logic (stays root for now)
- `node/chat/commands/registry.ts` — command processing (moved to magenta.ts)
- `node/chat/thread-supervisor.ts` — supervisor interface (already small, could move to core)
- `node/chat/types.ts` — root ThreadId/ThreadType (should use core's)
- `node/core/src/chat-types.ts` — core ThreadId/ThreadType
- `node/environment.ts` — Environment interface and factories
- `node/core/src/provider-options.ts` — core's ProviderProfile/ProviderOptions
- `node/core/src/providers/provider.ts` — core's getProvider

## Design approach

**Two-class split: ThreadCore (core) + Thread (root wrapper)**

**ThreadCore** (`@magenta/core`) is a pure logic class with:

- **Method-based API**: `sendMessage()`, `abort()`, `startCompaction()`, `handleAgentMsg()`, etc. — no message dispatch, no `update(msg)` pattern
- **Callback-based events**: A single `onUpdate: () => void` callback that fires whenever core state changes (triggers re-render in the wrapper). Plus targeted callbacks for side effects: `onPlayChime`, `onScrollToLastMessage`, `onSetupResubmit`
- **Direct state access**: `core.state` is a public object the wrapper reads directly (for rendering). Core mutates it and calls `onUpdate()` to notify.
- **No dispatch dependency**: ThreadCore never dispatches messages. It calls methods on injected interfaces (ThreadManager, ContextProvider) and signals changes via callbacks.

**Thread** (root) is a thin wrapper that:

- Owns the `ThreadCore` instance and view-only state (`showSystemPrompt`, `messageViewState`, `toolViewState`, `compactionViewState`)
- Implements `update(msg)` for the TEA/dispatch system — view messages handled locally, core messages translated to ThreadCore method calls
- Wires callbacks: `onUpdate → dispatch tool-progress (triggers re-render)`, `onPlayChime → playChimeSound()`, `onScrollToLastMessage → dispatch sidebar-msg`, `onSetupResubmit → dispatch sidebar-msg`
- Creates adapters: `ContextManager → ContextProvider`, `CompactionManager → CompactionController`
- Exposes ThreadCore state for views: `thread.core.state.title`, `thread.core.agent`, etc.

This means the dispatch system is entirely a root concern. Core code never sees `Dispatch<RootMsg>` or message types like `thread-msg`.

# Implementation

## Pre-work (completed)

- [x] Remove `update-profile` msg — profile is now immutable per-thread, set at construction via `context.profile`
- [x] Remove `state.profile` — all reads use `this.context.profile`
- [x] Move `CommandRegistry` to `magenta.ts` — preprocessing (@fork, @compact, @async, @file, etc.) happens before dispatching to Thread
- [x] Thread's `prepareUserContent` simplified — just maps InputMessage to ProviderMessageContent, no command processing
- [x] Thread's `handleSendMessageMsg` simplified — no @fork/@compact/@async detection, receives `async` flag from caller
- [x] Added `start-compaction` msg type for explicit compaction dispatch
- [x] Context files preserved across compaction via `contextFiles` parameter
- [x] Tests updated for new behavior

## Phase 0: Move ContextManager core logic to `@magenta/core`

ContextManager currently mixes core file-tracking logic with nvim view code. Split it so ThreadCore can own a core ContextManager directly.

**Core logic** (move to `node/core/src/context/context-manager.ts`):

- Types: `ToolApplication`, `Files`, `Patch`, `FileUpdate`, `WholeFileUpdate`, `DiffUpdate`, `FileDeletedUpdate`, `FileUpdates`
- State: `files: Files`
- Public methods (direct calls, no dispatch):
  - `addFileContext(absFilePath, relFilePath, fileTypeInfo)` — adds a file to tracking
  - `removeFileContext(absFilePath)` — removes a file from tracking
  - `toolApplied(absFilePath, tool, fileTypeInfo)` — records a tool's view of a file
  - `addFiles(filePaths)` — bulk add by unresolved paths (resolves + detects types)
  - `reset()` — clears agent views
  - `getContextUpdate()` — computes diffs/updates for all tracked files
  - `contextUpdatesToContent(updates)` — converts FileUpdates to provider message content
- Internal: `getFileMessageAndUpdateAgentViewOfFile`, `handleTextFileUpdate`, `handleBinaryFileUpdate`, `updateAgentsViewOfFiles`
- No `Msg` type, no `update(msg)` method — pure method-based API
- Dependencies (all already in core): `FileIO`, `AbsFilePath`, `RelFilePath`, `UnresolvedFilePath`, `NvimCwd`, `HomeDir`, `FileCategory`, `FileTypeInfo`, `detectFileType`, `resolveFilePath`, `relativePath`, `ProviderMessageContent`, `Result`, `assertUnreachable`, `getSummaryAsProviderContent`, `diff` (npm)
- Needs `Logger` instead of `Nvim` (for `addFiles` warnings)

**Root wrapper** (stays in `node/context/context-manager.ts`):

- Re-exports core types
- Keeps `Msg` type and `update(msg)` for TEA compatibility — translates messages to core method calls
- `view()`, `renderContextUpdate()`, `formatPdfInfo`, `formatPageRanges` — all view rendering
- `open-file` handler (calls `openFileInNonMagentaWindow` or `open`)
- Constructor creates core instance with `nvim.logger` as Logger

**Steps:**

- [x] Create `node/core/src/context/context-manager.ts` with core logic, taking `Logger` + `FileIO` + path utils
- [x] Export core ContextManager and types from core index
- [x] Refactor root `node/context/context-manager.ts` to extend/wrap core ContextManager
  - Root adds `open-file` message handling, view methods
  - Root constructor creates core instance with `nvim.logger` as Logger
- [x] Update imports across codebase (most callers just need types, which get re-exported)
- [x] Verify `ContextTracker` in core still works (core ContextManager implements it)
- [x] Check for type errors and run tests

## Phase 1: Prepare core interfaces

- [x] Move `ThreadSupervisor` and `SupervisorAction` types to core (they have no nvim deps)
- [x] Create a `CompactionController` interface in core for the compaction lifecycle:
  ```typescript
  export interface CompactionController {
    start(messages: ReadonlyArray<ProviderMessage>, nextPrompt?: string): void;
    handleAgentMsg(msg: AgentMsg): void;
  }
  ```
- [x] Check for type errors and iterate until they pass

Note: `ContextProvider` interface is no longer needed — ThreadCore uses core's ContextManager directly (moved in Phase 0). `FileUpdates` and related types also already in core from Phase 0.

## Phase 2: Build `ThreadCore` in core

- [x] Create `node/core/src/thread-core.ts`
- [x] Define `ThreadCoreCallbacks` — event callbacks the wrapper provides:
  ```typescript
  interface ThreadCoreCallbacks {
    onUpdate: () => void; // core state changed, trigger re-render
    onPlayChime: () => void; // agent stopped, needs user attention
    onScrollToLastMessage: () => void; // user message sent, scroll sidebar
    onSetupResubmit: (lastUserMessage: string) => void; // error recovery
  }
  ```
- [x] Define `ThreadCoreContext` — injected dependencies (no nvim, no dispatch):
  ```typescript
  interface ThreadCoreContext {
    logger: Logger;
    profile: ProviderProfile;
    cwd: string;
    homeDir: string;
    threadType: ThreadType;
    systemPrompt: SystemPrompt;
    mcpToolManager: MCPToolManagerImpl;
    contextManager: ContextManager; // core's ContextManager from Phase 0
    threadManager: ThreadManager;
    fileIO: FileIO;
    shell: Shell;
    lspClient: LspClient;
    diagnosticsProvider: DiagnosticsProvider;
    availableCapabilities: Set<ToolCapability>;
    environmentConfig: EnvironmentConfig;
    maxConcurrentSubagents: number;
    container?: ContainerConfig;
    getProvider: (profile: ProviderProfile) => Provider;
    createCompactionController: (
      onComplete: (result: CompactionResult) => void,
    ) => CompactionController;
  }
  ```
- [x] `ThreadCore` public API — methods, not messages:
  - `sendMessage(messages: InputMessage[], opts?: { async?: boolean })` — the main entry point
  - `startCompaction(nextPrompt?: string, contextFiles?: string[])` — explicit compaction
  - `abort()` — returns `Promise<void>`
  - `setTitle(title: string)` — direct state mutation
  - `handleAgentMsg(msg: AgentMsg)` — called by wrapper when agent dispatches
  - `handleCompactAgentMsg(msg: AgentMsg)` — forwarded to compaction controller
  - `getProviderStatus()`, `getProviderMessages()`, `getMessages()`, `getLastStopTokenCount()`
- [x] Core state — all conversation state lives here, wrapper reads it:
  ```typescript
  state: {
    title?: string;
    threadType: ThreadType;
    systemPrompt: SystemPrompt;
    pendingMessages: InputMessage[];
    mode: ConversationMode;
    toolCache: ToolCache;
    edlRegisters: EdlRegisters;
    outputTokensSinceLastReminder: number;
    yieldedResponse?: string;
    teardownMessage?: string;
    tornDown?: boolean;
    compactionHistory: CompactionRecord[];
  }
  ```
- [x] Move core methods from current Thread:
  - `createFreshAgent`, `handleSendMessageMsg` (becomes internal to `sendMessage`)
  - `handleProviderStopped`, `handleProviderStoppedWithToolUse`, `handleErrorState`
  - `maybeAutoRespond`, `submitToolResultsAndStop`, `sendToolResultsAndContinue`
  - `sendMessage` (internal), `sendRawMessage`, `prepareUserContent`
  - `getAndPrepareContextUpdates`, `rebuildToolCache`
  - `shouldAutoCompact`, `startCompaction`, `handleCompactionResult`, `handleCompactComplete`
  - `resetContextManager` (calls `contextManager.reset()` + `contextManager.addFiles()`)
  - `setThreadTitle` (uses `context.getProvider`)
- [x] Replace dispatch calls with callbacks:
  - `this.context.dispatch({ type: "sidebar-msg", msg: { type: "scroll-to-last-user-message" } })` → `callbacks.onScrollToLastMessage()`
  - `this.context.dispatch({ type: "sidebar-msg", msg: { type: "setup-resubmit", ... } })` → `callbacks.onSetupResubmit(text)`
  - `playChimeIfNeeded()` → `callbacks.onPlayChime()`
  - `this.context.dispatch({ type: "thread-msg", ... msg: { type: "tool-progress" } })` → `callbacks.onUpdate()`
- [x] Agent creation: ThreadCore creates the Agent internally, passing a callback that calls `this.handleAgentMsg(msg)` directly (no dispatch round-trip)
- [x] Export `ThreadCore`, `ThreadCoreContext`, `ThreadCoreCallbacks`, `InputMessage`, `ConversationMode`, `ToolCache`, `CompactionRecord`, `CompactionStep` from core index
- [x] Check for type errors and iterate until they pass

## Phase 3: Refactor root `Thread` to wrap `ThreadCore`

- [ ] Slim down `node/chat/thread.ts`:
  - `Thread` owns a `public core: ThreadCore` instance
  - Thread constructor creates `ThreadCoreContext` from its nvim-aware context:
    - `contextManager`: core ContextManager instance (root wrapper creates it, passes to ThreadCore)
    - `createCompactionController`: factory that creates `CompactionManager` with nvim deps
    - `getProvider`: wraps `getProvider(nvim, profile)`
    - `logger`: `context.nvim.logger`
  - Thread constructor creates `ThreadCoreCallbacks`:
    - `onUpdate`: dispatches `tool-progress` to trigger re-render
    - `onPlayChime`: calls `playChimeSound()`
    - `onScrollToLastMessage`: dispatches `sidebar-msg` scroll
    - `onSetupResubmit`: dispatches `sidebar-msg` setup-resubmit
  - View-only state stays on Thread: `showSystemPrompt`, `messageViewState`, `toolViewState`, `compactionViewState`
  - `Thread.myUpdate(msg)`:
    - View messages (`toggle-*`, `open-edit-file`): handled locally
    - `send-message` → `this.core.sendMessage(msg.messages, { async: msg.async })`
    - `start-compaction` → `this.core.startCompaction(msg.nextPrompt, msg.contextFiles)`
    - `abort` → `this.core.abort()`
    - `set-title` → `this.core.setTitle(msg.title)`
    - `agent-msg` → `this.core.handleAgentMsg(msg.msg)`
    - `compact-agent-msg` → `this.core.handleCompactAgentMsg(msg.msg)`
    - `context-manager-msg` → `this.contextManager.update(msg.msg)` (stays on wrapper, feeds ContextProvider)
    - `permission-pending-change`, `tool-progress` → no-op (re-render from dispatch)
  - Keep `playChimeSound()` on Thread (nvim-specific, uses `play-sound`)
  - Keep `contextManager` on Thread (wrapper owns it, exposes as ContextProvider to core)
  - `permissionFileIO`, `permissionShell` stay on Thread (nvim-specific permission UI)
- [ ] Update external reads: callers that access `thread.state.title` → `thread.core.state.title`, `thread.agent` → `thread.core.agent`, etc.
- [ ] Update `chat.ts`:
  - `handleForkThread`: clone `thread.core.agent` instead of `thread.agent`
  - Thread creation passes through to same constructor (which now creates ThreadCore internally)
  - `getThreadResult` reads from `thread.core`
- [ ] Update `thread-view.ts`:
  - Core state reads: `thread.core.state.title`, `thread.core.state.mode`, `thread.core.getProviderMessages()`, etc.
  - View state reads: `thread.state.showSystemPrompt`, `thread.state.messageViewState`, etc.
- [ ] Check for type errors and iterate until they pass

## Phase 4: Align shared types

- [ ] Update root `node/chat/types.ts` to re-export from core (`ThreadId`, `ThreadType`) instead of redefining
- [ ] Make sure `Profile` aligns with `ProviderProfile` when passed to core
- [ ] Move `EnvironmentConfig` to core (it's a simple discriminated union with no nvim deps)
- [ ] Check for type errors and iterate until they pass

## Phase 5: Tests

- [ ] Write unit tests for `ThreadCore` in `node/core/src/thread-core.test.ts` using mock provider
  - Test message sending flow (sendMessage → agent receives content)
  - Test tool dispatch and auto-respond (handleAgentMsg → tool_use → auto-respond)
  - Test abort flow (abort → agent aborted, tools aborted)
  - Test compaction trigger (shouldAutoCompact → startCompaction)
  - Test callbacks fire correctly (onUpdate, onPlayChime, onScrollToLastMessage)
- [ ] Run existing integration tests to make sure wrapper behavior unchanged: `npx vitest run`
- [ ] Iterate until all tests pass
