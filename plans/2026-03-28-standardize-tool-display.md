# context

## Objective

Standardize how all tools are displayed in the chat view with a consistent 3-section layout:

1. **Summary line** (always visible, derived from `tool_use` request only)
2. **Progress preview** (shown while tool is in-flight, supports expand/detail interaction)
3. **Tool result** (shown when tool is done, on a separate line, supports expand/detail interaction)

Currently, the display conflates summary with progress/result state — summaries change emoji and content based on whether the tool succeeded or failed, and there's no clear separation between the "what was requested" summary and the "what happened" result. Additionally, tools have a single `details: boolean` toggle that mixes expansion of progress preview and result.

## Current Architecture

### View flow (thread-view.ts:488-598)

For each `tool_use` content block, the current code:

- Checks if the tool is **active** (in `activeTools` map) → renders `InFlightSummary` + (`InFlightDetail` if expanded, else `InFlightPreview`)
- Checks if the tool is **completed** (in `toolCache`) → renders `CompletedSummary` + (`CompletedDetail` if expanded, else `CompletedPreview`)

### Render dispatch (render-tools/index.ts)

Six functions route to per-tool renderers:

- `renderInFlightToolSummary`, `renderInFlightToolPreview`, `renderInFlightToolDetail`
- `renderCompletedToolSummary`, `renderCompletedToolPreview`, `renderCompletedToolDetail`

### Per-tool renderers (render-tools/\*.ts)

Each tool exports some subset of: `renderInFlightSummary`, `renderInFlightPreview`, `renderInFlightDetail`, `renderCompletedSummary`, `renderCompletedPreview`, `renderCompletedDetail`.

### View state (thread.ts)

`ToolViewState = { details: boolean }` — a single toggle per tool.

### Key types

- `ToolRequest = { id, toolName, input: unknown }` — the request
- `CompletedToolInfo = { request, result, structuredResult }` — completed tool data
- `ActiveToolEntry = { handle, progress, toolName, request }` — in-flight tool data
- `DisplayContext = { cwd, homeDir }` — for path display helpers

## Key Files

- `node/chat/thread-view.ts` — main tool rendering logic (lines 488-598)
- `node/render-tools/index.ts` — render dispatch hub (6 functions)
- `node/render-tools/bashCommand.ts` — most complex tool renderer (264 lines)
- `node/render-tools/edl.ts` — EDL renderer with mutation summaries
- `node/render-tools/getFile.ts` — simple tool renderer
- `node/render-tools/hover.ts` — simple tool renderer
- `node/render-tools/findReferences.ts` — simple tool renderer
- `node/render-tools/diagnostics.ts` — simple tool renderer
- `node/render-tools/mcp-tool.ts` — MCP tool renderer
- `node/render-tools/spawn-subagent.ts` — complex renderer with navigation
- `node/render-tools/spawn-foreach.ts` — complex renderer with per-element status
- `node/render-tools/wait-for-subagents.ts` — complex renderer
- `node/render-tools/thread-title.ts` — simple renderer
- `node/render-tools/yield-to-parent.ts` — simple renderer
- `node/render-tools/streaming.ts` — streaming (partial) tool rendering
- `node/chat/thread.ts` — `ToolViewState` type, `toggle-tool-details` handler

## Proposed New Architecture

### Display Layout

```
<tool emoji> <one-line summary from tool_use request>     ← always visible (no status indicator)
<tool_use input preview OR input detail>                 ← always visible (if defined for tool), toggles between preview/detail
<progress preview OR progress detail>    ← only when in-flight
<status emoji> <result summary>                          ← only when completed (✅/❌)
<result preview OR result detail>                        ← only when completed (if defined for tool)
```

### Summary Line

- Derived **only** from the `tool_use` request (not from progress or result)
- Shows: tool identification emoji + tool name/description + key input parameters
- Tool emoji identifies _which_ tool (⚡ bash, 👀 get_file, 📝 edl, 🔍 hover, etc.) — no status indicator here
- Toggling `<CR>` shows full input JSON below — handled by the parent (thread-view.ts), not per-tool renderers

