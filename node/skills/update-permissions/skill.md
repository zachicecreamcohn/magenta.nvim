---
name: update-permissions
description: Configure sandbox permissions for filesystem access and network domains in magenta options. Use when sandbox violations occur and paths or domains need to be permanently allowed.
---

# Updating Sandbox Permissions

This skill guides you to update magenta's sandbox configuration when the user encounters sandbox violations.

## How Sandboxing Works

Magenta uses OS-level sandboxing (via `@anthropic-ai/sandbox-runtime`) to constrain shell commands. The sandbox:

- **Shell commands** run inside a macOS sandbox that restricts filesystem and network access
- **File IO** uses application-level checks against the sandbox config as the single source of truth
- When sandbox is unavailable (unsupported platform, missing deps), all shell commands and file writes prompt the user for approval

## Configuration Locations

- **Project-level**: `.magenta/options.json` in the project root
- **User-level**: `~/.magenta/options.json` in the home directory

User-level settings apply across all projects. Project-level settings are merged with user-level (arrays concatenate, `enabled` overwrites).

## Sandbox Config Structure

```json
{
  "sandbox": {
    "filesystem": {
      "allowWrite": ["./"],
      "denyWrite": [".env", ".git/hooks/"],
      "denyRead": ["~/.ssh", "~/.gnupg", "~/.aws", "~/.bashrc", "~/.zshrc"],
      "allowRead": ["~/.magenta", "~/.claude"]
    },
    "network": {
      "allowedDomains": ["registry.npmjs.org", "github.com", "*.github.com"],
      "deniedDomains": []
    }
  }
}
```

### Fields

- **`filesystem.allowWrite`**: Paths where writing is allowed. Default: `["./"]` (current working directory).
- **`filesystem.denyWrite`**: Paths within allowed areas where writing is denied. Default: `[".env", ".git/hooks/"]`.
- **`filesystem.denyRead`**: Paths where reading is denied. Default includes explicit literal paths for credentials (`~/.ssh`, `~/.aws`, `~/.gnupg`, etc.) and shell configs (`~/.bashrc`, `~/.zshrc`, etc.). Literal paths use subpath matching.
- **`filesystem.allowRead`**: Paths to re-allow reading within denied regions. Default: `["~/.magenta", "~/.claude"]`. Takes precedence over `denyRead`.
- **`network.allowedDomains`**: Domains that commands can access. Supports wildcards (e.g., `"*.github.com"`).
- **`network.deniedDomains`**: Domains that are explicitly blocked.

### Path Matching

There are two matching modes depending on whether a path contains glob characters (`*`, `?`, `[`):

- **Literal paths** (e.g., `~/.ssh`): Use **subpath matching** — blocks the path itself AND everything under it. So `~/.ssh` blocks `~/.ssh`, `~/.ssh/id_rsa`, `~/.ssh/keys/foo`, etc.
- **Glob patterns** (e.g., `~/.*`): Use **regex matching** where `*` matches any characters except `/` (single directory level) and `**` matches across directory boundaries. So `~/.*` blocks `~/.ssh` and `~/.bashrc` but NOT `~/.ssh/id_rsa`.

**Important**: The defaults use explicit literal paths for known sensitive locations (credentials, shell configs). Literal paths provide subpath matching which blocks the directory and everything under it. Review the defaults and add any project-specific sensitive paths your environment requires.

### Path Resolution

- `~/` expands to the user's home directory
- `./` expands to the current working directory
- Relative paths are resolved relative to the current working directory
- Absolute paths are used as-is

## How to Update Permissions

1. Read the existing options file (project or user level, as appropriate)
2. Add or merge the new sandbox entries
3. Write the updated JSON back to the file

If the file doesn't exist, create it with just the `sandbox` key.

## Common Scenarios

### Sandbox blocked a network request (e.g., `npm install`)

Add the domain to `network.allowedDomains`:

```json
{
  "sandbox": {
    "network": {
      "allowedDomains": ["registry.npmjs.org"]
    }
  }
}
```

### Sandbox blocked writing to a path

Add the path to `filesystem.allowWrite`:

```json
{
  "sandbox": {
    "filesystem": {
      "allowWrite": ["/tmp/build"]
    }
  }
}
```

### Sandbox blocked reading a config file

Add the path to `filesystem.allowRead`:

```json
{
  "sandbox": {
    "filesystem": {
      "allowRead": ["~/.config/myapp"]
    }
  }
}
```

Note: Since project settings merge by concatenating arrays, you cannot remove a user-level deny from project settings. Instead, update the user-level config directly.

## Merging Behavior

When project settings are merged with user settings:

- **Arrays concatenate**: project `allowWrite` is appended to user `allowWrite`, project `denyRead` is appended to user `denyRead`, and project `allowRead` is appended to user `allowRead`
- **`denyRead` always includes defaults**: the mandatory defaults (`~/.ssh`, `~/.gnupg`, `~/.aws`, shell configs, etc.) are always enforced; user config can only add more deny rules, never remove them
- **`allowRead` takes precedence**: if a path appears in both `denyRead` and `allowRead`, the allow rule wins
