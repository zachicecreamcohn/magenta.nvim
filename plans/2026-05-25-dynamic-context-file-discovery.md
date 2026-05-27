# Context

Implement dynamic context file discovery: whenever a file is added to the context — by any path — walk up the directory tree from that file's location and look for `context.md` and `agent.md` files. Any such files found get added to the context automatically.

Triggers (all of these):
- User action: `:Magenta context-files <path>` and `@file:<path>`
- Agent: `get_file` and any other `toolApplied` invocation (including `edl-edit`)
- Subagent spawn: `addFiles(contextFiles)` from chat.ts
- `initialFiles` populated by `autoContext` at thread creation

Cloned threads inherit their parent's already-discovered files via `buildClonedFiles`, so no fresh discovery is needed at clone time.

Rationale: context.md / agent.md files are high-value context. Being consistent about loading them means any path that brings a file into context will also pull in the directory hierarchy's documentation.

## Key types and interfaces

- `ContextManager` (`node/core/src/context/context-manager.ts`): owns `files: Files`. Exposes `addFileContext`, `addFiles`, `toolApplied`. Already emits `fileAdded` from those three when a file is new. The constructor's `initialFiles` path does NOT emit.
- `ContextManagerEvents.fileAdded`: `[absFilePath: AbsFilePath]` — reuse this; no new event needed.
- `AutoContextFile` (`node/context/auto-context.ts`): `{ absFilePath, relFilePath, fileTypeInfo }`. Reused as the result type for hierarchy discovery.
- `MagentaOptions` (`node/options.ts`): add `hierarchyContextFileNames: string[]` field with default `["context.md", "agent.md"]`. Empty array disables the feature.

## Relevant files

- `node/core/src/context/context-manager.ts` — make `addFileContext` (and `addFiles`) idempotent so the discovery listener can call `addFileContext` for already-tracked files without resetting `agentView` or re-emitting `fileAdded` (which would cause infinite recursion).
- `node/context/auto-context.ts` — add `discoverHierarchyContext(absFilePath, ctx)` that walks parent dirs and returns matching files.
- `node/chat/chat.ts` — attach a `fileAdded` listener to the new thread's `contextManager` that triggers discovery. Manually trigger discovery for the existing `initialFiles` (since the constructor doesn't emit).
- `lua/magenta/options.lua` — add `hierarchyContextFileNames` default.
- `node/options.ts` — add the option, parser entries, and merge handling.
- `node/context/context-manager.test.ts` — integration tests via `withDriver` + `setupFiles`.

# Implementation

- [ ] make `ContextManager.addFileContext` and `ContextManager.addFiles` idempotent
  - in `addFileContext`: if `this.files[absFilePath]` already exists, return early (no overwrite of `agentView`, no `fileAdded` emit)
  - in `addFiles`: inside the loop, skip files already present in `this.files`
  - unit test:
    - Behavior: calling `addFileContext` twice for the same path doesn't reset `agentView` and only emits `fileAdded` once
    - Setup: ContextManager with a file that's had `toolApplied(get-file, ...)` called on it (so `agentView` is set)
    - Actions: call `addFileContext` again for the same path; subscribe to `fileAdded`
    - Assertions: `agentView` is preserved; `fileAdded` listener was not invoked

- [ ] add `hierarchyContextFileNames: string[]` option (default `["context.md", "agent.md"]`)
  - add to `MagentaOptions` type in `node/options.ts`
  - add to defaults block
  - parse in both `parseMagentaOptions` and `parseProjectSettings`
  - add to lua defaults in `lua/magenta/options.lua`