### Input Preview (always visible if defined)

- Shows a rich preview of the tool_use request input, customizable per tool
- Examples:
  - bash_command: the command in a code block
  - edl: abridged EDL script in a code block
  - get_file: formatted file path with line range
  - hover/find_references: symbol + file path
  - spawn_subagent: truncated prompt + agent type
  - Default: first few lines of JSON.stringify
- Toggling `<CR>` switches to detail view (custom expanded view)

### Progress (in-flight only, if defined)

- Shown below input while tool is executing
- Default: compact preview (e.g., last 10 lines of bash output)
- Expanded: full detail (e.g., all bash output so far)
- Each tool can provide its own progress preview/detail, or default to empty

### Result Summary (completed only, always visible)

- status emoji (✅/❌) + one-line description of the result
- Toggling `<CR>` shows full result JSON below — handled by the parent (thread-view.ts), not per-tool renderers

### Result Preview (completed only, if defined)

- Below the summary: compact preview (e.g., truncated output)
- Each tool can provide its own result preview/detail, or default to empty

### View State

Replace `ToolViewState = { details: boolean }` with:

```typescript
type ToolViewState = {
  inputSummaryExpanded: boolean; // display full input json below input summary line
  inputExpanded: boolean; // expand tool_use input view
  progressExpanded: boolean; // expand progress view
  resultSummaryExpanded: boolean; // display full result json below result summary line
  resultExpanded: boolean; // expand result view
};
```

### Render Functions

Replace the current 6 functions with a clearer set. Each section is a **single render function** that accepts `expanded: boolean` and decides internally what to show:

**Summary (from request only):**

- `renderToolSummary(request, displayContext)` → one-line summary (no expanded state, always the same)

**Input (always visible if defined):**

- `renderToolInput(request, displayContext, expanded)` → when collapsed: rich preview; when expanded: full detail

**Progress (in-flight only):**

- `renderToolProgress(request, progress, context, expanded)` → when collapsed: compact preview; when expanded: full detail

**Result summary (completed only):**

- `renderToolResultSummary(info, context)` → status emoji + one-line result description (no expanded state)

**Result (completed only, if defined):**

- `renderToolResult(info, context, expanded)` → when collapsed: compact preview; when expanded: full detail

# implementation

- [ ] **Step 1: Update ToolViewState type and toggle handling**
  - [ ] In `node/chat/thread.ts`, change `ToolViewState` from `{ details: boolean }` to `{ inputSummaryExpanded, inputExpanded, progressExpanded, resultSummaryExpanded, resultExpanded }`
  - [ ] Replace `toggle-tool-details` message with five separate messages: `toggle-tool-input-summary`, `toggle-tool-input`, `toggle-tool-progress`, `toggle-tool-result-summary`, `toggle-tool-result` (each with `toolRequestId`)
  - [ ] Update thread.ts `Msg` type to include the new toggle messages
  - [ ] Update the `myUpdate` handler for the new toggle messages
  - [ ] Check for type errors and iterate until they pass

- [ ] **Step 2: Refactor render-tools/index.ts dispatch functions**
  - [ ] Replace `renderInFlightToolSummary` and `renderCompletedToolSummary` with `renderToolSummary(request, displayContext)` — request only
  - [ ] Add `renderToolInput(request, displayContext, expanded)` — single function, shows preview or detail based on `expanded`
  - [ ] Replace `renderInFlightToolPreview`/`renderInFlightToolDetail` with `renderToolProgress(request, progress, context, expanded)`
  - [ ] Add `renderToolResultSummary(info, context)` — status emoji + one-line result description
  - [ ] Replace `renderCompletedToolPreview`/`renderCompletedToolDetail` with `renderToolResult(info, context, expanded)`
  - [ ] Check for type errors and iterate until they pass

