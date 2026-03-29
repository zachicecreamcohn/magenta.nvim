# context

## Objective

Restructure the `renderToolResult` contract so that tools can manage per-item expansion state within a single tool's result. The immediate use case is spawn-subagents, where each agent should independently expand/collapse its yielded text. `<CR>` navigates to the subthread; `=` toggles the detail for that specific agent.

## Key types and interfaces

- `ToolViewState` (node/chat/thread.ts:119-125) — per-tool view state with 5 booleans (inputSummaryExpanded, inputExpanded, progressExpanded, resultSummaryExpanded, resultExpanded). Currently the only state passed to renderToolResult.
- `Msg` (node/chat/thread.ts:35-99) — thread message union, includes toggle messages like `toggle-tool-result` with just a `toolRequestId`.
- `renderToolResult` (node/render-tools/index.ts:191-213) — dispatches to per-tool renderers. Signature: `(info, context: RenderContext, expanded: boolean) => VDOMNode | undefined`. Thread-view wraps output in `withBindings` for `toggle-tool-result`.
- `RenderContext` (node/render-tools/index.ts:31-39) — includes dispatch, chat, nvim, cwd, homeDir, options, getDisplayWidth.
- `SpawnSubagents.StructuredResult` (node/core/src/tools/spawn-subagents.ts:68-75) — `{ toolName, agents: Array<{ prompt, threadId?, ok, responseBody? }> }`.
- `MessageViewState` (node/chat/thread.ts:112-117) — existing precedent for per-item expansion dicts (`expandedUpdates`, `expandedContent`).
- `compactionViewState` (node/chat/thread.ts:133-137) — another precedent with nested `expandedSteps` dict.

## Relevant files

- `node/chat/thread.ts` — owns `ToolViewState`, `Msg`, and toggle handlers
- `node/chat/thread-view.ts:630-648` — Section 7 where `renderToolResult` is called and wrapped in `withBindings`
- `node/render-tools/index.ts:191-213` — `renderToolResult` dispatch function
- `node/render-tools/spawn-subagents.ts:159-196` — current `renderResult` for spawn-subagents
- `node/render-tools/bashCommand.ts:110-120` — `renderResult` that uses expanded for preview vs detail
- `node/render-tools/edl.ts:110-144` — `renderResult` that uses expanded for summary vs formatted result

## Design

### State changes

Add an optional `resultItemExpanded` dict to `ToolViewState`:

```typescript
type ToolViewState = {
  inputSummaryExpanded: boolean;
  inputExpanded: boolean;
  progressExpanded: boolean;
  resultSummaryExpanded: boolean;
  resultExpanded: boolean;
  resultItemExpanded?: { [key: string]: boolean };
};
```

Add a new `toggle-tool-result-item` message to `Msg`:

```typescript
| {
    type: "toggle-tool-result-item";
    toolRequestId: ToolRequestId;
    itemKey: string;
  }
```

### Contract changes

Change `renderToolResult` to receive `ToolViewState` instead of a single `expanded` boolean, so tools have access to both `resultExpanded` and `resultItemExpanded`.

Stop wrapping `renderToolResult` output in `withBindings` in thread-view. Instead, each tool's `renderResult` owns its own bindings. This lets spawn-subagents attach `<CR>` for navigation and `=` for per-agent expansion on individual lines.

For backward compatibility, tools that just need a simple expand/collapse (edl, bash_command) will wrap their own output in `withBindings` that dispatches `toggle-tool-result` themselves. This is a small migration for each tool renderer but keeps the contract clean.

### Signature change

```typescript
// Before:
function renderToolResult(
  info: CompletedToolInfo,
  context: RenderContext,
  expanded: boolean,
): VDOMNode | undefined;

// After:
function renderToolResult(
  info: CompletedToolInfo,
  context: RenderContext,
  toolViewState: ToolViewState,
): VDOMNode | undefined;
```

Each per-tool renderResult will get the same signature change. The dispatch for `toggle-tool-result` and `toggle-tool-result-item` is already available via `context.dispatch`.

