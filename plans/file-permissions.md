# Context

The goal is to centralize and enhance the file permissions system in magenta.nvim, allowing users to configure which files can be read/written without user confirmation.

## Current State

**Existing permission helpers** (`node/tools/permissions.ts`):

- `canReadFile(absFilePath, context)` - checks if a file can be read without confirmation
- `canWriteFile(absFilePath, context)` - checks if a file can be written without confirmation
- Used by `getFile.ts`, `replace.ts`, `insert.ts`

**Current rules** (in `node/tools/permissions.ts`):

- Auto-allow: magenta temp files (`/tmp/magenta/...`), skills directory files
- Auto-allow for read: files matching `getFileAutoAllowGlobs` option
- Require confirmation: files outside cwd, hidden files, gitignored files

**Bash parser permissions** (`node/tools/bash-parser/permissions.ts`):

- Separate system with `isPathSafe()` function
- Uses `{ type: "file" }`, `{ type: "restFiles" }` arg specs
- Currently only validates paths are within project cwd and not hidden/gitignored

## Desired Behavior

1. **New `filePermissions` option** in `~/.magenta/options.json`:

```json
{
  "filePermissions": [
    { "path": "/tmp", "read": true, "write": true },
    { "path": "~/src", "read": true },
    { "path": "~/.nvim/", "read": true },
    {
      "path": "~/.config/",
      "read": true,
      "write": true,
      "readSecret": true,
      "writeSecret": true
    }
  ]
}
```

2. **Default NvimCwd permission**: `{read: true, write: true}` (secrets require confirmation)

3. **Permission inheritance**: Permissions union as paths descend. If `/foo` has `read: true`, then `/foo/bar/baz` also has `read: true`.

4. **Gitignored files**: Now allowed by default (no longer require confirmation).

5. **Secret files** (hidden files like `.env`, `.secret`):
   - Example: `~/.nvim/init.lua` is readable (path `~/.nvim` has read permission, no new hidden segments after)
   - Example: `~/.nvim/folder/.env` requires `readSecret` because `.env` is a new hidden segment after `~/.nvim`
   - `readSecret` is a superset of `read`; `writeSecret` is a superset of `write`

6. **Bash tool integration**: Update arg specs to distinguish read vs write file operations:
   - `{ type: "readFile" }` - file that will be read (cat, grep, head, tail)
   - `{ type: "writeFile" }` - file that will be written (sed with -i, etc.)
   - `{ type: "file" }` - backwards-compatible, treated as both read and write

## Relevant Files

| File                                    | Purpose                                                     |
| --------------------------------------- | ----------------------------------------------------------- |
| `node/options.ts`                       | Options parsing, will add `filePermissions` type and parser |
| `node/tools/permissions.ts`             | Core permission logic - needs major refactor                |
| `node/tools/permissions.test.ts`        | Tests for permission system                                 |
| `node/tools/bash-parser/permissions.ts` | Bash command permission checking with `isPathSafe()`        |
| `node/tools/getFile.ts`                 | Uses `canReadFile`                                          |
| `node/tools/replace.ts`                 | Uses `canWriteFile`                                         |
| `node/tools/insert.ts`                  | Uses `canWriteFile`                                         |

## Key Types

```typescript
// New types to add to options.ts
export type FilePermission = {
  path: string; // e.g. "~/src", "/tmp", "."
  read?: true;
  write?: true;
  readSecret?: true; // Superset of read - allows reading hidden files
  writeSecret?: true; // Superset of write - allows writing hidden files
};

// Update to MagentaOptions
export type MagentaOptions = {
  // ... existing fields
  filePermissions?: FilePermission[];
};
```

# Implementation

## Phase 1: Add filePermissions configuration

- [x] Add `FilePermission` type to `node/options.ts`
- [x] Add `filePermissions?: FilePermission[]` to `MagentaOptions` type
- [x] Write `parseFilePermissions()` function in `node/options.ts`
- [x] Call parser in `parseOptions()` and `parseProjectOptions()`
- [x] Add to `mergeOptions()` to combine user + project permissions
- [x] Check for type errors and iterate until they pass

## Phase 2: Refactor core permission logic

- [x] Create new helper `getEffectivePermissions(absFilePath, filePermissions, cwd)` in `node/tools/permissions.ts`
  - Returns `{ read: boolean, write: boolean, readSecret: boolean, writeSecret: boolean }`
  - Handles path normalization and tilde expansion
  - Implements permission inheritance (union as paths descend)
  - Adds implicit `{path: cwd, read: true, write: true}` rule
- [x] Create helper `hasNewSecretSegment(absFilePath, permissionPath)`
  - Returns true if there's a hidden segment in the file path after the permission path
  - Example: `~/.nvim/folder/.env` relative to `~/.nvim` → returns true (`.env` is new hidden segment)
  - Example: `~/.nvim/init.lua` relative to `~/.nvim` → returns false
- [x] Refactor `canReadFile()` to use new helpers:
  - Get effective permissions for path
  - Check `readSecret` if file has new secret segments, otherwise check `read`
  - Keep existing magenta temp dir and skills dir auto-allow logic
- [x] Refactor `canWriteFile()` to use new helpers:
  - Get effective permissions for path
  - Check `writeSecret` if file has new secret segments, otherwise check `write`
- [x] Remove gitignore check from `canReadFile` and `canWriteFile` (gitignored files now allowed)
- [x] Check for type errors and iterate until they pass

## Phase 3: Update tests

- [x] Update `node/tools/permissions.test.ts` with new test cases:
  - Test permission inheritance (parent dir grants child access)
  - Test secret file detection (`.env` files require secret permissions)
  - Test cwd default permissions
  - Test explicit secret permissions override
  - Test gitignored files are now allowed
- [x] Run tests and iterate until they pass

## Phase 4: Update bash parser file checks

- [x] Add `{ type: "readFile" }` and `{ type: "writeFile" }` arg spec types to `node/tools/bash-parser/permissions.ts`
- [x] Update `matchSingleSpec()` to use `canReadFile`/`canWriteFile` for these types
- [x] Update `BUILTIN_COMMAND_PERMISSIONS` to use appropriate file types:
  - `cat`, `head`, `tail`, `grep`, `wc`, `sort`, `uniq`, `cut`, `awk`, `rg`, `fd`: use `readFile`
  - Keep `{ type: "file" }` for backwards compatibility with user configs
  - `{ type: "file" }` should check both read and write permissions
- [x] Pass options/context through permission checking chain so bash parser can access `filePermissions`
- [x] Check for type errors and iterate until they pass

## Phase 5: Integration and cleanup

- [x] Update `node/tools/getFile.ts` to pass `filePermissions` in context (already uses `canReadFile`)
- [x] Update `node/tools/replace.ts` to pass `filePermissions` in context (already uses `canWriteFile`)
- [x] Update `node/tools/insert.ts` to pass `filePermissions` in context (already uses `canWriteFile`)
- [x] Remove `getFileAutoAllowGlobs` option (superseded by `filePermissions`)
  - Add deprecation warning if users have this option set
- [x] Run full test suite and fix any regressions
- [x] Check for type errors and iterate until they pass

## Phase 6: Documentation

- [x] Update README or options documentation with `filePermissions` examples
- [x] Document the secret file behavior clearly
