# Plan: JSON-based Command Permission Format

## Context

The goal is to replace the current `ArgSpec[][]` command permission format with a more declarative, JSON-friendly format inspired by yargs-style command descriptions. This involves:

1. Defining a new JSON schema for command rules
2. Moving builtin permissions from TypeScript (`BUILTIN_COMMAND_PERMISSIONS`) to a JSON file
3. Replacing the matching engine with a simpler two-phase approach (extract flags/options, then match positionals)
4. Updating user-facing config parsing and the `update-permissions` skill

### Current format (ArgSpec[][])

Each allowed command is an array of `ArgSpec` elements that must match left-to-right:

```json
[
  "grep",
  { "type": "group", "args": ["-i"], "optional": true },
  { "type": "any" },
  { "type": "restFiles" }
]
```

Problems:

- Order-dependent by default, requiring `group` + `anyOrder` for flags that can appear in any order
- Nested groups are confusing to read and write
- Not intuitive for users editing `options.json`
- Tightly coupled to TypeScript types, awkward as JSON

### New format (CommandRule)

Each rule is a tree describing the command shape. Simple commands are flat objects; commands with subcommands use recursive nesting:

```json
{ "cmd": "grep", "flags": ["-i"], "args": ["any"], "rest": "readFiles" }

{
  "cmd": "git",
  "options": { "-C": "any" },
  "subcommands": [
    { "cmd": "status", "flags": ["--short"], "rest": "any" },
    { "cmd": "commit", "options": { "-m": "any" }, "rest": "any" }
  ]
}
```

Advantages:

- Flags/options are order-independent by design
- No nested groups — replaced by recursive `subcommands`
- Reads like a yargs command tree
- Per-level option scoping (git's `-C` vs commit's `-m`)
- DRY — parent options defined once, shared across subcommands
- Same format for builtins and user config

### Relevant files

- `node/capabilities/bash-parser/permissions.ts` — current `ArgSpec`, `CommandPermissions`, `BUILTIN_COMMAND_PERMISSIONS`, and all matching logic (`matchSingleSpec`, `matchGroup`, `matchArgsPattern`, `checkCommand`, `checkCommandListPermissions`, `isCommandAllowedByConfig`)
- `node/capabilities/bash-parser/permissions.test.ts` — extensive tests for the matching engine
- `node/options.ts` — `parseArgSpec()`, `parseCommandPatterns()`, `parseCommandConfig()`, `mergeCommandConfig()`, and re-exports of `ArgSpec`/`CommandPermissions`
- `node/capabilities/permission-shell.ts` — calls `isCommandAllowedByConfig()` with `options.commandConfig`
- `node/skills/update-permissions/skill.md` — documents the current user-facing format

### New types

```typescript
/** Value type for an option that takes a value */
export type OptionValueType =
  | "any" // any value
  | "readFile" // value is a readable file path (permission-checked)
  | "writeFile" // value is a writable file path (checks write, which subsumes read)
  | { pattern: string }; // value must match regex

/** A single command rule — recursive tree structure */
export type CommandRule = {
  /** Command or subcommand name (single string, not an array) */
  cmd: string;
  /** Boolean flags — no value, order-independent, all optional */
  flags?: string[];
  /** Options that take a value — order-independent, all optional */
  options?: Record<string, OptionValueType>;
  /** Subcommands — if present, after extracting this level's flags/options,
      the next remaining arg must match one of these subcommands.
      Mutually exclusive with args/rest/pipe. */
  subcommands?: CommandRule[];
  /** Positional arguments, in order (leaf nodes only) */
  args?: ArgType[];
  /** What to do with remaining args after positionals (leaf nodes only) */
  rest?: "any" | "readFiles" | "writeFiles";
  /** If true, this rule only applies when receiving pipe input (leaf nodes only) */
  pipe?: boolean;
};

/** Positional argument type */
export type ArgType =
  | "any" // any single value
  | "readFile" // a readable file path
  | "writeFile" // a writable file path (subsumes read)
  | { pattern: string } // must match regex
  | { type: "any" | "readFile" | "writeFile"; optional?: boolean };

/** The full permissions config */
export type CommandPermissionsConfig = {
  rules: CommandRule[];
};
```

### Matching semantics

Matching is recursive, following the tree structure:

**`matchRule(args, rule, ctx):`**

1. **Match `cmd`** — first arg must equal `rule.cmd`. Consume it.
2. **Extract flags/options** — scan remaining args left-to-right:
   - If an arg matches a known `flag` → consume it, mark as seen
   - If an arg matches a known `option` key → consume it + the next arg as the value. Validate the value against the option's type (`readFile` → permission check, `pattern` → regex check, etc.)
   - Also handle `--key=value` syntax: split on first `=`, check if `--key` is a known option
   - Otherwise → **leave the arg in the "remaining" list** (do NOT reject unrecognized `-` prefixed args — they may be positional args like `head -10`)