- [ ] implement `discoverHierarchyContext` in `node/context/auto-context.ts`
  - signature:
    ```ts
    export async function discoverHierarchyContext(
      absFilePath: AbsFilePath,
      ctx: { nvim: Nvim; cwd: NvimCwd; homeDir: HomeDir; options: MagentaOptions },
    ): Promise<AutoContextFile[]>
    ```
  - logic:
    - if `options.hierarchyContextFileNames` is empty, return `[]`
    - start at `path.dirname(absFilePath)`; walk up via `path.dirname` until `parent === current` (filesystem root)
    - at each directory, `fs.promises.readdir(dir)` and pick entries whose lowercased name matches any of `hierarchyContextFileNames` (case-insensitive, matching the existing `autoContext` `nocase` semantics)
    - for each match: run `detectFileType`; if supported, push an `AutoContextFile`
    - swallow errors from unreadable dirs (debug log via `nvim.logger.debug`)
  - unit test (`node/context/auto-context.test.ts`):
    - Behavior: walking up from a nested file finds context.md at each ancestor level
    - Setup: `withDriver` with `setupFiles` creating `a/b/c/leaf.txt`, `a/b/context.md`, `a/context.md`
    - Actions: call `discoverHierarchyContext` for `a/b/c/leaf.txt`
    - Assertions: returns entries for both `a/b/context.md` and `a/context.md`

- [ ] wire up the discovery listener in `node/chat/chat.ts`
  - factor out a `triggerHierarchyDiscovery(thread, absFilePath)` helper that runs discovery and calls `addFileContext` for each result
  - immediately after `new Thread(...)`:
    - attach `thread.contextManager.on("fileAdded", (absFilePath) => void triggerHierarchyDiscovery(thread, absFilePath))`
  - for `initialFiles` (which don't emit `fileAdded`): after attaching the listener, iterate `Object.keys(thread.contextManager.files)` and call `triggerHierarchyDiscovery` for each
  - `addFiles(contextFiles)` later in the function will emit `fileAdded` per new file → listener handles it
  - clean up the listener when the thread is disposed (follow existing teardown pattern; the listener is also fine to leave if the contextManager is destroyed with the thread)


- [ ] integration test: user's `@file:` adds parent context.md
  - Behavior: typing `@file:nested/dir/file.txt` adds `nested/context.md`
  - Setup: `withDriver` with `setupFiles` creating the nested hierarchy
  - Actions: `driver.inputMagentaText("@file:nested/dir/file.txt"); driver.send();`
  - Assertions: `contextManager.files` contains both `nested/dir/file.txt` and `nested/context.md`

- [ ] integration test: agent's `get_file` adds parent context.md
  - Behavior: agent reading `nested/dir/file.txt` triggers discovery
  - Setup: `withDriver` with nested hierarchy
  - Actions: stream a `get_file` tool request for `nested/dir/file.txt`
  - Assertions: both files in context after the tool runs

- [ ] integration test: subagent spawn (`addFiles`) triggers discovery
  - Behavior: a subagent thread initialized with `contextFiles: ["nested/dir/file.txt"]` ALSO gets `nested/context.md`
  - Setup: `withDriver` with hierarchy; trigger subagent spawn with the leaf
  - Assertions: subagent's `contextManager.files` contains both files

- [ ] integration test: initialFiles (autoContext) triggers discovery
  - Behavior: a file loaded via `autoContext` pulls in its parent context.md hierarchy
  - Setup: `withDriver` with `options: { autoContext: ["nested/dir/file.txt"] }` and hierarchy
  - Assertions: after startup, both `nested/dir/file.txt` and `nested/context.md` are in context

- [ ] integration test: cloned thread inherits parent's discovered context files
  - Behavior: cloning a thread copies tracked files (including previously discovered context.md) without re-running discovery
  - Setup: `withDriver` with hierarchy; parent thread has the leaf file in context (so `nested/context.md` was discovered)
  - Actions: clone the parent thread
  - Assertions: cloned thread's `contextManager.files` contains both the leaf file and `nested/context.md`, inherited from parent

- [ ] integration test: idempotency under discovery cascade
  - Behavior: discovering a context.md doesn't infinitely re-trigger discovery
  - Setup: hierarchy where multiple ancestor levels contain context.md
  - Actions: add the leaf file
  - Assertions: each discovered file appears once in `contextManager.files`; no duplicate `fileAdded` events fire (use a spy / counter)

- [ ] integration test: `hierarchyContextFileNames: []` disables discovery
  - Behavior: empty list disables the feature
  - Setup: `withDriver` with `options: { hierarchyContextFileNames: [] }` and hierarchy
  - Actions: user manually adds `nested/dir/file.txt`
  - Assertions: only the leaf is in context; `nested/context.md` is NOT added
