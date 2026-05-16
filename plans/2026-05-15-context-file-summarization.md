# Context

We need to add summarization to context files. Right now, when a user includes a file via context (e.g. via `:Magenta context-files <path>` or `autoContext` globs), the full file contents are sent on every request. There's no token/size limit, so a single large file can blow the model's context window and crash the thread.

We also want a hard, non-bypassable token cap on `get_file`, even when the agent passes `force: true`. The agent should be forced to page through very large files using `startLine`/`numLines`.

## Current summarization strategies (audit)

This is the existing picture — different tools have wildly different limits.

### 1. Context files (`node/core/src/context/context-manager.ts`)

**NO summarization or token limit.**

- `addFileContext()` / `addFiles()` accept any text file regardless of size. Only `UNSUPPORTED` MIME types are rejected.
- `handleTextFileUpdate()` reads the full file with `fileIO.readFile()` and emits a `whole-file` update on first inclusion. There is no truncation.
- Updates after the first one are emitted as `diff` patches via `diff.createPatch()` (good — usually small). But these are also uncapped.
- Binary files have file-size limits in `FILE_SIZE_LIMITS` (10MB image, 32MB PDF) but text files do not.
- This is the bug source: a 500KB JSON file dropped into context will be sent in full on every request.

### 2. `get_file` tool (`node/core/src/tools/getFile.ts`)

Has a soft size limit with summarization fallback, but the cap can be bypassed.