- [ ] **Step 3: Reorganize individual tool renderers into new render functions**
  - [ ] For each tool renderer file, reorganize existing rendering code into up to 5 functions. Preserve as much existing render code as possible — this is a reorganization, not a rewrite.
  - [ ] `renderSummary(request, displayContext)` — one-line description from the request only. Extract from existing `renderInFlightSummary`/`renderCompletedSummary`, removing status/progress/result dependencies.
  - [ ] `renderInput(request, displayContext, expanded)` — rich input view. Collapsed: reuse existing input formatting (e.g., bash code block, edl abridged script). Expanded: full detail. New function for most tools.
  - [ ] `renderProgress(request, progress, context, expanded)` — reuse existing `renderInFlightPreview`/`renderInFlightDetail` code. Only for tools that had in-flight views (bash_command, spawn_subagent, spawn_foreach, wait_for_subagents).
  - [ ] `renderResultSummary(info)` — new one-line result description. Extract status info from existing `renderCompletedSummary` (e.g., exit code, line count, mutation count). Status emoji (✅/❌) added by dispatch layer.
  - [ ] `renderResult(info, context, expanded)` — reuse existing `renderCompletedPreview`/`renderCompletedDetail` code.
  - [ ] Tool identification emoji (⚡/👀/📝/🔍/etc.) added by dispatch layer in index.ts, not by individual tools
  - [ ] Files to update: bashCommand.ts, edl.ts, getFile.ts, hover.ts, findReferences.ts, diagnostics.ts, mcp-tool.ts, spawn-subagent.ts, spawn-foreach.ts, wait-for-subagents.ts, thread-title.ts, yield-to-parent.ts
  - [ ] Check for type errors and iterate until they pass

- [ ] **Step 4: Update thread-view.ts composition**
  - [ ] Rewrite the `tool_use` case in `renderMessageContent` to use the new layout:
    ```
    <tool emoji> summary_line                      [<CR> toggles inputSummaryExpanded]
    [if inputSummaryExpanded: JSON.stringify(request.input)]  ← handled by parent
    renderToolInput(expanded=inputExpanded)         [<CR> toggles inputExpanded]
    renderToolProgress(expanded=progressExpanded)   [<CR> toggles progressExpanded] (in-flight only)
    <status emoji> renderToolResultSummary          [<CR> toggles resultSummaryExpanded] (completed only)
    [if resultSummaryExpanded: JSON.stringify(result)]  ← handled by parent
    renderToolResult(expanded=resultExpanded)       [<CR> toggles resultExpanded] (completed only)
    ```
  - [ ] Each section gets its own `withBindings` with `<CR>` toggling its own expanded state (5 toggle points: inputSummary, input, progress, resultSummary, result)
  - [ ] The two summary JSON expansions (inputSummaryExpanded, resultSummaryExpanded) are rendered by the parent using `JSON.stringify`, not by per-tool renderers. The entire JSON should also collapse the JSON on CR.
  - [ ] Keep `t` binding for abort on in-flight tools. Currently `t` calls `activeEntry.handle.abort()` on a single `withBindings` wrapping the entire tool block. In the new layout with multiple `withBindings` sections, add `t` to all sections of an in-flight tool (summary, input, progress) so abort works regardless of cursor position within the tool.
  - [ ] Check for type errors and iterate until they pass

- [ ] **Step 5: Update streaming renderer**
  - [ ] Update `streaming.ts` to use the new summary format (tool emoji + name + partial input if available)
  - [ ] Check for type errors and iterate until they pass

- [ ] **Step 6: Run tests and fix any failures**
  - [ ] Run `npx vitest run` and fix any test failures
  - [ ] Run `npx tsgo -b` for final type check
  - [ ] Run `npx biome check .` for linting

- [ ] **Step 7: Manual testing**
  - [ ] Test with a tool that has progress (bash_command with a long-running command)
  - [ ] Test with a tool that completes quickly (get_file)
  - [ ] Test expand/collapse on all three sections
  - [ ] Test error display
