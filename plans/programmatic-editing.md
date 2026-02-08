# Design Doc: Declarative Text Editing for Coding Agents

## Status: Early Exploration

## Goal

Replace the find-and-replace editing tools used by coding agents with a single tool that accepts a **declarative edit script** — a short program that composes text selections and mutations. This should eliminate verbatim text duplication, remove the uniqueness burden on pattern matching, and express complex edits (moves, scoped renames, multi-site changes) in a single tool call.

## Design

### Edit Scripts

The tool accepts a script in a small DSL. Scripts are self-contained against the file contents — the agent reads the file (already in context), writes a script that addresses locations by content patterns (regexes) or AST structure, and the tool executes the whole thing atomically. No file changes are written unless the entire script succeeds. Registers persist across `file` commands within the same script, enabling cross-file moves.

### Syntax

Each line is a command followed by whitespace-separated parameters. `#` begins a line comment.

**Patterns** can be:

- Regexes: `/pattern/` with standard flags (e.g. `/pattern/i`)
- Literal strings via heredoc
- Line/column: `55` or `55:` selects the entire line. `55:10` selects position at line 55, column 10 (0-indexed columns).
- Special tokens: `bof` (beginning of file), `eof` (end of file)

**Text arguments** (for replace, insert, etc.) use heredoc with author-chosen delimiter.

**Registers** are alphanumeric strings, starting with a letter, with no whitespace except \_

```
replace <<END
replacement text here
END

# multiline insert with heredoc
insert_after <<END
line one
line two
END

# heredoc delimiter is arbitrary
insert_before <<BLOCK
some code
BLOCK

# literal string pattern via heredoc
select <<FIND
exact text to find
FIND

# select a specific line
select 55

# select a range of lines (1 through 100, inclusive)
select 1
extend_forward 100

# extend to end of file
extend_forward eof

# reset selection to full file by re-selecting current file
file src/myfile.ts
```

The script starts with the whole document selected. It runs all the way through, making changes to the file.

### Output

The tool returns a summary after execution:

1. **Per-command trace** — each command produces a `line:col` range and a snippet of the matched/selected text. This is the same output shown in dry-run mode.
2. **Final selection** — the active selection at script exit, with range and snippet.
3. **Mutation summary** — total insertions, deletions, and replacements applied, per file.

**Snippet rules:**

- The snippet shows only the selected text, not surrounding context.
- For multi-line selections, show the first and last lines with `...` in between.
- Long lines are truncated to N characters total: show the start, `...`, then the end of the selected text on that line.
- For single-line selections that are very long, same truncation: `starttext...endtext` (total ≤ N chars).

Example output:

```
file src/app.ts
switched to src/app.ts (142 lines)

select_first /handleRequest/
matched 34:9-34:22
handleRequest

extend_forward /^}/
selection 34:9-52:1
handleRequest(req: Request) {
...
}

delete
deleted 19 lines (34:0-52:1)

Final selection: 34:0-34:-1
function nextFunction() {

Mutations: src/app.ts: 1 deletion (19 lines removed)
```

### Operations

#### Selection

| Command                    | Description                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `select /pattern/`         | Set selection to all matches in current scope. Refines within existing selection. Errors if no match.   |
| `select_first /pattern/`   | Select only the first match in current scope. Errors if no match.                                       |
| `select_last /pattern/`    | Select only the last match in current scope. Errors if no match.                                        |
| `select_one /pattern/`     | Select the single match in current scope. Errors if zero or more than one match.                        |
| `select_next /pattern/`    | Move to next occurrence of pattern after current selection end. Single-select only.                     |
| `select_prev /pattern/`    | Move to previous occurrence of pattern before current selection start. Single-select only.              |
| `extend_forward /pattern/` | Extend selection forward: search from end of current selection, result is union. Single-select only.    |
| `extend_back /pattern/`    | Extend selection backward: search from start of current selection, result is union. Single-select only. |
| `nth N`                    | From a multi-select, keep only the Nth match (0-indexed, negative indexes from end).                    |
| `file filepath`            | Switch to file, selecting its entire contents (absolute file paths, resolving ~).                       |

#### Mutation

| Command              | Description                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `replace text`       | Replace current selection, each instance in a multiselect gets replaced with text. Text is a heredoc. |
| `delete`             | Delete current selection.                                                                             |
| `insert_before text` | Insert text before selection (before every selection in multi-select). Text is a heredoc.             |
| `insert_after text`  | Insert text after current selection. Text is a heredoc.                                               |
| `cut register`       | Cut current selection to a named register. Fails on multi-select.                                     |
| `paste register`     | Paste from named register at current position. Fails on multi-select.                                 |

### Dry-Run Verification

The primary risk is silent mis-selection — a pattern matching something the agent didn't intend. The tool supports a **dry-run mode** that returns what the script would do without applying it:

```
file src/handlers.go
switched to src/handlers.go (89 lines)

select_first /func processOrder/
matched 12:0-12:58
func processOrder(ctx context.Context, order Order) error {

extend_forward /^}/
selection 12:0-45:1
func processOrder(ctx context.Context, order Order) error {
...
}

cut a
34 lines stored in register "a"
12:0-45:1 would be removed

file src/orders.go
switched to src/orders.go (23 lines)

select_last /^package/
matched 1:0-1:14
package orders

insert_after <<CODE
(contents of register "a")
CODE
34 lines would be inserted after 1:14
```

For simple edits, the agent skips dry-run and applies directly. For complex or multi-file edits, one extra round trip for confirmation.

### Token Efficiency

Moving a 200-line function between files:

| Approach           | Agent output                                                        |
| ------------------ | ------------------------------------------------------------------- |
| Find/replace tools | ~400+ lines (full text generated twice plus context for uniqueness) |
| Edit script        | ~6 lines of script                                                  |

Scoped rename:

| Approach     | Agent output                               |
| ------------ | ------------------------------------------ |
| Find/replace | Full match context + full replacement text |
| Edit script  | One line                                   |

### Open Questions

**Tree-sitter integration.** Should there be `select_ast` commands that select by tree-sitter node type (function, class, etc.)? If so, universal abstractions or language-specific node types? This could be deferred to a later iteration.

## Next Steps

1. Prototype the DSL interpreter as a standalone CLI.
2. Implement core operations: select (regex), select_ast (tree-sitter), within, replace, delete, insert, cut/paste with registers.
3. Implement dry-run mode.
4. Test with an LLM: measure script generation reliability across a corpus of real editing tasks.
5. Compare token usage and correctness against baseline find/replace tools.