- `MAX_FILE_CHARACTERS = 40000` (~10k tokens) — threshold for "large" file.
- `MAX_LINE_CHARACTERS = 2000` — individual long lines are abridged (`first 1000 + "... omitted ..." + last 1000`).
- `DEFAULT_LINES_FOR_LARGE_FILE = 100` — fallback line count.
- Logic in `processTextContentStandalone()`:
  - If `numLines` is **undefined** AND `totalChars > MAX_FILE_CHARACTERS` → return `summarizeFile()` summary (see #4).
  - If `numLines` **is** defined → return that many lines verbatim, **no cap**. A pathological `numLines: 1_000_000` with long lines is unbounded.
  - If file is small → return it whole.
- The `force` flag only bypasses the "already in context" early-exit. It does NOT bypass the size logic. But the existing size logic isn't strong enough.

### 3. `bash_command` tool (`node/core/src/tools/bashCommand.ts`)

Most sophisticated. Has a hard cap.

- `MAX_OUTPUT_TOKENS_FOR_AGENT = 2000` (~8000 chars).
- `MAX_CHARS_PER_LINE = 800` — individual lines abbreviated mid-line with `...`.
- `formatOutputForToolResult()` strategy:
  - If raw output ≤ budget → return as-is.
  - If over budget → keep 30% head + 70% tail by char budget; replace middle with `... (N lines omitted) ...`; per-line abbreviation applied.
  - `wasAbbreviated: true` returned in the structured result.
- Full untruncated output is written to a log file (`$MAGENTA_TEMP_DIR/threads/<threadId>/tools/<reqId>/bashCommand.log`) by `createLogWriter()` in `node/capabilities/shell-utils.ts`. The agent gets the log path and can re-read slices via `get_file`.

### 4. File summarization helper (`node/core/src/utils/file-summary.ts`)

Used by `get_file`. Could be reused for context files.

- `summarizeFile(content, { charBudget })` — default budget 10,000 chars.
- Splits file into ≤200-char chunks at line boundaries (sub-chunks long lines at word boundaries).
- Scores chunks by:
  - Token frequency self-information (rarer tokens score higher).
  - First-occurrence bonus (2x).
  - Scope size (indentation-derived; outer scopes weighted higher).
  - Indentation weight `1/(1+indent)`.
- `selectChunks()` greedily picks highest-scoring chunks within char budget; always includes chunk 0; returns selected chunks in file order.
- `formatSummary()` renders selected chunks with line numbers and `... (N lines omitted) ...` gap markers, plus a header `[File summary: N lines, M chars. Showing K key segments]`.

### 5. Per-model output token caps (`node/core/src/providers/anthropic-agent.ts`)

`getMaxTokensForModel()` returns the `max_tokens` request param for the API. Not used for input shaping.

### 6. Compaction (`node/core/src/compact-renderer.ts`)

Separate system for chunking the conversation history when compacting. Uses `CHARS_PER_TOKEN = 4`, `TARGET_CHUNK_TOKENS = 25_000`. Not directly relevant to per-file caps but uses the same 4:1 char→token estimation.

## Summary table

| Surface           | Token cap          | Char cap            | Summarization | Paging | Force-bypass |
|-------------------|--------------------|---------------------|---------------|--------|--------------|
| Context files     | none               | none                | none          | n/a    | n/a          |
| `get_file`        | ~10k (when no `numLines`) | 40,000      | yes           | yes    | none (but `numLines` bypasses cap) |
| `bash_command`    | 2,000              | 8,000               | head+tail     | log file | n/a |

Goal of this plan:

- Add a `~20,000 token` (~80,000 char) cap to context files, with summarization when exceeded.
- Tighten `get_file` so the cap is hard: even `force: true` + huge `numLines` cannot exceed a maximum byte budget. The agent pages through with `startLine`/`numLines`.

# Key types and constants

Relevant files:

- `node/core/src/context/context-manager.ts` — context manager. Need to add summarization in `handleTextFileUpdate()`.
- `node/core/src/tools/getFile.ts` — get_file tool. Need to enforce a hard cap regardless of `numLines`.
- `node/core/src/utils/file-summary.ts` — already provides `summarizeFile()` / `formatSummary()`. Reusable as-is.
- `node/core/src/context/context-manager.test.ts` (presumed) — context manager tests.
- `node/core/src/tools/getFile.test.ts` (presumed) — get_file tests.

New constants (proposed):

```ts
// in context-manager.ts
const CONTEXT_FILE_MAX_CHARACTERS = 80_000; // ~20k tokens — threshold above which we summarize
// summary budget: use summarizeFile()'s default of 10_000 chars (~2.5k tokens).
// The agent can drill in with get_file + startLine/numLines for specific sections.

// in getFile.ts
const HARD_MAX_OUTPUT_CHARACTERS = 40_000; // ~10k tokens; not bypassable
// existing MAX_FILE_CHARACTERS becomes the "summarize threshold"
```

New `agentView` consideration: when a context file is summarized, the agent has only seen the summary, not the full content. Decision: a new `{ type: "summary" }` agentView variant marks the file as "already summarized; don't emit further context updates for changes to this file." The agent can re-read via `get_file` with line ranges if it needs current info.

# Implementation

- [ ] **Step 1: add summarization to context manager for over-cap text files**
  - Add `CONTEXT_FILE_MAX_CHARACTERS = 80_000` constant in `node/core/src/context/context-manager.ts`.
  - Extend the `TrackedFileInfo["agentView"]` union (in `node/core/src/capabilities/context-tracker.ts`) with a new `{ type: "summary" }` variant. This marks "we summarized this file once; don't emit further context updates."
  - Modify `handleTextFileUpdate()`:
    - Read `currentFileContent` as today.
    - If `fileInfo.agentView?.type === "summary"`, return `undefined` (no update emitted, no diff, ever).
    - Else, if `currentFileContent.length > CONTEXT_FILE_MAX_CHARACTERS`:
      - Produce a summary with `summarizeFile(currentFileContent)` (default 10k char budget) + `formatSummary()`.
      - Emit a `whole-file` update with a notice prefix like `[File too large for full context (N chars). Showing summary. Use the get_file tool with startLine/numLines to read specific ranges.]` followed by the summary text.
      - On commit, set `fileInfo.agentView = { type: "summary" }`.
    - Else (small file): existing whole-file / diff logic as today.
  - Update `updateAgentsViewOfFiles()` and any switch on `agentView.type` to handle the new variant (rely on `assertUnreachable` to find call sites).
  - Update `buildClonedFiles()` so summary agentView is preserved on clone (do not re-read content for these).
  - Update `contextFilesView()` (`node/context/context-manager.ts`) to badge summarized files (e.g. `(summary)`).
  - **Testing**
    - Behavior: a text file over the cap is included in context as a summary, not full content.
    - Setup: create a tmp file with ~150,000 chars of repeating distinguishable code. Add it to context via `contextManager.addFiles([path])`.
    - Actions: call `getContextUpdate()`.
    - Expected output: the returned `FileUpdates` for that path has `update.value.type === "whole-file"` and the text content starts with the "[File too large…]" notice and contains the `[File summary: …]` header from `formatSummary()`.
    - Assertions: total chars in the emitted text < e.g. 100,000; the file path is listed in the file_paths block; the agentView in `files[absPath]` is the new `summary` variant.
  - Behavior: an unchanged over-cap file does not re-emit on the next update cycle.
    - Setup: same as above; call `getContextUpdate()` once.
    - Actions: call `getContextUpdate()` again without modifying the file.
    - Expected output: empty `FileUpdates` (no entry for the path).
    - Assertions: `Object.keys(result).length === 0`.
  - Behavior: when an over-cap file is modified, no further update is emitted (the agent must re-read with get_file).
    - Setup: include a large file, call `getContextUpdate()`, then append text to the file.
    - Actions: call `getContextUpdate()` after modification.
    - Expected output: empty `FileUpdates` for this path (no diff, no new summary).
    - Assertions: `result[absPath]` is `undefined`; `fileInfo.agentView.type === "summary"` still.

- [ ] **Step 2: enforce hard cap in `get_file`**
  - In `node/core/src/tools/getFile.ts`:
    - Add `HARD_MAX_OUTPUT_CHARACTERS = 40_000` as a hard cap. (Same as current `MAX_FILE_CHARACTERS`; rename for clarity if helpful.)
    - In `processTextContentStandalone()`:
      - When `numLines` is provided, still apply a running char budget. Stop appending lines once the cumulative output exceeds `HARD_MAX_OUTPUT_CHARACTERS`; emit a trailing note: `[Output truncated at HARD_MAX_OUTPUT_CHARACTERS chars. Use startLine=N to continue.]`.
      - When `numLines` is undefined and the file is large, the current summary path is fine. Make sure the summary's `charBudget` is bounded by `HARD_MAX_OUTPUT_CHARACTERS`.
    - Keep `MAX_LINE_CHARACTERS` line abridging as-is.
    - Update the tool description to make the cap explicit and guide the agent toward paging with `startLine`/`numLines`.
  - **Testing**
    - Behavior: requesting `numLines: 100000` on a 1MB file returns at most ~40k chars with a "use startLine=..." continuation note.
    - Setup: create a tmp file with ~1MB of content where each line is short and indexable (e.g. `line ${i}`).
    - Actions: call the `get_file` tool with `numLines: 100000, startLine: 1`.
    - Expected output: text length ≤ `HARD_MAX_OUTPUT_CHARACTERS + small overhead`; trailing note suggests next `startLine`.
    - Assertions: output `text.length` is within budget; `text` ends with the continuation hint.
  - Behavior: `force: true` does not bypass the hard cap.
    - Setup: add a large file to context, then call `get_file` with `force: true`.
    - Actions: invoke the tool with `force: true`, no line params.
    - Expected output: summary text (not full file), within budget.
    - Assertions: `text.length` ≤ budget; contains `[File summary:` header.
  - Behavior: small files still return verbatim.
    - Setup: a 20-line file.
    - Actions: call `get_file` with no line params.
    - Expected output: full file content.
    - Assertions: text matches file content; no summary header.

- [ ] **Step 3: surface "summary mode" in the UI**
  - Update the context-files sidebar (`node/context/context-manager.ts:contextFilesView()`) to show a `(summary)` badge or similar marker next to files in summary mode.
  - **Testing**
    - Behavior: a large context file is rendered with a `(summary)` indicator in the sidebar.
    - Setup: integration test with `withDriver()`; add a large file via the `context-files` command.
    - Actions: render the sidebar.
    - Expected output: the file row contains "(summary)" or equivalent badge.
    - Assertions: snapshot or substring match on the rendered sidebar text.

- [ ] **Step 4: documentation**
  - Update the `get_file` tool description to mention the hard cap and recommend paging via `startLine`/`numLines`.
  - Update any user-facing docs (README / `docs/`) about the new context-file cap. Note that very large files will be summarized.

# Decisions

1. **Context file cap:** 80,000 chars (~20k tokens). Files over this are summarized once.
2. **Summary budget:** use `summarizeFile()`'s default of 10,000 chars (~2.5k tokens). The agent uses `get_file` with `startLine`/`numLines` to drill in.
3. **Hard cap for `get_file`:** 40,000 chars (~10k tokens), not bypassable by `force` or `numLines`.
4. **agentView for summarized files:** new `{ type: "summary" }` variant. Once summarized, **no further context updates are emitted** for changes to that file. The agent must re-read via `get_file` to see current state.
5. **Thread-wide context budget:** out of scope.
