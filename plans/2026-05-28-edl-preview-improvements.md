# Objective and Context

## User request (verbatim)

> So I'm not super happy with the preview of the EDL, either while it's streaming or after it has been applied. I'm not talking about the stuff that's actually sent to the agent. I think that is fine but I'm talking more about the representation that we show to the user.
>
> In particular while we're streaming we should capture which files we're editing. Instead of just showing the last like 20 lines of the script, we should show at the top a summary of the files edited so far and then maybe the last 10 lines or so of the EDL script as it's streaming along.
>
> When we are showing a summary of the applied EDL script, we should show a similar sort of thing: a list of files and maybe some summary of statistics about which files were changed. In both of these cases those files should have an expand functionality on an equals key to show full EDL script for that file. We should also have a CR key binding to navigate to that file.
>
> Let's write a plan

## What we're building

This is purely a UI/display change. Nothing about the EDL tool's behavior, the
script that gets executed, or the data sent back to the agent changes. We are
improving two user-facing renderings of the EDL tool:

1. **Streaming preview** — while the model is still streaming the `script`
   argument. Today we show only the last 20 lines of the partial script. We want
   to additionally show, at the top, a summary of the files being edited so far,
   then the last ~10 lines of the streaming script.

2. **Applied-result preview** — after the EDL script has run. Today we show a
   flat list of per-file stat lines and a single `<CR>` toggle for the whole
   result. We want a richer per-file summary where each file row supports:
   - `=` to expand/collapse the full EDL script segment for that file
   - `<CR>` to navigate to (open) that file

## Key entities

- `EdlDisplayData` (`node/core/src/tools/edl.ts:31`) — per-file `summary`
  (`FileMutationSummary`), `fileErrorCount`, `finalSelectionCount`. Produced by
  `execute()` and serialized into the tool result.
- `FileMutationSummary` (`node/core/src/edl/types.ts:15`) —
  `{ insertions, deletions, replacements, linesAdded, linesRemoved }`.
- `parse(script)` / `lex(script)` (`node/core/src/edl/parser.ts`) — turn a
  script into `Command[]`. `Command` includes `{ type: "file"; path }` and
  `{ type: "newfile"; path }`. **Commands carry no source offsets today.**
- `analyzeFileAccess(script)` (`node/core/src/edl/index.ts:81`) — returns files
  referenced by a script. Calls `parse()`, so it throws on malformed input.
- `ToolViewState` (`node/chat/thread.ts:143`) — per-tool view state. Has
  `resultItemExpanded?: { [key: string]: boolean }` for per-item expansion,
  toggled via the `toggle-tool-result-item` thread message (handler at
  `thread.ts:699`).
- `open-edit-file` thread message (`thread.ts:103`, handler `:713`) — dispatches
  `openFileInNonMagentaWindow`. Takes an `UnresolvedFilePath`. This is exactly
  the navigation primitive we need for `<CR>`.

## Relevant files

- `node/render-tools/streaming.ts` — `renderStreamdedTool`, the streaming preview (edl case).
- `node/render-tools/edl.ts` — `renderInput`, `renderResultSummary`, `renderResult`.
- `node/render-tools/index.ts` — wiring; passes the full `RenderContext` to edl render fns.
- `node/core/src/edl/` — parser/lexer; candidate home for a new per-file segment splitter.
- `node/chat/thread.ts` — `ToolViewState`, item-toggle handlers, `open-edit-file`.

# Design

## Per-file script segmentation (shared building block)

Both views need to know, given a (possibly partial) raw script, which files are
referenced and — for the applied view's `=` expansion — the raw text of the EDL
commands belonging to each file. `analyzeFileAccess` gives the file list but not
the text segments, and it throws on partial input.

Add a tolerant helper in core (e.g. `node/core/src/edl/index.ts`):

```
splitScriptByFile(script: string): { path: string; segment: string }[]
```

- A "segment" is the raw substring of the script from one `file`/`newfile`
  directive up to (but not including) the next one. Commands before the first
  `file` directive (rare) can be ignored or attached to a synthetic leading
  bucket — keep it simple and drop them.
- It must be **heredoc-aware** so a `` file `x` `` token appearing inside heredoc
  body text does not start a new segment. Reuse the existing `lex()` logic for
  this rather than naive line splitting.
- It must be **tolerant**: never throw on an incomplete/streaming script. The
  cleanest path is to have the lexer emit token start offsets (extend `Token`
  with a `pos`/`start` field, or write a sibling generator) and stop gracefully
  at the truncation point instead of throwing on an unterminated heredoc/path.
- The same offsets let us recover each file directive's path token and the byte
  range of its segment.

Decision: prefer extending the lexer to carry offsets and to be
truncation-tolerant, since that single change powers both the streaming file
list and the applied per-file segment expansion. Keep `parse()`/`analyzeFileAccess`
behavior unchanged (strict) so executor semantics are untouched.

Alternative considered & rejected: re-deriving segments from the structured
`Command[]` — rejected because `Command` has no source spans and adding spans to
every command is more invasive than offsets on the lexer.

## Streaming preview (`streaming.ts`)

For the edl case in `renderStreamdedTool`:

