Execute an EDL (Edit Description Language) script to perform programmatic file edits.

## Commands

### File commands

```
# file commands
file `path` # Select a file to edit, resets the selection to the entire contents of the file.
newfile `path` # Create a new file (must not already exist)

# selection commands
# patterns can be: heredoc, /regex/
# 5: selects all of line 5  (1-indexed)
# 5:10 selects line 5, column 10
# bof is beginning of file
# eof is end of file
# range patterns combine two positional patterns with `-`:
#   55-70 (line range), 13:5-14:7 (line:col range), bof-eof, bof-55, 55-eof
#   Range patterns create a single selection spanning from the start of the first
#   pattern to the end of the second. Only work with positional patterns (line
#   numbers, line:col, bof, eof) — not with regex or heredoc.
select <pattern>         # Select all matches in the entire document
select_one <pattern>     # Like select, but asserts only one match exists
narrow <pattern>         # Narrow selection to matches within current selection
narrow_one <pattern>     # Like narrow, but asserts only one match exists
retain_first             # Keep just the first selection from multi-selection
retain_last              # Keep just the last selection
select_next <pattern>    # Select next non-overlapping match after current selection
select_prev <pattern>    # Select previous non-overlapping match before current selection
extend_forward <pattern> # Extend selection forward to include next match
extend_back <pattern>    # Extend selection backward to include previous match
```

## Examples

# Simple text replacement using replace:

```
file `src/utils.ts`
select_one <<END
const oldValue = 42;
END
replace <<END
const newValue = 100;
END
```

# delete from pattern to the end of file

```
file `src/file.test`
select_one <<END
describe("test block", () =>
END
extend_forward eof
delete
```

# find some text after a certain line

```
file `src/file.ts`
select 103-eof
narrow_one <<END
function myFunction() {
END
```

# Insert after a match using insert_after:

```
file `src/utils.ts`
select_one <<END
import { foo } from './foo';
END
insert_after <<END

import { bar } from './bar';
END
```

# Create a new file:

```
newfile `src/newModule.ts`
insert_after <<END2
export function hello() {
  return "world";
}
END2
```

# Delete a line using delete:

```
file `src/config.ts`
select_one <<END
const DEBUG = true;
END
extend_forward /$/
delete
```

# Replace part of a line (heredocs don't include surrounding newlines):

file contents before:
const prev = true;
const value = "old-value";
const next = true;

```
file `src/config.ts`
select 2
narrow_one <<END
"old-value"
END
replace <<END
"new-value"
END
```

file contents after:
const prev = true;
const value = "new-value";
const next = true;

# Multiple edits in the same file:

If doing mutiple operations on the same file, use `select` since it always selects from the beginning of the file.

```
file `src/utils.ts`
select_one <<END1
const oldName = "foo";
END1
replace <<END1
const newName = "foo";
END1

select_one <<END2
return oldName;
END2
replace <<END2
return newName;
END2
```

# Replace all instances of an identifier in a function body:

```
file `src/service.ts`
narrow <<FIND
function myMethod(
FIND
extend_forward /^\}/
narrow <<FIND
method
FIND
replace <<REPLACE
this.method
REPLACE
```

# Change all instances of an identifier in a line range:

```
file `src/service.ts`
select 55-150
narrow <<FIND
method
FIND
replace <<REPLACE
this.method
REPLACE
```

## Selecting large blocks of text

**CRITICAL: Avoid using large heredoc patterns for select operations.** Large text blocks are fragile and wasteful. Instead:

1. **Use line ranges** when you know the line numbers: `select 42-58`
2. **Use beginning of text + extend_forward** to match a block by its boundaries:

```
file `src/service.ts`
select_one <<END
function processRequest(
END
extend_forward /^\}/
```

This selects from the function signature through its closing brace, without needing to include the entire function body in the pattern.

3. **Use select + narrow** to find something within a known region:

```
file `src/service.ts`
select 42-58
narrow_one <<END
return result;
END
```

WRONG - using a large heredoc to select a multi-line block:

```
select_one <<END
function processRequest(req: Request) {
  const validated = validate(req);
  const result = transform(validated);
  logger.info("processed", result);
  return result;
}
END
```

RIGHT - selecting by boundaries:

```
select_one <<END
function processRequest(req: Request) {
END
extend_forward /^\}/
```

When doing this be careful to make sure that you're still uniquely identifying the location in the doc.

## Notes on pattern matching

- Patterns match against raw file bytes. Heredoc patterns are literal text and match exactly.
- **Prefer heredoc patterns over regexes** - they are easier to read, less error-prone, and match exactly what you write. Only use regexes when you need their power (wildcards, character classes, etc.).
- For regex, to match a literal backslash in the file, escape it with another backslash (e.g. /\\/ matches a single backslash).
- When pattern matching is difficult due to complex escaping, use line-number selection (e.g. select 42:) as a fallback.
