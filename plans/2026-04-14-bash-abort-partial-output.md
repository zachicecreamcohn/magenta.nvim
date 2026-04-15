# Context

When a bash command is aborted (e.g. user cancels), the tool currently returns only
`"Request was aborted by the user."`, discarding all accumulated stdout/stderr. This
loses potentially valuable output (partial test results, build errors, etc.).

The goal is to include whatever output was accumulated before termination in the abort
response, formatted and truncated the same way as normal output.

## Relevant files and entities

- `node/core/src/tools/bashCommand.ts`: Contains `execute()` (the tool invocation entry
  point) and `formatOutputForToolResult()` (truncates/formats output). The two
  `if (aborted)` branches in `.then()` and `.catch()` are where the fix goes.
- `node/core/src/capabilities/shell.ts`: Defines `Shell`, `ShellResult`, and `OutputLine`
  interfaces. `ShellResult` includes `output: OutputLine[]` which is the accumulated
  output from the shell.
- `node/core/src/tools/bashCommand.test.ts`: Existing test `"abort returns error result"`
  resolves the shell with `output: []` after abort — needs to be updated to verify
  partial output is included.

## Key observations

- In the `.then()` abort branch, `result: ShellResult` is available, so we have
  `result.output`, `result.durationMs`, `result.signal`, and `result.logFilePath`.
- In the `.catch()` abort branch, no `result` is available, but `progress.liveOutput`
  contains whatever was accumulated before the error, and `progress.startTime` lets us
  compute duration.
- `formatOutputForToolResult()` already handles head/tail truncation and can be reused
  as-is for partial output.

# Implementation

- [ ] In the `.then()` abort branch (~line 286), include partial output from `result`:
  - Compute `durationMs` from `progress.startTime` (or use `result.durationMs`)
  - Call `formatOutputForToolResult(result.output, result.exitCode, result.signal,
    result.durationMs, result.logFilePath)`
  - If the formatted output is non-empty, append it after the abort message:
    `"Request was aborted by the user.\n\nOutput before termination:\n" + formatted`
  - Keep `status: "error"`

- [ ] In the `.catch()` abort branch (~line 327), include partial output from
  `progress.liveOutput`:
  - Compute `durationMs` from `progress.startTime`
  - Call `formatOutputForToolResult(progress.liveOutput, 1, undefined, durationMs,
    undefined)`
  - If the formatted output is non-empty, append it after the abort message similarly
  - Keep `status: "error"`

- [ ] Update existing test `"abort returns error result"` in `bashCommand.test.ts`:
  - Change the shell resolution to include non-empty output:
    `output: makeOutputLines(["partial line 1", "partial line 2"])`
  - Assert that the error message contains `"aborted by the user"` AND the partial
    output text (e.g. `"partial line 1"`)

- [ ] Add a test for the `.catch()` abort path:
  - Set up a shell that rejects after abort
  - Push some lines to `progress.liveOutput` via `onOutput` before rejecting
  - Assert the error message contains both the abort message and the partial output

- [ ] Run type checks: `npx tsgo -b`
- [ ] Run tests: `TEST_MODE=sandbox npx vitest run node/core/src/tools/bashCommand.test.ts`