1. Extract the partial script (already done via `extractPartialJsonStringValue`).
2. Run `splitScriptByFile` on it (tolerant). Build a top summary block:
   `Editing N file(s):` followed by one line per distinct file path. Optionally
   annotate each with a rough directive count derived from the segment (we can't
   compute real `linesAdded/Removed` without executing — keep it to path list,
   or a simple count of mutation directives, whichever reads cleanly).
3. Append the last ~10 lines of the raw script (reduce current 20 → 10).
4. Compose: summary block on top, then `withCode` of the tail.

This view is non-interactive (it is replaced once streaming completes), so no
bindings are needed here.

## Applied-result preview (`edl.ts` `renderResult`)

The top-level header summary (`renderResultSummary`) stays roughly as-is (total
mutations / files / +lines/-lines). The body changes to a per-file list where
each file is its own interactive row.

For each entry in `data.mutations`:

- Row text: `path` + compact stats (the existing `N replace, N insert, N delete
  (+X/-Y)` line).
- `=` binding → dispatch `{ type: "toggle-tool-result-item", toolRequestId,
  itemKey: path }`, mirroring the spawn-subagents pattern. Use the file `path`
  as the `itemKey`.
- `<CR>` binding → dispatch `{ type: "open-edit-file", filePath: path }` (cast to
  `UnresolvedFilePath` as thread-view.ts already does).
- When `toolViewState.resultItemExpanded?.[path]` is true, render the full EDL
  **segment** for that file beneath the row (via `splitScriptByFile` on
  `info.request.input.script`, matched by path), wrapped in `withCode`.

The whole-result `<CR>` toggle currently on `renderResult` should be removed or
moved off `<CR>` so it doesn't collide with the new per-row `<CR>` navigation.
The existing `resultExpanded`/`toggle-tool-result` path (full formatted result)
is already reachable through the standard result-summary expansion machinery, so
the per-file rows can own `=`/`<CR>` cleanly.

To access `nvim`/`cwd`/`homeDir`/dispatch for path resolution and bindings,
widen the `context` param of `edl.renderResult` from the current narrow
`{ threadDispatch }` shape to the full `RenderContext` (index.ts already passes
it).

Invariants:
- No change to the executed script, the agent-facing tool result, or
  `EdlDisplayData` contents/serialization.
- `parse()`/`analyzeFileAccess()` remain strict and behavior-preserving;
  tolerance is confined to the new display-only splitter/lexer-offset path.
- `splitScriptByFile` must never throw, including on empty, whitespace-only, or
  mid-heredoc-truncated streaming input.
- Per-file `itemKey` uses the file path; duplicate `file` directives for the same
  path should collapse to one row (match `analyzeFileAccess`'s dedup behavior) or
  be handled deterministically.

# Stages

## Stage 1: tolerant per-file splitter in core

- Goal: `splitScriptByFile(script)` returns `{ path, segment }[]` for complete
  scripts and degrades gracefully (no throw) on partial/streaming scripts;
  lexer carries offsets and tolerates truncation.
- Verification (unit tests in `node/core/src/edl/`):
  - Behavior: complete multi-file script splits into correct per-file segments.
    - Setup: a script with two `file` blocks and a `newfile` block, including a
      heredoc whose body contains a `` file `decoy` `` line.
    - Actions: call `splitScriptByFile`.
    - Expected: one segment per real directive; decoy inside heredoc does not
      create a segment; segment text matches the raw substrings.
  - Behavior: partial script (unterminated heredoc / dangling `file`) does not throw.
    - Setup: truncate a valid script mid-heredoc.
    - Actions: call `splitScriptByFile`.
    - Expected: returns the files discovered so far; no exception.
  - Behavior: existing `parse`/`analyzeFileAccess` still strict.
    - Expected: their existing tests still pass unchanged.
- Before moving on: confirm tests, type checks (`npx tsgo -b`), and lint pass.

## Stage 2: streaming preview summary

- Goal: streaming edl preview shows a top "Editing N files" summary plus the last
  ~10 lines of the script.
- Verification (integration test via `withDriver`, following doc-testing skill):
  - Behavior: while an edl tool_use streams a multi-file script, the sidebar
    shows the file list and a truncated tail.
    - Setup: mock provider streaming a partial edl `script` arg spanning 2 files
      and >10 lines.
    - Actions: advance the stream; read rendered sidebar text.
    - Expected: file paths appear in a summary block; only ~10 trailing script
      lines are shown.
- Before moving on: confirm tests, type checks, and lint pass.

## Stage 3: applied per-file rows with `=` expand and `<CR>` navigate

- Goal: applied edl result renders per-file rows; `=` toggles the full per-file
  EDL segment; `<CR>` opens the file.
- Verification (integration test via `withDriver`):
  - Behavior: per-file rows render with stats.
    - Setup: run an edl script editing two files; complete the tool.
    - Actions: read rendered result.
    - Expected: one row per file with replace/insert/delete and +/- counts.
  - Behavior: `=` expands the per-file segment.
    - Setup: as above.
    - Actions: place cursor on a file row, press `=`.
    - Expected: that file's raw EDL segment is shown; pressing again collapses it;
      other rows unaffected (keyed by path).
  - Behavior: `<CR>` navigates to the file.
    - Setup: as above.
    - Actions: place cursor on a file row, press `<CR>`.
    - Expected: `open-edit-file` is dispatched / the file opens in a non-magenta
      window.
- Before moving on: confirm tests, type checks, and lint pass.
