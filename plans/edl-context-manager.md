let's integrate the edl with the context manager.

We should update the edl to be able to run in two modes - where it edits the files directly, and where it can be run over a string containing the file contents (like the agent's view of the file that the context manager contains)

Let's also fix up the edl to play more nicely with files we have opened in the buffer (if the buffer is more recent than what's on disk).

You can see the way this used to work for insert/replace by examining the diff with origin/main on the file: node/tools/applyEdit.ts
We also had tests at node/tools/applyEdit.test.ts

# Context

## Objective

Integrate the EDL tool with the context manager and buffer tracker so that:

1. The context manager tracks what the agent thinks files look like after EDL edits
2. EDL reads from nvim buffers when they have unsaved changes (instead of only reading from disk)
3. EDL writes back to nvim buffers when files are open (instead of only writing to disk)
4. EDL file operations are abstracted via a `FileIO` interface so the executor can also operate on in-memory strings (useful for testing)

## Relevant files and entities

- `node/edl/executor.ts`: `Executor` class - runs EDL scripts. Currently reads/writes files directly via `node:fs/promises`. Key methods: `getOrLoadFile(path)` reads files, `execute(commands)` runs all commands and writes modified files to disk at the end. `newfile` command checks `fs.access` to verify file doesn't exist.
- `node/edl/index.ts`: `runScript(script)` - parses and executes an EDL script via `new Executor()`. Returns `EdlResultData` with trace, mutations, finalSelection, fileErrors.
- `node/edl/types.ts`: `ScriptResult` - returned by `Executor.execute()`. Contains `mutations: Map<string, FileMutationSummary>` tracking which files were modified.
- `node/edl/executor.test.ts`: ~35 tests that create real files in tmpdir, run EDL scripts, and verify file contents. Will need updating if Executor constructor changes.
- `node/tools/edl.ts`: `EdlTool` class - the tool wrapper. Calls `runScript(script)`. Currently receives `{nvim, cwd, homeDir, options, myDispatch}` — does NOT receive `bufferTracker`, `threadDispatch`, or `contextManager`.
- `node/tools/create-tool.ts`: `createTool()` function and `CreateToolContext` type - wires up tool instances with their dependencies. EDL currently gets a minimal context compared to other tools like `get_file`.
- `node/context/context-manager.ts`: `ContextManager` class - tracks files in context and the agent's view of each file. `ToolApplication` type defines what tool actions the context manager understands. `updateAgentsViewOfFiles()` updates the agent's view based on tool actions.
- `node/buffer-tracker.ts`: `BufferTracker` class - tracks sync state between nvim buffers and files on disk. `getSyncInfo(absFilePath)` returns `{mtime, changeTick, bufnr}` if a buffer is tracked. `trackBufferSync(absFilePath, bufnr)` records current sync state.
- `node/nvim/buffer.ts`: `NvimBuffer` class - `getLines()` reads buffer content, `setLines()` writes content, `attemptWrite()` saves buffer to disk, `attemptEdit()` reloads buffer from disk, `getChangeTick()` returns current change tick.
- `node/tools/getFile.ts`: Example of a tool that dispatches `tool-applied` to the context manager via `threadDispatch`.
- `node/utils/buffers.ts`: Helpers `getBufferIfOpen()` and `getOrOpenBuffer()` — find or open nvim buffers by path. Useful in `BufferAwareFileIO` for locating buffers to read from / write to.

## Current gaps

1. **No context manager notification**: EDL doesn't dispatch `tool-applied`, so the context manager doesn't know about EDL file modifications. This means the context manager may send stale or redundant file content to the agent.
2. **No buffer awareness for reads**: `Executor.getOrLoadFile()` reads from disk via `fs.readFile`. If a file is open in nvim with unsaved buffer changes, those changes are ignored.
3. **No buffer awareness for writes**: `Executor.execute()` writes to disk via `fs.writeFile`. If a file is open in an nvim buffer, the buffer becomes stale. There's no reload or buffer-direct write.
4. **No buffer sync tracking**: After writing, `bufferTracker.trackBufferSync()` is not called.
5. **Tight coupling to filesystem**: The Executor directly uses `node:fs/promises` for all file I/O, making it impossible to run on in-memory strings for testing or other use cases.

# Implementation

- [x] **1. Define `FileIO` interface and `FsFileIO` default implementation**
  - [ ] Create `node/edl/file-io.ts` with:
    ```typescript
    export interface FileIO {
      readFile(path: string): Promise<string>;
      writeFile(path: string, content: string): Promise<void>;
      fileExists(path: string): Promise<boolean>;
      mkdir(path: string): Promise<void>;
    }
    ```
  - [ ] Implement `FsFileIO` class that wraps `node:fs/promises` (preserves current behavior)
  - [ ] Export both from `node/edl/file-io.ts`

