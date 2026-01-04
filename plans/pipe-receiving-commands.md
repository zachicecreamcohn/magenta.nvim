# Context

The goal is to allow commands like `head`, `grep`, `wc`, etc. to be used without file arguments when they're receiving input via a pipe.

Currently:

- `cat file.txt | head` fails because `head` requires a file argument in the config
- `head file.txt` works because it matches the configured arg pattern

We want:

- `cat file.txt | head` to work (head is receiving via pipe, no file needed)
- `head` alone should still require a file argument
- `head -n 10` receiving via pipe should work with just the `-n 10` flags

## Current Architecture

### Parser (`node/tools/bash-parser/parser.ts`)

- `ParsedCommand`: `{ executable: string, args: string[] }`
- `ParsedCommandList`: `{ commands: ParsedCommand[] }`
- The parser flattens all commands - no information about pipe relationships is preserved

### Lexer (`node/tools/bash-parser/lexer.ts`)

- Operators: `["&&", "||", "|", ";"]`
- All operators are treated equally, just used as command separators

### Permissions (`node/tools/bash-parser/permissions.ts`)

- `CommandSpec`: `{ subCommands?, args?, allowAll? }`
- Each command is validated independently via `checkCommandListPermissions`

## Key Insight

When a command is receiving input via pipe (`|`), it typically:

1. Doesn't need file arguments (reads from stdin instead)
2. Still needs its option/flag arguments validated
3. Should still be in the allowlist

## Design Decision

Track pipe position in parsed commands AND add a new `pipeArgs` array.

- Track `receivingPipe: boolean` in `ParsedCommand`
- Add `pipeArgs?: ArgSpec[][]` to `CommandSpec` alongside `args`
- When a command is receiving via pipe, validate against `pipeArgs` instead of `args`

This gives full control over what arguments are allowed in piped vs standalone contexts.

# Implementation

- [x] **Phase 1: Parser changes to track pipe relationships**
  - [x] Update `ParsedCommand` type to include `receivingPipe: boolean`
  - [x] Modify parser to track when a command follows a `|` operator
  - [x] Update parser tests to verify pipe tracking
  - [x] Run `npx tsc --noEmit` to check for type errors

- [x] **Phase 2: Add `pipeArgs` to CommandSpec**
  - [x] Add `pipeArgs?: ArgSpec[][]` to `CommandSpec` in `node/tools/bash-parser/permissions.ts`
  - [x] Add same field to `node/options.ts` (the types are duplicated)
  - [x] Update `parseCommandSpec` in `node/options.ts` to parse `pipeArgs` (same parsing logic as `args`)
  - [x] Run `npx tsc --noEmit` to check for type errors

- [x] **Phase 3: Permission checking logic**
  - [x] Update `checkCommandSpec` to accept `receivingPipe` parameter
  - [x] When `receivingPipe: true` and `pipeArgs` is defined, validate against `pipeArgs` instead of `args`
  - [x] Update `checkCommandListPermissions` to pass `receivingPipe` to `checkCommandSpec`
  - [x] Run `npx tsc --noEmit` to check for type errors

- [x] **Phase 4: Tests**
  - [x] Add parser tests for `receivingPipe` tracking
  - [x] Add permission tests for `pipeArgs` validation
  - [x] Test that non-piped commands still use `args` validation
  - [x] Test complex pipelines like `cat file | grep pattern | head -n 5`
  - [x] Test that `pipeArgs` patterns are properly validated (not just allow-all)
  - [x] Run `npx vitest run node/tools/bash-parser/`

- [x] **Phase 5: Update default config**
  - [x] Add `pipeArgs` to `head`, `tail`, `grep`, `wc`, `sort`, `uniq`, etc. in `lua/magenta/options.lua`

## Example Configurations

After implementation:

```lua
commandConfig = {
  head = {
    pipeArgs = {
      {},  -- no args required when piped
      { { type = "group", args = { "-n", { type = "any" } }, optional = true } },  -- optional -n flag
    },
    args = {
      -- Existing patterns for standalone use (requires file)
      { { type = "group", args = { "-n", { type = "any" } }, optional = true }, { type = "file" } },
    }
  },
  grep = {
    pipeArgs = {
      { { type = "any" } },  -- just pattern, no file needed
      { { type = "group", args = { "-i" }, optional = true }, { type = "any" } },  -- optional -i flag + pattern
    },
    args = {
      { { type = "any" }, { type = "file" } },  -- grep pattern file
    }
  },
  wc = {
    pipeArgs = {
      {},  -- no args
      { "-l" },  -- just -l flag
    },
    args = {
      { { type = "group", args = { "-l" }, optional = true }, { type = "file" } }
    }
  }
}
```

Usage:

```bash
# Piped commands - validated against pipeArgs:
cat file.txt | head           # matches pipeArgs: {}
cat file.txt | head -n 10     # matches pipeArgs: { -n, any }
cat file.txt | grep pattern   # matches pipeArgs: { any }
cat file.txt | wc -l          # matches pipeArgs: { "-l" }

# Standalone commands - validated against args:
head -n 10 file.txt           # matches args: { -n, any, file }
grep pattern file.txt         # matches args: { any, file }
wc -l file.txt                # matches args: { -l, file }
```
