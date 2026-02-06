Execute an EDL (Edit Description Language) script to perform programmatic file edits.

## Commands

### File commands

```
# file commands
file `path` # Select a file to edit, resets the selection to the entire contents of the file.
newfile `path` # Create a new file (must not already exist)

# selection commands
# patterns can be: heredoc, /regex/, line number like `5:`, line:col like `5:10`, `bof`, `eof`
narrow <pattern>         # Narrow selection to all matches of pattern
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
narrow_one <<END
const oldValue = 42;
END
replace <<END
const newValue = 100;
END
```

# Insert after a match using insert_after:

```
file `src/utils.ts`
narrow_one <<END
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
narrow_one /const DEBUG = true;.\*\\n/
delete
```

# Replace part of a line (heredocs don't include surrounding newlines):

file contents before:
const prev = true;
const value = "old-value";
const next = true;

```
file `src/config.ts`
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

If doing mutiple operations on the same file, use `file` again to reset selection to the whole document before narrowing to the next edit location.

```
file `src/utils.ts`
narrow_one <<END1
const oldName = "foo";
END1
replace <<END1
const newName = "foo";
END1

file `src/utils.ts`
narrow_one <<END2
return oldName;
END2
replace <<END2
return newName;
END2
```

# Replace all instances of an identifier in a function body:

```
file `src/service.ts`
narrow_one /function myMethod\(/
extend_forward /^\}/
narrow /func/
replace <<REPLACE
this.func
REPLACE
```

## Notes on pattern matching

- Patterns match against raw file bytes. Heredoc patterns are literal text and match exactly.
- **Prefer heredoc patterns over regexes** - they are easier to read, less error-prone, and match exactly what you write. Only use regexes when you need their power (wildcards, character classes, etc.).
- For regex, to match a literal backslash in the file, escape it with another backslash (e.g. /\\/ matches a single backslash).
- When pattern matching is difficult due to complex escaping, use line-number selection (e.g. select 42:) as a fallback.
