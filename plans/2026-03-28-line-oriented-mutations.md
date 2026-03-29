# context

## Objective

Complete the line-oriented EDL redesign by making **heredoc mutation text line-oriented** (auto-appending `\n`) and adding **quoted string syntax** for inline/raw mutation text. This builds on the line-oriented heredoc selection work already completed.

### Current State

After the line-oriented selection changes:

- Heredoc patterns in selection commands match complete lines and include trailing `\n`.
- Mutation heredocs (`replace`, `insert_before`, `insert_after`) still use raw text — no auto `\n`.
- This creates an asymmetry: selecting a line with a heredoc gives `"bbb\n"`, but replacing with a heredoc gives `"BBB"` (no `\n`), eating the newline.

### Design

**Heredocs in mutations append `\n`**: When `replace`, `insert_before`, or `insert_after` use a heredoc, the text gets a trailing `\n` appended automatically. This means:

```
replace <<END
BBB
END
```

produces replacement text `"BBB\n"`, not `"BBB"`.

**Quoted strings for inline/raw text** (new): A new syntax for mutation commands that provides raw text with no auto `\n`:

```
replace "new_name"
insert_after " extra"
```

Escape sequences in quoted strings: `\"` for literal quote, `\\` for literal backslash. No other escapes — keep it simple and literal.

**Registers remain raw**: Register-based mutations (`replace myReg`) continue to use the register text as-is.

### Mental Model Summary

| Syntax                | Selection                                             | Mutation                     |
| --------------------- | ----------------------------------------------------- | ---------------------------- |
| Heredoc `<<END...END` | Line-oriented (matches complete lines, includes `\n`) | Line-oriented (appends `\n`) |
| Regex `/pattern/`     | Inline/substring                                      | N/A (not used for mutations) |
| Quoted `"text"`       | N/A (not used for selections)                         | Inline/raw (no `\n`)         |
| Register `name`       | N/A                                                   | Raw (no `\n`)                |

### Relevant Files

- `node/core/src/edl/parser.ts` — Lexer needs new `quoted` token type. `MutationText` type needs a new variant to distinguish heredoc text from quoted text. Mutation command parsing needs to accept quoted tokens.
- `node/core/src/edl/executor.ts` — `resolveText()` method needs to append `\n` for heredoc-sourced text. `insert_after` logic for `isLineSelection` EOF case may need revisiting since heredoc mutations now always include `\n`.
- `node/core/src/edl/executor.test.ts` — Tests using heredoc mutations need updating (replacement text now includes `\n`). New tests for quoted string mutations.
- `node/core/src/edl/parser.test.ts` — New tests for quoted string lexing and parsing.
- `node/core/src/tools/edl-description.md` — Update documentation.
- `node/core/src/edl/index.ts` — May need minor updates if types change.

### Heredoc `\n` always appended (option 2)

Heredoc mutations always append `\n`, regardless of selection type. The `\n` is a property of the heredoc text, not the selection. This is the simplest rule and makes `bof`/`eof` insertion patterns work naturally. If an agent uses heredoc replace on an inline regex selection, they get a newline — that's why quoted strings exist for inline work.

### Impact on `insert_after` with `isLineSelection`

File `"aaa\nbbb"`, `select <<X\nbbb\nX` → selects `"bbb"` (EOF, `isLineSelection: true`).

- `insert_after <<Y\ntext\nY` → mutation text becomes `"text\n"` (with auto `\n`).
- The `isLineSelection` EOF logic prepends another `\n`, giving `"\ntext\n"`.
- Result: `"aaa\nbbb\ntext\n"` — correct. The prepend separates lines, the heredoc `\n` terminates the inserted line.

File `"aaa\nbbb\n"`, `select <<X\nbbb\nX` → selects `"bbb\n"`.

- `insert_after <<Y\ntext\nY` → mutation text is `"text\n"`. Selection ends with `\n`, so no prepend. Result: `"aaa\nbbb\ntext\n"`. Correct.

### Documentation: all inline mutation examples must use quoted strings

The edl-description.md must be updated so that any example using an inline/partial-line mutation uses quoted strings instead of heredocs. Heredoc mutations are for inserting/replacing whole lines.

# implementation

- [x] **Step 1: Add quoted string token to lexer**
  - [x] Add `{ type: "quoted"; value: string }` to the `Token` union in `parser.ts`
  - [x] Add lexer branch for `"` that reads until closing `"`, handling `\"` and `\\` escapes
  - [x] Add parser tests for quoted string lexing (basic, with escapes, unterminated error)
  - [x] Run parser tests: `npx vitest run node/core/src/edl/parser.test.ts`

- [x] **Step 2: Update MutationText and mutation command parsing**
  - [x] Extend `MutationText` type: `{ text: string } | { register: string }` → `{ text: string; isHeredoc: boolean } | { register: string }`
  - [x] Update mutation command parsing (`replace`, `insert_before`, `insert_after`) to accept `quoted` tokens (setting `isHeredoc: false`) in addition to `heredoc` tokens (setting `isHeredoc: true`)
  - [x] Add parser tests for `replace "text"`, `insert_after "text"`, `insert_before "text"`
  - [x] Run type checking: `npx tsgo -p node/core/tsconfig.json --noEmit`
  - [x] Fix any type errors from the `MutationText` change (executor's `resolveText`, index.ts etc.)

- [x] **Step 3: Implement line-oriented heredoc mutations in executor**
  - [x] Modify `resolveText()` (or the call sites) to append `\n` when the mutation text comes from a heredoc (`isHeredoc: true`)
  - [x] Verify `insert_after` isLineSelection EOF logic still works correctly with the new `\n` appending
  - [x] Run type checking: `npx tsgo -p node/core/tsconfig.json --noEmit`

- [x] **Step 4: Update executor tests**
  - [x] Go through tests using heredoc mutations and update expectations:
    - `replace <<END\ntext\nEND` now produces `"text\n"` instead of `"text"`
    - Most tests that select a line (heredoc) and replace with a heredoc should "just work" since both now include `\n`
    - Tests that select with regex and replace with heredoc will now get an extra `\n` — convert these to use quoted strings
  - [x] Add new tests for quoted string mutations:
    - `replace "text"` after regex select (inline replacement, no `\n`)
    - `insert_after "text"` (inline insertion)
    - `insert_before "text"` (inline insertion)
    - Quoted string with escapes: `replace "say \"hello\""`
  - [x] Run tests: `npx vitest run node/core/src/edl/executor.test.ts`
  - [x] Iterate until all tests pass

- [x] **Step 5: Update documentation**
  - [x] Update `node/core/src/tools/edl-description.md`:
    - Document that heredoc mutations are line-oriented (append `\n`)
    - Document quoted string syntax for inline mutations
    - Update mutation command syntax to show all three forms: heredoc, quoted, register
    - Update examples
  - [x] Update the system prompt EDL description (same file) to reflect the new syntax

- [x] **Step 6: Final validation**
  - [x] Run full core test suite: `npx vitest run node/core/`
  - [x] Run type checking: `npx tsgo -b`
  - [x] Run linting: `npx biome check .`

