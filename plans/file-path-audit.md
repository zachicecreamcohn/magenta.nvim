# File Path Audit Plan

## Context

The goal is to ensure consistent file path handling:

1. **Agent communication**: Always send absolute file paths to/from the agent
2. **User display**: Use relative paths when inside cwd, absolute paths with `~` shortening when outside cwd
3. **Agent instructions**: Encourage the agent to use absolute file paths when calling tools

### Relevant Files and Entities

**Core types** (`node/utils/files.ts`):

- `AbsFilePath`, `RelFilePath`, `UnresolvedFilePath`, `HomeDir`, `NvimCwd`
- `resolveFilePath()`, `relativePath()`

**Files sending paths TO agent (tool results, context updates, messages):**

- `node/tools/findReferences.ts:179` - Returns `relFilePath` in tool result
- `node/tools/listDirectory.ts:102` - Returns `relFilePath` in tool result
- `node/tools/applyEdit.ts` - Error messages use `relFilePath`
- `node/utils/pdf-pages.ts:76` - `getSummaryAsProviderContent` uses `relFilePath`
- `node/context/context-manager.ts` - `contextUpdatesToContent` uses `relFilePath`
- `node/edit-prediction/edit-prediction-controller.ts:662` - `composeUserMessage` uses `bufferRelPath`
- `node/change-tracker.ts:45` - Stores `RelFilePath` (used by edit-prediction)
- `node/inline-edit/inline-edit-app.ts:420,437` - Uses `relativePath`/`path.relative` in messages to agent
- `node/magenta.ts:417` - "paste-selection" command uses `relFileName`
- `node/utils/diagnostics.ts` - Uses paths from nvim's ls output (format TBD)

**Files displaying paths to user:**

- `node/tools/getFile.ts` - `formatGetFileDisplay` uses raw `input.filePath`
- `node/tools/replace.ts` - `renderSummary`, `renderCompletedSummary`, etc. use `input.filePath`
- `node/tools/insert.ts` - Similar to replace.ts
- `node/tools/hover.ts` - Uses `input.filePath`
- `node/tools/findReferences.ts` - Uses `input.filePath`
- `node/tools/listDirectory.ts` - Uses `input.dirPath`
- `node/context/context-manager.ts` - `view()` uses `relFilePath`

**Tool specs (instructions to agent):**

- `node/tools/getFile.ts`, `replace.ts`, `insert.ts`, `hover.ts`, `findReferences.ts`, `listDirectory.ts`

## Implementation

### Phase 1: Add utility functions

- [x] Add `displayPath` function to `node/utils/files.ts`:
  - Takes `cwd: NvimCwd`, `absFilePath: AbsFilePath`, `homeDir: HomeDir`
  - If relative path doesn't start with `..`, return `RelFilePath`
  - Otherwise return `AbsFilePath` with `homeDir` replaced by `~`
  - Add a new branded type `DisplayPath` for this
- [x] Run type checks to ensure no errors

### Phase 2: Update tool specs to encourage absolute paths

- [x] Update `node/tools/getFile.ts` spec:
  - Change description to encourage absolute paths
- [x] Update `node/tools/replace.ts` spec:
  - Change description to encourage absolute paths
- [x] Update `node/tools/insert.ts` spec:
  - Change description to encourage absolute paths
- [x] Update `node/tools/hover.ts` spec:
  - Change description to encourage absolute paths
- [x] Update `node/tools/findReferences.ts` spec:
  - Change description to encourage absolute paths
- [x] Update `node/tools/listDirectory.ts` spec:
  - Change description to encourage absolute paths
- [x] Run type checks to ensure no errors

### Phase 3: Update tool results sent to agent (use absolute paths)

- [x] Update `node/tools/findReferences.ts:179`:
  - Change `content += \`${relFilePath}:...\``to use`absFilePath` instead
- [x] Update `node/tools/listDirectory.ts:102`:
  - Change `results.push(relFilePath...)` to use `absFilePath` instead
- [x] Update `node/tools/applyEdit.ts`:
  - Change error messages to use `absFilePath` instead of `relFilePath`
- [x] Update `node/utils/pdf-pages.ts:76`:
  - Change `getSummaryAsProviderContent` to use `absFilePath` (or remove relFilePath param)
- [x] Update `node/context/context-manager.ts`:
  - In `contextUpdatesToContent`, use `absFilePath` instead of `relFilePath` in text sent to agent
- [x] Update `node/edit-prediction/edit-prediction-controller.ts`:
  - In `composeUserMessage`, use absolute path instead of `bufferRelPath`
- [x] Update `node/change-tracker.ts`:
  - Store `AbsFilePath` instead of `RelFilePath` in `TextChange`
- [x] Update `node/inline-edit/inline-edit-app.ts`:
  - Lines 420 and 437: use absolute path instead of relative
- [x] Update `node/magenta.ts:417`:
  - In "paste-selection" command, use absolute path instead of `relFileName`
- [x] Update `node/utils/diagnostics.ts`:
  - `bufMap[d.bufnr]` comes from nvim's `:buffers` output which can be relative or absolute
  - Resolve paths to absolute using `resolveFilePath` before sending to agent
- [x] Run type checks to ensure no errors

### Phase 4: Update user-facing displays (use displayPath)

- [x] Update `node/tools/getFile.ts`:
  - Add context needed for `displayPath` (cwd, homeDir)
  - Update `formatGetFileDisplay` to use `displayPath`
- [x] Update `node/tools/replace.ts`:
  - Update `renderSummary`, `renderCompletedSummary`, `renderReplacePreview`, `renderReplaceDetail`, `renderStreamedBlock` to use `displayPath`
- [x] Update `node/tools/insert.ts`:
  - Update render methods to use `displayPath`
- [x] Update `node/tools/hover.ts`:
  - Update render methods to use `displayPath`
- [x] Update `node/tools/findReferences.ts`:
  - Update `renderSummary`, `renderCompletedSummary` to use `displayPath`
- [x] Update `node/tools/listDirectory.ts`:
  - Update render methods to use `displayPath`
- [x] Update `node/context/context-manager.ts`:
  - In `view()`, use `displayPath` instead of `relFilePath`
  - In `renderContextUpdate`, use `displayPath` for user display
- [x] Run type checks to ensure no errors

### Phase 5: Testing

- [ ] Test file path display for files inside cwd (should show relative path)
- [ ] Test file path display for files outside cwd (should show ~/... or /abs/path)
- [ ] Test that agent receives absolute paths in tool results
- [ ] Run existing tests to ensure nothing is broken
