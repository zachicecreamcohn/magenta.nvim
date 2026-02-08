# context

When an EDL script fails (e.g., a `select_one` finds no matches), any large text content in subsequent `replace`/`insert_before`/`insert_after` commands for that file is lost. The LLM must regenerate all that text to retry, wasting tokens and time.

**Objective:** When an EDL execution fails for a file, automatically save the text from unexecuted mutation commands into named registers. Report these register names in the error message. Persist registers across EDL invocations within the same thread so future scripts can reference them.

## Relevant files and entities

- `node/edl/executor.ts` — `Executor` class: owns `registers: Map<string, string>`, executes commands, handles errors in `execute()` method. `FileState` tracks per-file state. `ExecutionError` is thrown on failures. The `execute()` method catches errors per-file and skips to the next file command.
- `node/edl/parser.ts` — `Command` type (union of all command variants), `parse()` function, `lex()` generator. `replace`/`insert_before`/`insert_after` require heredoc text. `cut`/`paste` use register names (plain words).
- `node/edl/index.ts` — `runScript()` creates a new `Executor` each time, runs commands, returns `RunScriptResult`. `EdlResultData` and `FileErrorInfo` types. `formatResult()` and error formatting.
- `node/edl/types.ts` — `ScriptResult`, `FileError`, `FileMutationSummary`, `TraceEntry` types.
- `node/tools/edl.ts` — `EdlTool` class: calls `runScript()` in `executeScript()`, dispatches results. Created per tool-use invocation by the thread.
- `node/chat/thread.ts` — `Thread` class: manages tool lifecycle, could hold persistent register state across tool invocations.
- `node/tools/create-tool.ts` — `createTool()` factory, where `EdlTool` is instantiated with context.
- `node/tools/edl-description.md` — LLM-facing description of the EDL tool (needs to document register persistence and new commands).

## implementation

### Phase 1: Auto-save failed text into registers on error

- [x] In `Executor.execute()`, when a file error occurs and we skip commands, scan the skipped commands for `replace`/`insert_before`/`insert_after` commands. For each, save `cmd.text` into `this.registers` with auto-generated names (e.g., `_saved_1`, `_saved_2`, incrementing a counter).
  - [x] The auto-increment counter for `_saved_N` names now lives on the persistent register store (Thread-level `edlRegisters`), populated into Executor via `runScript()`. _(completed in Phase 2)_
  - [x] After catching `ExecutionError` and before skipping to the next file command, iterate through the skipped commands (from `i+1` to the next file command index or end) and extract text from mutation commands
  - [x] Store each extracted text in `this.registers` with key `_saved_${++this.savedRegisterCount}`
  - [x] Collect the register names and their sizes (char count) for error reporting
- [x] Extend `FileError` type in `node/edl/types.ts` to include `savedRegisters: SavedRegisterInfo[]`
- [x] Extend `FileErrorInfo` in `node/edl/index.ts` similarly, and populate it from `ScriptResult.fileErrors`
- [x] Update error formatting in `formatFileErrors()` and `formatResult()` to include saved register info (e.g., "Text saved to register \_saved_1 (2450 chars). Use `paste _saved_1` to reference it.")
- [x] Also handle the case where the failing command itself is a replace/insert — save its text too before recording the error (handled by scanning from `i` not `i+1`)
- [x] Check for type errors and iterate until they pass
- [x] Write unit tests for auto-saving registers on error
  - [x] Test that when a select fails before a replace, the replace text is saved to a register
  - [x] Test that the register name appears in the FileError's savedRegisters
  - [x] Test with multiple files where one fails and the other succeeds
- [x] Iterate until tests pass

### Phase 2: Persist registers across EDL invocations within a thread

- [x] Define `EdlRegisters` type (e.g., `{ registers: Map<string, string>; nextSavedId: number }`) in a shared location (e.g., `node/edl/index.ts` or a new `node/edl/registers.ts`)
- [x] Add `edlRegisters: EdlRegisters` to the `Thread` class state
  - [x] Initialize it in the constructor with `{ registers: new Map(), nextSavedId: 0 }`
- [x] Pass `EdlRegisters` into `EdlTool` via context
  - [x] Add `edlRegisters: EdlRegisters` to the context type in `EdlTool`
  - [x] Update `createTool()` in `create-tool.ts` to pass `edlRegisters` from the thread
- [x] Update `runScript()` signature to accept an optional `EdlRegisters` parameter
  - [x] Pre-populate the `Executor.registers` from it, and use its `nextSavedId` for the counter
- [x] Update `runScript()` to return the updated `EdlRegisters` in the result
  - [x] After execution, capture the executor's registers and updated counter into the result
- [x] In `EdlTool.executeScript()`, pass the thread's `edlRegisters` into `runScript()`, and after execution, update the thread's `edlRegisters` with the returned value
- [x] Note: `cut`/`paste` already use `this.registers` on the Executor, so they automatically persist across invocations via this mechanism — no extra work needed
- [x] Check for type errors and iterate until they pass
- [x] Write unit tests for register persistence
  - [x] Test that registers from one `runScript` call can be pre-loaded into the next
  - [x] Test the round-trip: fail → save register → new script → paste from register
  - [x] Test that `cut` in one invocation can be `paste`d in a subsequent invocation
- [x] Iterate until tests pass

### Phase 3: Accept registers in existing `replace` / `insert_before` / `insert_after` commands

- [x] Update the `Command` type for `replace`, `insert_before`, `insert_after` to accept either a heredoc text or a register name. E.g., change `{ type: "replace"; text: string }` to `{ type: "replace"; text: string } | { type: "replace"; register: string }` (or use a shared `TextSource` union: `{ type: "literal"; text: string } | { type: "register"; name: string }`).
- [x] Update parsing in `parse()`: after `replace` / `insert_before` / `insert_after`, peek at the next token — if it's a word (register name), parse it as a register reference; if it's a heredoc, parse as before.
- [x] Update execution in `Executor.executeCommand()`: for these commands, resolve the text — if it's a register reference, look up `this.registers.get(name)` and throw if not found, then proceed with the same mutation logic.
- [x] Check for type errors and iterate until they pass
- [x] Write unit tests for register-based commands
  - [x] Test `replace <register_name>` replaces selection with register content
  - [x] Test `insert_before <register_name>` and `insert_after <register_name>`
  - [x] Test error when register doesn't exist
- [x] Iterate until tests pass

### Phase 4: Update LLM-facing documentation

- [x] Update `node/tools/edl-description.md` to document:
  - Registers persist across EDL tool uses within the same thread (both explicit `cut`/`paste` and auto-saved registers)
  - When an EDL script fails, large text from unexecuted `replace`/`insert_before`/`insert_after` commands is automatically saved to `_saved_N` registers
  - `replace`, `insert_before`, `insert_after` now accept a register name (word) in addition to heredoc
  - Add an example showing a retry workflow, e.g.:
    ```
    # First EDL invocation fails because the select pattern doesn't match:
    #   select_one: no matches for pattern ...
    #   Text saved to register _saved_1 (1500 chars)
    #
    # Second EDL invocation retries with corrected select, reusing the saved text:
    file `src/component.ts`
    select_one <<END
    corrected pattern here
    END
    replace _saved_1
    ```