# implementation

- [ ] **Add `resultItemExpanded` to `ToolViewState` and new message type**
  - [ ] In `node/chat/thread.ts`, add `resultItemExpanded?: { [key: string]: boolean }` to `ToolViewState`
  - [ ] Add `toggle-tool-result-item` message variant to `Msg` with `toolRequestId` and `itemKey` fields
  - [ ] Add handler in `myUpdate` for `toggle-tool-result-item`: get-or-create `toolState`, get-or-create `resultItemExpanded` dict, toggle `resultItemExpanded[itemKey]`
  - [ ] Check for type errors: `npx tsgo -b`

- [ ] **Change `renderToolResult` signature to pass `ToolViewState`**
  - [ ] In `node/render-tools/index.ts`, change `renderToolResult` to accept `toolViewState: ToolViewState` instead of `expanded: boolean`
  - [ ] Import `ToolViewState` from `node/chat/thread.ts` (or re-export it)
  - [ ] Update the dispatch to each per-tool renderResult to pass `toolViewState`
  - [ ] Check for type errors: `npx tsgo -b`

- [ ] **Update thread-view to stop wrapping renderToolResult in withBindings**
  - [ ] In `node/chat/thread-view.ts` Section 7 (~line 632-648): remove the `withBindings` wrapper around `renderToolResult` output. Just pass the result through as `resultView = d`\n${resultContent}``
  - [ ] Pass the full `toolViewState` (or a default) to `renderToolResult` instead of `toolViewState?.resultExpanded || false`
  - [ ] Check for type errors: `npx tsgo -b`

- [ ] **Migrate bash_command renderResult to own its bindings**
  - [ ] In `node/render-tools/bashCommand.ts`, change `renderResult` signature: replace `expanded: boolean` with `toolViewState: ToolViewState`
  - [ ] Read `toolViewState.resultExpanded` for the expand/collapse logic (same behavior as before)
  - [ ] Wrap the returned VDOMNode in `withBindings` with `<CR>` dispatching `toggle-tool-result` (needs `toolRequestId` — add it to RenderContext or pass it as an additional param)
  - [ ] Check for type errors: `npx tsgo -b`

- [ ] **Migrate edl renderResult to own its bindings**
  - [ ] Same pattern as bash_command: change signature, read `toolViewState.resultExpanded`, wrap in `withBindings`
  - [ ] Check for type errors: `npx tsgo -b`

- [ ] **Migrate spawn-subagents renderResult to use per-agent expansion**
  - [ ] Change `renderResult` signature to accept `toolViewState: ToolViewState`
  - [ ] For each agent in the result, check `toolViewState.resultItemExpanded?.[agentKey]` to decide whether to show yielded text
  - [ ] Use `agentKey` = agent index as string (e.g. "0", "1", "2")
  - [ ] Each agent line gets `withBindings` with:
    - `<CR>`: dispatch `chat-msg` → `select-thread` (navigate to subthread) — same as current
    - `=`: dispatch `thread-msg` → `toggle-tool-result-item` with `toolRequestId` and `itemKey`
  - [ ] When expanded, show the agent's `responseBody` (truncated or full) below the agent summary line
  - [ ] Check for type errors: `npx tsgo -b`

- [ ] **Pass `toolRequestId` to renderResult functions**
  - [ ] Since tools now own their bindings and need to dispatch toggle messages, they need the `toolRequestId`. Add it as a parameter to `renderToolResult` in index.ts and propagate to each tool's renderResult.
  - [ ] Check for type errors: `npx tsgo -b`

- [ ] **Write tests**
  - [ ] Add a test in `node/tools/spawn-subagents.test.ts` that verifies per-agent expansion state works in the rendered output (check that `=` binding dispatches the right message, and expanded agents show yielded text)
  - [ ] Run tests: `npx vitest run`
  - [ ] Iterate until tests pass

- [ ] **Run linting**: `npx biome check --write .`