3. **Branch: subcommands vs leaf**
   - If `rule.subcommands` is present: the next remaining arg must match the `cmd` of one of the subcommands. Recursively call `matchRule` on that subcommand with the remaining args.
   - If leaf (no subcommands): proceed to positional/rest matching.
4. **Positional phase** (leaf only) — match the "remaining" list left-to-right against `args[]`. Each `ArgType` is validated: `"any"` accepts anything, `"readFile"` checks permissions, `{ pattern }` checks regex, optional args can be skipped.
5. **Rest phase** (leaf only) — if `rest` is specified, validate any leftover args accordingly (`"any"` accepts all, `"readFiles"` permission-checks each as readable, `"writeFiles"` as writable). If no `rest`, reject any leftover args.

**Top level:** a command is allowed if it matches ANY top-level rule in the config. For leaf rules with `pipe: true`, the rule only applies when the command is receiving pipe input; rules without `pipe` (or `pipe: false`) only apply to non-piped commands.

### Expressivity notes

**Option values as file paths:** Options support the full `OptionValueType`, so `"-o": "writeFile"` will permission-check the value as a writable path. Example: `{ "cmd": "sort", "options": { "-o": "writeFile" }, "args": ["readFile"] }` allows `sort -o output.txt input.txt` with proper permission checks on both files.

**`--key=value` syntax:** During extraction, `--output=file.txt` is split into key `--output` and value `file.txt` if `--output` is a known option. If not known, the whole token passes through to positional matching.

**Unrecognized `-` args:** Not rejected during extraction — they fall through to positional matching. This handles `head -10 file.txt` where `-10` is a positional matching `{ "pattern": "-[0-9]+" }`.

**Combined short flags:** `grep -il` as a single token won't match separate `-i` and `-l` flags. This is the same limitation as the current system and is acceptable — the combined form gets a permission prompt.

**Repeated options:** Not supported (e.g., `grep -e pat1 -e pat2`). Users can use a more permissive rule or approve manually. Can be added later if needed.

### Builtin permissions in JSON

The current `BUILTIN_COMMAND_PERMISSIONS` constant moves to `node/capabilities/bash-parser/builtin-permissions.json`:

```json
{
  "rules": [
    { "cmd": "ls", "rest": "any" },
    { "cmd": "pwd" },
    { "cmd": "echo", "rest": "any" },
    { "cmd": "cat", "args": ["readFile"] },
    { "cmd": "head", "options": { "-n": "any" }, "args": ["readFile"] },
    { "cmd": "head", "args": [{ "pattern": "-[0-9]+" }, "readFile"] },
    { "cmd": "tail", "options": { "-n": "any" }, "args": ["readFile"] },
    { "cmd": "tail", "args": [{ "pattern": "-[0-9]+" }, "readFile"] },
    { "cmd": "wc", "flags": ["-l"], "args": ["readFile"] },
    { "cmd": "grep", "flags": ["-i"], "args": ["any"], "rest": "readFiles" },
    { "cmd": "sort", "args": ["readFile"] },
    { "cmd": "uniq", "args": ["readFile"] },
    {
      "cmd": "cut",
      "options": { "-d": "any", "-f": "any" },
      "args": ["readFile"]
    },
    { "cmd": "awk", "args": ["any", "readFile"] },
    { "cmd": "sed", "args": ["any", "readFile"] },
    {
      "cmd": "git",
      "options": { "-C": "any", "-c": "any" },
      "subcommands": [
        { "cmd": "status", "rest": "any" },
        { "cmd": "log", "rest": "any" },
        { "cmd": "diff", "rest": "any" },
        { "cmd": "show", "rest": "any" },
        { "cmd": "add", "rest": "any" },
        { "cmd": "commit", "rest": "any" },
        { "cmd": "push", "rest": "any" },
        { "cmd": "reset", "rest": "any" },
        { "cmd": "restore", "rest": "any" },
        { "cmd": "branch", "rest": "any" },
        { "cmd": "checkout", "rest": "any" },
        { "cmd": "switch", "rest": "any" },
        { "cmd": "fetch", "rest": "any" },
        { "cmd": "pull", "rest": "any" },
        { "cmd": "merge", "rest": "any" },
        { "cmd": "rebase", "rest": "any" },
        { "cmd": "tag", "rest": "any" },
        { "cmd": "stash", "rest": "any" }
      ]
    },
    {
      "cmd": "rg",
      "flags": ["-l"],
      "options": { "--type": "any" },
      "args": ["any"],
      "rest": "readFiles"
    },
    {
      "cmd": "fd",
      "options": { "-t": "any", "-e": "any" },
      "args": [{ "type": "any", "optional": true }],
      "rest": "readFiles"
    },

    { "cmd": "awk", "rest": "any", "pipe": true },
    { "cmd": "cut", "rest": "any", "pipe": true },
    { "cmd": "grep", "rest": "any", "pipe": true },
    { "cmd": "head", "rest": "any", "pipe": true },
    { "cmd": "rg", "rest": "any", "pipe": true },
    { "cmd": "sed", "rest": "any", "pipe": true },
    { "cmd": "sort", "rest": "any", "pipe": true },
    { "cmd": "tail", "rest": "any", "pipe": true },
    { "cmd": "tr", "rest": "any", "pipe": true },
    { "cmd": "uniq", "rest": "any", "pipe": true },
    { "cmd": "wc", "rest": "any", "pipe": true },
    { "cmd": "xargs", "rest": "any", "pipe": true }
  ]
}
```

