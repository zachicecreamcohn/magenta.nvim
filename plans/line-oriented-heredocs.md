# context

## Objective

Change EDL so that **heredoc patterns in selection commands always match complete lines**, with the selection including the trailing `\n`. This makes the common case (selecting/inserting whole lines) natural and eliminates newline confusion when agents use `insert_after`.

### Design Rules

1. **Selection heredocs** (`select`, `narrow`, `extend_forward`, `select_next`, etc.) — match the heredoc text but only when it appears as complete line(s). The resulting selection includes the trailing `\n` (or extends to EOF for the last line).
2. **Mutation heredocs** (`replace`, `insert_before`, `insert_after`) — raw text, no automatic `\n` added. Same as today.
3. **Regex patterns** — unchanged. They handle arbitrary substring matching when needed.

### Key Semantic Change

Given a file `"aaa\nbbb\nccc\n"`:

- **Today**: `select <<END\nbbb\nEND` matches `"bbb"` (bytes 4-7). `insert_after` text goes right after `"bbb"`, appending to the same line.
- **After**: `select <<END\nbbb\nEND` matches `"bbb\n"` (bytes 4-8). `insert_after` text starts on a new line because the selection includes the `\n`.

For the last line without trailing `\n` (e.g. `"aaa\nbbb"`): the selection of `"bbb"` is `"bbb"` (bytes 4-7, no trailing `\n` to capture). This is the only case where a heredoc line-match doesn't include a trailing newline — because there is none. However, `insert_after` on a line selection will still insert on a new line in this case (see below).

### Line Selection Flag

Selections produced by heredoc/literal pattern matches are tagged with `isLineSelection: true`. This flag is propagated through selection commands (narrow, extend, etc.) when the pattern is a literal. Regex and positional patterns do not set this flag.

**`insert_after` behavior with line selections**: When `insert_after` operates on a line selection whose range does not end with `\n` (i.e. last line at EOF), it prepends `\n` to the inserted text. This ensures `insert_after` on a heredoc-selected line always inserts on a new line, even at EOF. Without the flag (regex selections), `insert_after` behaves as today — raw insertion at the selection end.

### Relevant Files

- `node/core/src/edl/executor.ts` — `findInText()` method handles pattern matching. The `literal` case is where the change goes.
- `node/core/src/edl/parser.ts` — Pattern types. We may need to distinguish `literal` (from heredoc) vs a hypothetical future inline-string type, but currently regex handles substring cases, so no parser changes needed.
- `node/core/src/edl/document.ts` — `Document` class with `content`, `lineStarts`, `lineRange()`. We'll use `lineStarts` to verify line boundaries.
- `node/core/src/edl/executor.test.ts` — Most tests will need updating since literal matches will now include trailing `\n`.
- `node/core/src/edl/parser.test.ts` — No changes expected (parser doesn't change).
- `node/core/src/tools/edl-description.md` — Update documentation to describe line-oriented heredoc behavior.

### Algorithm for Line-Oriented Literal Matching

In `findInText()`, for the `literal` pattern case:

1. Find all substring occurrences of `pattern.text` within `text` (same as today).
2. For each occurrence at position `idx` (relative to `text`):
   - Compute the absolute position: `absStart = baseOffset + idx`.
   - Verify `absStart` is at a line boundary: either `absStart === 0` or `doc.content[absStart - 1] === '\n'`.
   - Compute `absEnd = absStart + pattern.text.length`.
   - Verify `absEnd` is at a line boundary: either `absEnd === doc.content.length` or `doc.content[absEnd] === '\n'`.
   - If both boundaries check out, the match range is `{start: absStart, end: absEnd + 1}` when `doc.content[absEnd] === '\n'` (to include the trailing newline), or `{start: absStart, end: absEnd}` when at EOF.
3. Return all valid matches.

This means the heredoc text `"bbb"` will only match the substring `"bbb"` when it starts at a line start and ends at a line end (before `\n` or at EOF). The returned range includes the trailing `\n` if present.

# implementation

- [x] **Step 1: Implement line-oriented literal matching in executor**
  - [x] In `executor.ts` `findInText()`, modify the `case "literal"` branch:
    - After finding a substring match at `idx`, check that `baseOffset + idx` is at a line start and `baseOffset + idx + pattern.text.length` is at a line end.
    - If the match ends at a `\n`, extend the range end by 1 to include it.
    - Skip matches that don't fall on line boundaries.
    - Set `isLineSelection: true` on the resulting ranges.
  - [x] Add `isLineSelection: boolean` flag to the `Range` type (or introduce a `Selection` type wrapping `Range` + metadata).
  - [x] Update `insert_after` to check `isLineSelection`: if true and the selection doesn't end with `\n`, prepend `\n` to inserted text.
  - [x] Run type checking: `npx tsgo -p node/core/tsconfig.json --noEmit`

- [x] **Step 2: Update executor tests**
  - [x] Go through every test in `executor.test.ts` that uses heredoc patterns and update expected results to account for line-inclusive selections.
  - [x] Key changes:
    - Tests that `select` a heredoc and then `replace` — the replacement now replaces the selected text **including the trailing `\n`**. Many tests will need the replacement text to include a trailing `\n`, or the file content expectation to change.
    - `insert_after` on a heredoc-selected line now inserts after the `\n`, which means it naturally starts a new line.
    - `insert_before` on a heredoc-selected line now inserts before the line start (same as before, since start didn't change).
    - Tests using `narrow` with a heredoc inside a line (e.g. `narrow <<END\n"old-value"\nEND`) — these will now fail because `"old-value"` doesn't sit on its own line. These tests should be converted to use regex patterns instead.
  - [x] Add edge case tests for `insert_after` + line selection at EOF:
    - Regex `insert_after` on last line appends to same line (no `\n` added)
    - Heredoc `insert_after` on last line without trailing `\n` creates a newline before inserted text
    - Heredoc `insert_after` on last line with trailing `\n` does NOT double the newline
  - [x] Run tests: `npx vitest run node/core/src/edl/executor.test.ts`
  - [x] Iterate until all tests pass

- [x] **Step 3: Update EDL description/documentation**
  - [x] Update `node/core/src/tools/edl-description.md` to:
    - Document that heredoc patterns in selection commands match complete lines only
    - Document that the selection includes the trailing `\n`
    - Update examples to reflect the new behavior
    - Note that regex should be used for partial-line matching
    - Update the `insert_after` examples to show the natural line behavior
    - Update the "Replace part of a line" example to use regex instead of nested heredoc narrow

- [x] **Step 4: Final validation**
  - [x] Run full EDL test suite: `npx vitest run node/core/`
  - [x] Run type checking: `npx tsgo -b`
  - [x] Run linting: `npx biome check .`

