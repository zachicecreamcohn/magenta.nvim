---
name: update-permissions
description: Configure bash command permissions and file access permissions in magenta options. Use when commands or file paths need to be permanently allowlisted.
---

# Updating Bash Command Permissions

This skill guides you to add bash command permissions to magenta's configuration files.

## Configuration Locations

- **Project-level**: `.magenta/options.json` in the project root
- **User-level**: `~/.magenta/options.json` in the home directory

User-level permissions apply across all projects. Project-level permissions only apply to the current project and are merged with user-level permissions.

## How to Update Permissions

1. Read the existing options file (if it exists)
2. Add or merge the new `commandConfig` entries
3. Write the updated JSON back to the file

If the file doesn't exist, create it with just the `commandConfig` key.

## Permission Structure

The `commandConfig` option uses a `rules` array where each rule describes a command tree:

```json
{
  "commandConfig": {
    "rules": [
      { "cmd": "echo", "rest": "any" },
      { "cmd": "cat", "args": ["readFile"] },
      { "cmd": "grep", "flags": ["-i"], "args": ["any"], "rest": "readFiles" },
      { "cmd": "sort", "options": { "-o": "writeFile" }, "args": ["readFile"] },
      {
        "cmd": "git",
        "options": { "-C": "any" },
        "subcommands": [
          { "cmd": "status", "rest": "any" },
          { "cmd": "commit", "options": { "-m": "any" }, "rest": "any" }
        ]
      }
    ]
  }
}
```

## CommandRule Fields

Each rule is an object with these fields:

- **`cmd`** (required): The command name (e.g., `"grep"`, `"git"`)
- **`flags`**: Array of boolean flags (no value, order-independent, all optional). E.g., `["-i", "-l"]`
- **`options`**: Object mapping option keys to value types (order-independent, all optional). E.g., `{ "-n": "any", "-o": "writeFile" }`
- **`subcommands`**: Array of nested `CommandRule` objects. After extracting parent flags/options, the next arg must match a subcommand. Mutually exclusive with `args`/`rest`/`pipe`.
- **`args`**: Array of positional argument types, matched in order (leaf nodes only)
- **`rest`**: What to do with remaining args after positionals: `"any"`, `"readFiles"`, or `"writeFiles"` (leaf nodes only)
- **`pipe`**: If `true`, this rule only applies when the command receives pipe input (leaf nodes only)

## Argument Types (for `args`)

Each positional in `args` can be:

- **`"any"`**: Any single value
- **`"readFile"`**: A readable file path (permission-checked)
- **`"writeFile"`**: A writable file path (permission-checked)
- **`{ "pattern": "regex" }`**: Must match the given regex
- **`{ "type": "any"|"readFile"|"writeFile", "optional": true }`**: Optional positional argument

## Option Value Types (for `options` values)

- **`"any"`**: Any value
- **`"readFile"`**: Value is a readable file path (permission-checked)
- **`"writeFile"`**: Value is a writable file path (permission-checked)
- **`{ "pattern": "regex" }`**: Value must match regex

## Examples

### Allow `npm` commands

```json
{
  "commandConfig": {
    "rules": [
      {
        "cmd": "npm",
        "subcommands": [
          { "cmd": "install", "rest": "any" },
          { "cmd": "run", "rest": "any" },
          { "cmd": "test" }
        ]
      }
    ]
  }
}
```

### Allow `rg` with flags and file targets

```json
{
  "commandConfig": {
    "rules": [
      {
        "cmd": "rg",
        "flags": ["-l", "-i"],
        "options": { "--type": "any" },
        "args": ["any"],
        "rest": "readFiles"
      }
    ]
  }
}
```

### Allow `head` with optional `-n` flag or numeric pattern

```json
{
  "commandConfig": {
    "rules": [
      { "cmd": "head", "options": { "-n": "any" }, "args": ["readFile"] },
      { "cmd": "head", "args": [{ "pattern": "-[0-9]+" }, "readFile"] }
    ]
  }
}
```

### Allow pipe commands

```json
{
  "commandConfig": {
    "rules": [
      { "cmd": "grep", "rest": "any", "pipe": true },
      { "cmd": "sort", "rest": "any", "pipe": true }
    ]
  }
}
```

### Allow `sort` with write-checked output option

```json
{
  "commandConfig": {
    "rules": [
      { "cmd": "sort", "options": { "-o": "writeFile" }, "args": ["readFile"] }
    ]
  }
}
```

## Matching Semantics

- **Flags and options are order-independent**: `-i` can appear before or after positional args
- **Unrecognized `-` args pass through to positional matching**: `head -10 file.txt` works when `-10` matches a pattern positional
- **`--key=value` syntax is supported**: `--output=file.txt` is split and checked if `--output` is a known option
- **A command is allowed if ANY rule matches**
- **Pipe rules only match piped commands**: Rules with `pipe: true` only apply when the command receives pipe input; rules without `pipe` only apply to standalone commands

## Merging Rules

When adding new permissions to an existing config, append new rule objects to the `rules` array. Avoid duplicate rules.

## Legacy Format Support

The old format using `commands` and `pipeCommands` arrays is still supported for backward compatibility:

```json
{
  "commandConfig": {
    "commands": [["echo", { "type": "restAny" }]],
    "pipeCommands": [["grep", { "type": "restAny" }]]
  }
}
```

This will be automatically converted to the new rules format. New configs should use the `rules` format.

## File Permissions

In addition to command permissions, you can configure which directories allow file operations without confirmation using `filePermissions`:

```json
{
  "filePermissions": [
    { "path": "/tmp", "read": true, "write": true },
    { "path": "~/src", "read": true },
    {
      "path": "~/.config",
      "read": true,
      "write": true,
      "readSecret": true,
      "writeSecret": true
    }
  ]
}
```

Properties:

- **`path`**: Path prefix (supports `~` for home directory)
- **`read`**: Allow reading files without confirmation
- **`write`**: Allow writing files without confirmation
- **`readSecret`**: Allow reading hidden files (e.g., `.env`, `.secret`)
- **`writeSecret`**: Allow writing hidden files

By default, the current working directory has `read` and `write` permissions. Hidden files (segments starting with `.` after the permission path) require the `readSecret`/`writeSecret` permissions.

Permissions inherit down the directory tree: if `~/src` has `read: true`, then `~/src/project/file.ts` also has read permission.

## Builtin Permissions

Many common commands are already allowed by default (see `node/capabilities/bash-parser/builtin-permissions.json`), including:

- Basic commands: `ls`, `pwd`, `echo`, `cat`, `head`, `tail`, `wc`, `grep`, `sort`, `uniq`, `cut`, `awk`, `sed`
- Git commands (via subcommands): `status`, `log`, `diff`, `show`, `add`, `commit`, `push`, etc. (with global `-C` and `-c` options)
- Search tools: `rg`, `fd`

Pipe commands like `grep`, `sed`, `awk`, `sort`, `head`, `tail`, etc. are also allowed when receiving pipe input.