## Implementation

### Phase 1: New types and matching engine (alongside old code)

- [x] Define new types `CommandRule`, `ArgType`, `CommandPermissionsConfig` in `node/capabilities/bash-parser/permissions.ts`
- [x] Write new matching function `checkCommandAgainstRule(command: ParsedCommand, rule: CommandRule, ctx: MatchContext): { matches: boolean; reason?: string }`
  - Match `cmd` prefix
  - Extract flags/options from remaining args (order-independent)
  - Match positionals left-to-right
  - Handle `rest`
- [x] Write new top-level function `isCommandAllowedByRules(command: string, config: CommandPermissionsConfig, options: {...}): PermissionCheckResult`
  - Parses command string
  - Iterates `config.rules`, filtering by `pipe` field based on `receivingPipe`
  - Returns allowed if any rule matches
- [x] Check for type errors and iterate until clean

### Phase 2: Tests for new matching engine

- [x] Write tests for `checkCommandAgainstRule` covering:
  - Simple commands (`ls`, `pwd`)
  - Commands with `rest: "any"`
  - File arguments (`readFile`, `writeFile`)
  - Flags (present and absent)
  - Options with values
  - Subcommands (`["git", "status"]`)
  - Pattern args
  - Optional positional args
  - Pipe vs non-pipe rules
  - Flag/option order independence
  - Unknown flags rejected
  - Extra args rejected when no `rest`
- [x] Write tests for `isCommandAllowedByRules` covering:
  - Builtin permissions loaded from JSON
  - User rules merged with builtins
  - Parse errors handled gracefully
- [x] Iterate until all tests pass

### Phase 3: Create builtin permissions JSON file

- [x] Create `node/capabilities/bash-parser/builtin-permissions.json` with all current builtins translated to new format
- [x] Write a loading function that reads and validates the JSON, returning `CommandPermissionsConfig`
- [x] Add a test that loads the JSON and verifies it parses correctly
- [x] Add parity tests: for each command tested against `BUILTIN_COMMAND_PERMISSIONS`, verify the same result with the JSON-loaded rules
- [x] Iterate until all parity tests pass

### Phase 4: Update options parsing

- [x] Change `MagentaOptions.commandConfig` type from `CommandPermissions` to `CommandPermissionsConfig`
- [x] Update `parseCommandConfig()` in `node/options.ts` to parse `CommandRule[]` from user JSON (the new format)
  - Support both old format (for backwards compat during transition) and new format
- [x] Update `mergeCommandConfig()` to merge `CommandPermissionsConfig` objects (concatenate `rules` arrays)
- [x] Update default `commandConfig` to load from `builtin-permissions.json` instead of `BUILTIN_COMMAND_PERMISSIONS`
- [x] Check for type errors and iterate until clean

### Phase 5: Wire up new matching in permission-shell

- [x] Update `permission-shell.ts` `checkPermissions()` to call `isCommandAllowedByRules()` instead of `isCommandAllowedByConfig()`
- [x] Update `permission-file-io.ts` if it references `commandConfig` anywhere
- [x] Run full test suite, iterate until all tests pass

### Phase 6: Remove old code

- [x] Remove old types: `ArgSpec`, `CommandPermissions`, `BUILTIN_COMMAND_PERMISSIONS`
- [x] Remove old matching functions: `matchSingleSpec`, `matchGroup`, `matchGroupSequential`, `matchGroupAnyOrder`, `matchArgsPattern`, `checkCommand`
- [x] Remove old `isCommandAllowedByConfig` and `checkCommandListPermissions`
- [x] Remove old parsing: `parseArgSpec()`, `parseCommandPatterns()` (unless kept for backwards compat)
- [x] Remove re-exports from `node/options.ts`
- [x] Update all test files to use new types/functions only
- [x] Check for type errors and iterate until clean
- [x] Run full test suite, iterate until all tests pass

### Phase 7: Update documentation

- [x] Update `node/skills/update-permissions/skill.md` to document the new format
- [x] Update any other docs/plans that reference the old format

