# Context

**Objective**: Extend `CompletedToolInfo` with a structured `ToolResultInfo` field that contains pre-parsed data, eliminating the need to re-parse result text strings during rendering.

Currently, render-tools parse structured info out of result text via regex on every render cycle. Since tool results are immutable after completion, this parsing should happen once at completion time.

## Current flow

1. Tool invocation resolves its `promise` with `ProviderToolResult` (text-based)
2. `ThreadCore.handleProviderStoppedWithToolUse` caches the result via `cache-tool-result`
3. `thread-view.ts` constructs `CompletedToolInfo = { request, result }` and passes to render functions
4. Render functions parse text to extract structured data (exit codes, file paths, thread IDs, etc.)

## Proposed flow

1. Tool invocation resolves with `{ result: ProviderToolResult, resultInfo: ToolResultInfo }`
2. `cache-tool-result` stores both the result and the resultInfo together
3. `CompletedToolInfo = { request, result, resultInfo }` — the structured data travels with the result
4. Render functions use pre-parsed `resultInfo` instead of regex parsing

## Key types

- `CompletedToolInfo` (`node/core/src/tool-types.ts`): extended with `resultInfo?: ToolResultInfo`
- `ToolResultInfo` (`node/core/src/tool-types.ts`): discriminated union over tool names
- `ToolInvocation` (`node/core/src/tool-types.ts`): promise resolves `{ result, resultInfo? }`
- `ToolCache` (`node/core/src/thread-core.ts`): stores `CompletedToolInfo` (not just `ProviderToolResult`)

## What each tool parses from results

### bash_command — heavy parsing

- Exit code: regex `/exit code (\d+)/` from result text
- Signal: regex `/terminated by signal (\w+)/` from result text
- Log file path + line count: regex `/Full output \((\d+) lines\): (.+)$/m`
- Output text stripped of log-file line

### edl — JSON parsing

- `EdlDisplayData`: JSON parsed from text prefixed with `EDL_DISPLAY_PREFIX`
- Formatted result text (non-display items)

### spawn_subagent — regex parsing

- Thread ID: regex `/threadId: ([a-f0-9-]+)/` and `/Sub-agent \(([a-f0-9-]+)\)/`
- Blocking status: `resultText.includes("completed:")`
- Response body: regex `/completed:\n([\s\S]*)/`

### spawn_foreach — regex parsing

- Element thread lines: regex `/ElementThreads:\n([\s\S]*?)\n\n/`
- Per-element: name, threadId, status parsed by splitting on `::`

### get_file — line counting

- Line count: `text.split("\n").length`

### diagnostics, findReferences, hover, mcp-tool, wait-for-subagents, yield-to-parent, thread-title

- No parsing from result text (only check error status or read request input)

## Relevant files

- `node/core/src/tool-types.ts` — `ToolInvocation`, `CompletedToolInfo`, new `ToolResultInfo`
- `node/core/src/tools/create-tool.ts` — `createTool()` returns `ToolInvocation`
- `node/core/src/thread-core.ts` — `handleProviderStoppedWithToolUse`, `cache-tool-result`, `ToolCache`
- `node/chat/thread-view.ts` — constructs `CompletedToolInfo`, calls render functions
- `node/render-tools/index.ts` — dispatcher to per-tool renderers
- `node/render-tools/bashCommand.ts`, `edl.ts`, `spawn-subagent.ts`, `spawn-foreach.ts`, `getFile.ts`

# Implementation

- [ ] **Step 1: Define per-tool `ResultInfo` types and extend `CompletedToolInfo`**
  - [ ] Each tool module exports its own `ResultInfo` type (following existing pattern for `Input`, `Progress`, etc.):
    - `node/core/src/tools/bashCommand.ts`: `export type ResultInfo = { toolName: "bash_command"; exitCode?: number; signal?: string; logFilePath?: string; logFileLineCount?: number; outputText: string }`
    - `node/core/src/tools/edl.ts`: `export type ResultInfo = { toolName: "edl"; displayData?: EdlDisplayData; formattedResult: string }`
    - `node/core/src/tools/spawn-subagent.ts`: `export type ResultInfo = { toolName: "spawn_subagent"; threadId?: ThreadId; isBlocking: boolean; responseBody?: string }`
    - `node/core/src/tools/spawn-foreach.ts`: `export type ResultInfo = { toolName: "spawn_foreach"; elements: Array<{ name: string; threadId?: ThreadId; ok: boolean }> }`
    - `node/core/src/tools/getFile.ts`: `export type ResultInfo = { toolName: "get_file"; lineCount: number }`
    - Other tools: `export type ResultInfo = { toolName: "<name>" }` (no extra fields)
  - [ ] In `node/core/src/tool-types.ts`, union them: `type ToolResultInfo = BashCommand.ResultInfo | Edl.ResultInfo | SpawnSubagent.ResultInfo | ...`
  - [ ] Add `resultInfo: ToolResultInfo` to `CompletedToolInfo`
  - [ ] Run type checks

- [ ] **Step 2: Update `ToolInvocation` and `ToolCache`**
  - [ ] Change `ToolInvocation.promise` to resolve `{ result: ProviderToolResult, resultInfo: ToolResultInfo }`
  - [ ] Change `ToolCache` to store `CompletedToolInfo` (or at minimum store `resultInfo` alongside results)
  - [ ] Update `cache-tool-result` action to accept and store `resultInfo`
  - [ ] Update `createTool()` return type and all call sites
  - [ ] Run type checks and fix all callers

- [ ] **Step 3: Return result info from tools**
  - [ ] `bash_command`: construct result info with exit code, signal, log file path, output text
  - [ ] `edl`: extract `EdlDisplayData` and formatted result at completion time
  - [ ] `spawn_subagent`: extract threadId, blocking status, response body at completion time
  - [ ] `spawn_foreach`: extract element thread results at completion time
  - [ ] `get_file`: count lines at completion time
  - [ ] Other tools: return a `{ toolName: "..." }` variant with no extra fields
  - [ ] Run type checks

- [ ] **Step 4: Wire result info through to render functions**
  - [ ] Update `thread-view.ts` to include `resultInfo` when constructing `CompletedToolInfo`
  - [ ] Update render-tool dispatcher functions in `node/render-tools/index.ts` to pass `resultInfo`
  - [ ] Run type checks

- [ ] **Step 5: Update render-tool implementations**
  - [ ] `bashCommand.ts`: use `resultInfo` fields instead of regex parsing
  - [ ] `edl.ts`: use `resultInfo.displayData` instead of JSON parsing
  - [ ] `spawn-subagent.ts`: use `resultInfo` fields instead of regex parsing
  - [ ] `spawn-foreach.ts`: use `resultInfo.elements` instead of regex parsing
  - [ ] `getFile.ts`: use `resultInfo.lineCount` instead of `split("\n")`

  - [ ] Run type checks

- [ ] **Step 6: Tests and verification**
  - [ ] Add unit tests for result info construction in each tool
  - [ ] Run all tests (`npx vitest run`)
  - [ ] Run type checks (`npx tsgo -b`)
  - [ ] Run lint (`npx biome check .`)
