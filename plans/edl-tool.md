# context

The goal is to wrap the existing EDL (Edit Description Language) script runner (`node/edl/index.ts::runScript`) as a new static tool that the LLM can invoke, following the same pattern as other tools like `list_directory` or `bash_command`.

EDL is a mini-language for programmatic file editing. A script is a string of commands like `file`, `select`, `replace`, `insert_after`, etc. The `runScript(script)` function parses and executes the script, returning either `{ status: "ok", result: string }` or `{ status: "error", error: string }`.

The relevant files and entities are:

- `node/edl/index.ts`: `runScript()` — the function to call. Takes a script string, returns `RunScriptResult`.
- `node/tools/listDirectory.ts`: Reference implementation for a simple auto-responding tool (processing → done states, no user approval needed).
- `node/tools/tool-registry.ts`: `STATIC_TOOL_NAMES`, `CHAT_STATIC_TOOL_NAMES`, `SUBAGENT_STATIC_TOOL_NAMES` — must register the new tool name here.
- `node/tools/toolManager.ts`: `StaticToolMap`, `TOOL_SPEC_MAP`, `renderCompletedToolSummary`, `renderCompletedToolPreview`, `renderCompletedToolDetail` — must add the new tool to the type map, spec map, and render switch statements.
- `node/tools/create-tool.ts`: `createTool()` — must add a case to instantiate the new tool.
- `node/tools/helpers.ts`: `validateInput()`, `renderStreamdedTool()` — must add cases for the new tool.
- `node/tools/types.ts`: `GenericToolRequest`, `StaticTool`, `CompletedToolInfo` — types to implement.
- `node/edl/parser.ts`: Defines the EDL script syntax (needed for the tool description).

# implementation

- [x] Create `node/tools/edl.ts` with the tool implementation
  - [x] Define `Input` type: `{ script: string }`
  - [x] Define `ToolRequest` as `GenericToolRequest<"edl", Input>`
  - [x] Define `State`: `processing` | `done`
  - [x] Define `Msg`: `{ type: "finish", result: Result<ProviderToolResultContent[]> }`
  - [x] Implement `EdlTool` class implementing `StaticTool`
    - Constructor calls `runScript()` and dispatches the result
    - `isDone()`, `isPendingUserAction()`, `abort()`, `update()`, `getToolResult()`, `renderSummary()`
  - [x] Export `spec: ProviderToolSpec` with name `"edl"`, description of the EDL language syntax and capabilities, and `input_schema` with a required `script` string field
  - [x] Export `validateInput()` function
  - [x] Export `renderCompletedSummary()` static function
- [x] Register the tool in `node/tools/tool-registry.ts`
  - [x] Add `"edl"` to `STATIC_TOOL_NAMES`
  - [x] Add `"edl"` to `CHAT_STATIC_TOOL_NAMES`
  - [x] Add `"edl"` to `SUBAGENT_STATIC_TOOL_NAMES`
- [x] Wire up in `node/tools/toolManager.ts`
  - [x] Add `import * as Edl from "./edl.ts"`
  - [x] Add `edl` entry to `StaticToolMap`
  - [x] Add `edl` entry to `TOOL_SPEC_MAP`
  - [x] Add `case "edl"` to `renderCompletedToolSummary`
  - [x] Add `case "edl"` to `renderCompletedToolPreview` (default empty)
  - [x] Add `case "edl"` to `renderCompletedToolDetail` (default JSON display)
- [x] Wire up in `node/tools/create-tool.ts`
  - [x] Add `import * as Edl from "./edl.ts"`
  - [x] Add `case "edl"` to the switch in `createTool()`
- [x] Wire up in `node/tools/helpers.ts`
  - [x] Add `import * as Edl from "./edl"`
  - [x] Add `case "edl"` to `validateInput()`
  - [x] Add `case "edl"` to `renderStreamdedTool()`
- [x] Run `npx tsc --noEmit` and iterate until no type errors
- [x] Write tests for the tool (e.g. `node/tools/edl.test.ts`)
  - [x] Test successful script execution
  - [x] Test script parse error
  - [x] Test script execution error
  - [x] Iterate until tests pass
