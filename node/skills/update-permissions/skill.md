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

The `commandConfig` option defines which commands can run automatically without user confirmation. It has two arrays:

- **`commands`**: Patterns for standalone commands
- **`pipeCommands`**: Patterns for commands receiving pipe input (more permissive)

```json
{
  "commandConfig": {
    "commands": [
      ["npx", "tsc", "--noEmit"],
      ["npx", "vitest", "run", { "type": "restFiles" }],
      ["cat", { "type": "file" }],
      ["echo", { "type": "restAny" }]
    ],
    "pipeCommands": [
      ["grep", { "type": "restAny" }],
      ["wc", { "type": "restAny" }]
    ]
  }
}
```

Each pattern is an array where the first element is the executable and subsequent elements are the expected arguments.

## ArgSpec Types

Each element in a pattern can be:

- **String literal**: `"--noEmit"` - exact match required
- **`{ "type": "readFile" }`**: A single file path that will be read (validated against `filePermissions`)
- **`{ "type": "writeFile" }`**: A single file path that will be written (validated against `filePermissions`)
- **`{ "type": "file" }`**: A single file path (checks both read and write permissions)
- **`{ "type": "restFiles" }`**: Zero or more file paths (must be last in pattern)
- **`{ "type": "restAny" }`**: Zero or more arguments of any type (must be last in pattern)
- **`{ "type": "any" }`**: Any single argument (wildcard)
- **`{ "type": "pattern", "pattern": "regex" }`**: Argument matching a regex pattern
- **`{ "type": "group", "args": [...], "optional": true }`**: Optional group of arguments
- **`{ "type": "group", "args": [...], "anyOrder": true }`**: Group where args can appear in any order

## Examples

### Allow `rg` (ripgrep) with pattern and optional files

```json
{
  "commandConfig": {
    "commands": [
      ["rg", { "type": "any" }],
      ["rg", { "type": "any" }, { "type": "restFiles" }]
    ]
  }
}
```

### Allow `npm` commands

```json
{
  "commandConfig": {
    "commands": [
      ["npm", "install", { "type": "restAny" }],
      ["npm", "run", { "type": "restAny" }],
      ["npm", "test"]
    ]
  }
}
```

### Allow `fd` with pattern and optional directory

```json
{
  "commandConfig": {
    "commands": [
      ["fd", { "type": "any" }],
      ["fd", { "type": "any" }, { "type": "file" }]
    ]
  }
}
```

### Allow commands with optional flags using groups

```json
{
  "commandConfig": {
    "commands": [
      [
        "head",
        {
          "type": "group",
          "args": ["-n", { "type": "any" }],
          "optional": true
        },
        { "type": "file" }
      ],
      [
        "grep",
        { "type": "group", "args": ["-i"], "optional": true },
        { "type": "any" },
        { "type": "restFiles" }
      ]
    ]
  }
}
```

## Merging Rules

When adding new permissions to an existing config:

1. Append new patterns to the `commands` array
2. Append new patterns to the `pipeCommands` array
3. Avoid duplicate patterns

## Notes

- Patterns are order-specific unless using `{ "type": "group", "anyOrder": true }`
- File paths are validated to be within the project directory and non-hidden
- Gitignored files are blocked
- Skills directory scripts are always allowed regardless of permissions
- `restFiles` and `restAny` must be the last element in a pattern
- Groups cannot contain `restFiles` or `restAny`

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

Many common commands are already allowed by default (see `BUILTIN_COMMAND_PERMISSIONS` in `node/tools/bash-parser/permissions.ts`), including:

- Basic commands: `ls`, `pwd`, `echo`, `cat`, `head`, `tail`, `wc`, `grep`, `sort`, `uniq`, `cut`, `awk`, `sed`
- Git commands: `status`, `log`, `diff`, `show`, `add`, `commit`, `push`, etc.
- Search tools: `rg`, `fd`

Pipe commands like `grep`, `sed`, `awk`, `sort`, `head`, `tail`, etc. are also allowed when receiving pipe input.