- [x] **2. Refactor `Executor` to use `FileIO`**
  - [ ] Add optional `FileIO` parameter to `Executor` constructor, defaulting to `FsFileIO`
  - [ ] Replace `fs.readFile` in `getOrLoadFile()` with `this.fileIO.readFile()`
  - [ ] Replace `fs.access` in `newfile` handler with `this.fileIO.fileExists()`
  - [ ] Replace `fs.mkdir` and `fs.writeFile` in the write section of `execute()` with `this.fileIO.mkdir()` and `this.fileIO.writeFile()`
  - [ ] Verify existing executor tests still pass (they use real files, so `FsFileIO` default keeps them working)
  - [ ] Run type checks: `npx tsc --noEmit`

- [x] **3. Update `runScript` to accept optional `FileIO`**
  - [ ] Add optional `fileIO` parameter to `runScript(script, fileIO?)`
  - [ ] Pass it through to `new Executor(fileIO)`
  - [ ] No behavior change for existing callers (they pass no fileIO, get FsFileIO default)

- [x] **4. Implement `BufferAwareFileIO`**
  - [ ] Create `node/tools/buffer-file-io.ts` with `BufferAwareFileIO` implementing `FileIO`
  - [ ] Constructor takes `{ nvim, bufferTracker, cwd, homeDir }`
  - [ ] `readFile(path)`:
    - Resolve path to `AbsFilePath` via `resolveFilePath(cwd, path, homeDir)`
    - Check `bufferTracker.getSyncInfo(absPath)`
    - If buffer exists, compare `changeTick` to detect unsaved changes
    - If buffer has unsaved changes, read from buffer via `NvimBuffer.getLines()`
    - Otherwise, fall through to `fs.readFile` from disk
  - [ ] `writeFile(path, content)`:
    - Resolve path to `AbsFilePath`
    - Check `bufferTracker.getSyncInfo(absPath)`
    - If buffer is open: write content to buffer via `NvimBuffer.setLines()`, then save to disk via `NvimBuffer.attemptWrite()`, then `bufferTracker.trackBufferSync()`
    - If buffer is not open: write to disk via `fs.writeFile`
  - [ ] `fileExists(path)`: resolve path, use `fs.access`
  - [ ] `mkdir(path)`: resolve path, use `fs.mkdir`
  - [ ] Run type checks

- [x] **5. Add `edl-edit` ToolApplication type to context manager**
  - [ ] Add new variant to `ToolApplication` in `node/context/context-manager.ts`:
    ```typescript
    | { type: "edl-edit"; content: string }
    ```
  - [ ] Add handler in `updateAgentsViewOfFiles()`:
    ```typescript
    case "edl-edit":
      fileInfo.agentView = { type: "text", content: tool.content };
      return;
    ```
  - [ ] Run type checks (assertUnreachable will catch any missed switch cases)

- [x] **6. Wire up `EdlTool` with buffer tracker and context manager**
  - [ ] In `node/tools/create-tool.ts`, pass additional context to EdlTool:
    - Add `bufferTracker`, `threadDispatch` to the EdlTool context
  - [ ] Update `EdlTool` constructor context type in `node/tools/edl.ts` to accept `bufferTracker` and `threadDispatch`
  - [ ] In `EdlTool.executeScript()`:
    - Create `BufferAwareFileIO` with the tool's context
    - Pass it to `runScript(script, fileIO)`
    - After successful execution, iterate over `result.data.mutations` and for each modified file:
      - Resolve the path to `AbsFilePath`
      - Get the final file content (need to expose this from the executor - see sub-step)
      - Dispatch `tool-applied` via `threadDispatch` with `{ type: "edl-edit", content: finalContent }`
  - [ ] Expose modified file contents from the executor: add modified file content to `EdlResultData.mutations` entries (add a `content` field alongside `summary`)
  - [ ] Run type checks

- [x] **7. Write tests**
  - [ ] Add unit test for `BufferAwareFileIO`:
    - Test reading from buffer when buffer has unsaved changes
    - Test reading from disk when buffer is in sync
    - Test writing to buffer when buffer is open
    - Test writing to disk when no buffer is open
  - [ ] Add integration test: EDL edit updates context manager's agent view
    - Send a message, respond with EDL tool use that edits a file in context
    - Verify that on the next user message, no redundant full-file context update is sent (only a diff if the file changed further, or nothing if unchanged)
  - [ ] Add integration test: EDL edit with file open in buffer
    - Open a file in nvim buffer, make unsaved edits
    - Run EDL that reads and modifies that file
    - Verify the EDL read the buffer content (not disk content)
    - Verify the buffer was updated with the EDL result
    - Verify the buffer was saved to disk
  - [ ] Run tests: `npx vitest run`
  - [ ] Iterate until tests pass
