---
name: update-permissions
description: Add bash command permissions to project-level or user-level magenta options. Use when a command needs to be permanently allowlisted.
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

The `commandConfig` option defines which commands can run automatically without user confirmation:

```json
{
  "commandConfig": {
    "npx": {
      "subCommands": {
        "tsc": {
          "args": [["--noEmit"], ["--noEmit", "--watch"]]
        },
        "vitest": {
          "subCommands": {
            "run": {
              "args": [[{ "restFiles": true }]]
            }
          }
        }
      }
    },
    "cat": {
      "args": [[{ "file": true }]]
    },
    "echo": {
      "allowAll": true
    }
  }
}
```

## ArgSpec Types

Each argument in an `args` pattern can be:

- **String literal**: `"--noEmit"` - exact match required
- **`{ "file": true }`**: A single file path that must be within the project, non-hidden, and not gitignored
- **`{ "restFiles": true }`**: Zero or more file paths (must be the last element in the pattern)
- **`{ "any": true }`**: Any single argument (wildcard)
- **`{ "pattern": "regex" }`**: Argument matching a regex pattern

## CommandSpec Options

- **`subCommands`**: Nested commands (e.g., `npx vitest run`)
- **`args`**: Array of allowed argument patterns. Command is allowed if ANY pattern matches.
- **`allowAll`**: If true, any arguments are allowed (use for safe commands like `echo`)

## Examples

### Allow `rg` (ripgrep) with any pattern argument

```json
{
  "rg": {
    "args": [[{ "any": true }], [{ "any": true }, { "restFiles": true }]]
  }
}
```

### Allow `npm` commands

```json
{
  "npm": {
    "subCommands": {
      "install": { "allowAll": true },
      "run": { "allowAll": true },
      "test": { "args": [[]] }
    }
  }
}
```

### Allow `fd` with file pattern

```json
{
  "fd": {
    "args": [[{ "any": true }], [{ "any": true }, { "restFiles": true }]]
  }
}
```

### Allow `git` status and diff

```json
{
  "git": {
    "subCommands": {
      "status": { "args": [[]] },
      "diff": { "args": [[], [{ "restFiles": true }]] }
    }
  }
}
```

## Merging Rules

When adding new permissions to an existing config:

1. If a command doesn't exist, add it directly
2. If a command exists:
   - Merge `subCommands` recursively
   - Concatenate `args` arrays (both patterns become valid)
   - If either has `allowAll`, keep it

## Notes

- Arguments are order-specific: `["--watch", "--noEmit"]` won't match a pattern `["--noEmit", "--watch"]`
- File paths are validated to be within the project directory and non-hidden
- Gitignored files require confirmation
- Skills directory scripts are always allowed regardless of permissions
