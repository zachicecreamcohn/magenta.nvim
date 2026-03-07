# Plan: Dynamic Permissions Reloading

## Problem

Currently, `commandConfig` and `filePermissions` from `~/.magenta/options.json` and `<cwd>/.magenta/options.json` are read once at startup (in `magenta.ts:520-551`) and baked into the `MagentaOptions` object. If a user edits these files (e.g., to add a new allowed command via the `update-permissions` skill), the changes don't take effect until the plugin is restarted.

## Current Architecture

### How options are loaded (once, at startup)

1. **`magenta.ts:520-551`** — `initMagenta()` calls:
   - `parseOptions(opts)` → base options from Lua config
   - `loadUserSettings(homeDir)` → reads `~/.magenta/options.json`
   - `loadProjectSettings(cwd)` → reads `<cwd>/.magenta/options.json`
   - `mergeOptions()` combines them all into a single `MagentaOptions`
   - This `MagentaOptions` is passed to `new Magenta(...)` and never re-read

2. **`chat.ts:415-424`** — When creating a thread environment, `this.context.options` (the cached `MagentaOptions`) is passed to `createLocalEnvironment()`

3. **`environment.ts:60-86`** — `createLocalEnvironment()` passes `options` into both `PermissionCheckingFileIO` and `PermissionCheckingShell` as part of `permissionContext`

### How permissions are checked (using cached options)

4. **`permission-shell.ts:39-53`** — `checkPermissions()` calls `isCommandAllowedByConfig()` with `permissionContext.options.commandConfig` and `permissionContext.options.filePermissions`

5. **`permission-file-io.ts:48-71`** — `checkReadPermission()`/`checkWritePermission()` call `canReadFile()`/`canWriteFile()` with `this.permissionContext` which contains the cached options

6. **`capabilities/bash-parser/permissions.ts:524-558`** — `isCommandAllowedByConfig()` receives `commandConfig` and `filePermissions` as parameters — it has no dependency on how they're stored

7. **`capabilities/permissions.ts:21-59`** — `getEffectivePermissions()` receives `filePermissions` as a parameter — also no dependency on storage

### Key insight

The permission-checking functions themselves are stateless — they receive `commandConfig` and `filePermissions` as arguments. The caching happens at the options level: `MagentaOptions` is constructed once and the same object reference flows through `Magenta → Chat → Environment → PermissionChecking*`.

## Proposed Solution

### Approach: Lazy-loading wrapper with mtime caching

Re-read both options files on every permission check, but use file `mtime` to avoid re-parsing when files haven't changed. This gives us effectively real-time updates with negligible performance cost (stat syscalls are ~microseconds).

### Changes

#### 1. New file: `node/options-loader.ts` — Dynamic options loader

Create a class `DynamicOptionsLoader` that:
- Holds the base `MagentaOptions` (from Lua config, which doesn't change)
- Caches the parsed user settings and project settings, along with their file mtimes
- On `getOptions()`: stats both options files, re-reads/re-parses only if mtime changed, re-merges, and returns the result
- Falls back to cached result if files don't exist or haven't changed

```typescript
export class DynamicOptionsLoader {
  private baseOptions: MagentaOptions;
  private cwd: NvimCwd;
  private homeDir: HomeDir;
  private logger: { warn: (msg: string) => void };

  // Cache
  private cachedOptions: MagentaOptions;
  private userSettingsMtime: number | null = null;
  private projectSettingsMtime: number | null = null;

  constructor(baseOptions: MagentaOptions, cwd: NvimCwd, homeDir: HomeDir, logger: {...}) {
    this.baseOptions = baseOptions;
    this.cachedOptions = baseOptions; // initial
    // ...
  }

  getOptions(): MagentaOptions {
    let needsRemerge = false;

    const userMtime = statMtime(path.join(this.homeDir, '.magenta', 'options.json'));
    if (userMtime !== this.userSettingsMtime) {
      this.userSettingsMtime = userMtime;
      needsRemerge = true;
    }

    const projectMtime = statMtime(path.join(this.cwd, '.magenta', 'options.json'));
    if (projectMtime !== this.projectSettingsMtime) {
      this.projectSettingsMtime = projectMtime;
      needsRemerge = true;
    }

    if (needsRemerge) {
      // re-read and re-merge
      this.cachedOptions = this.reloadAndMerge();
    }

    return this.cachedOptions;
  }
}
```

#### 2. Modify `node/magenta.ts` — Use DynamicOptionsLoader

- Instead of computing `parsedOptions` once, create a `DynamicOptionsLoader`
- Store the loader on the `Magenta` instance
- Expose a getter `get options(): MagentaOptions` that delegates to `this.optionsLoader.getOptions()`

Changes in `initMagenta()` (~line 520-551):
- Keep the initial `parseOptions(opts)` call for `baseOptions`
- Remove `loadUserSettings`/`loadProjectSettings`/`mergeOptions` calls
- Create `new DynamicOptionsLoader(baseOptions, cwd, resolvedHomeDir, logger)`
- The loader does the initial load in its constructor
- Pass the loader (or a getter) to `new Magenta(...)`

#### 3. Modify `node/chat/chat.ts` — Use getter instead of cached value

Change `this.context.options` references to use a getter that calls the loader. There are two approaches:

**Option A (minimal):** Make `context.options` a getter property that calls `optionsLoader.getOptions()`. Since `Chat` already accesses `this.context.options`, it will automatically get fresh values.

**Option B (explicit):** Pass the `DynamicOptionsLoader` through and call `.getOptions()` at point of use.

Option A is simpler and requires fewer changes.

#### 4. Modify `node/environment.ts` — Pass fresh options

In `createLocalEnvironment()`, the `options` parameter is already received from the caller. As long as the caller passes fresh options (via the getter in step 3), no changes needed here.

However, there's a subtlety: `PermissionCheckingShell` and `PermissionCheckingFileIO` store `options` in their `permissionContext` at construction time. Since environments are created per-thread, options are frozen for the lifetime of a thread.

Two approaches:
- **Simple:** Accept that options are frozen per-thread. New threads get fresh options. This is probably fine — a user adds a permission and their next tool call (in a new or existing thread) picks it up.
- **Fully dynamic:** Make `permissionContext.options` a getter. This requires changing how `permissionContext` is structured.

**Recommendation: Go with fully dynamic** — make `permissionContext` use a getter or callback for options so that even within a running thread, the latest permissions are used. The change is small: instead of `options: MagentaOptions`, use `getOptions: () => MagentaOptions`.

#### 5. Modify `node/capabilities/permission-shell.ts`

Change `permissionContext` type to use `getOptions: () => MagentaOptions` instead of `options: MagentaOptions`.

Update `checkPermissions()`:
```typescript
private checkPermissions(command: string): PermissionCheckResult {
  if (this.permissionContext.rememberedCommands.has(command)) {
    return { allowed: true };
  }
  const options = this.permissionContext.getOptions();
  return isCommandAllowedByConfig(command, options.commandConfig, {
    cwd: this.permissionContext.cwd,
    homeDir: this.permissionContext.homeDir,
    skillsPaths: options.skillsPaths,
    filePermissions: options.filePermissions,
  });
}
```

#### 6. Modify `node/capabilities/permission-file-io.ts`

Same pattern: change `permissionContext` to use `getOptions: () => MagentaOptions`.

Update `checkReadPermission()` and `checkWritePermission()` to call `this.permissionContext.getOptions()` to get fresh `filePermissions`.

#### 7. Modify `node/capabilities/permissions.ts`

No changes needed — `getEffectivePermissions()`, `canReadFile()`, `canWriteFile()` already receive `filePermissions` as parameters.

#### 8. Modify `node/capabilities/bash-parser/permissions.ts`

No changes needed — `isCommandAllowedByConfig()` already receives `commandConfig` and `filePermissions` as parameters.

### Files to change (summary)

| File | Change |
|------|--------|
| `node/options-loader.ts` | **New file** — `DynamicOptionsLoader` class |
| `node/magenta.ts` | Use `DynamicOptionsLoader` instead of one-time load |
| `node/chat/chat.ts` | Ensure `options` comes from dynamic getter |
| `node/environment.ts` | Pass `getOptions` callback instead of `options` |
| `node/capabilities/permission-shell.ts` | Use `getOptions()` in `permissionContext` |
| `node/capabilities/permission-file-io.ts` | Use `getOptions()` in `permissionContext` |

### Files that do NOT need changes

| File | Why |
|------|-----|
| `node/capabilities/permissions.ts` | Already parameterized |
| `node/capabilities/bash-parser/permissions.ts` | Already parameterized |
| `node/options.ts` | `loadUserSettings`, `loadProjectSettings`, `mergeOptions` are reused as-is |
| `lua/magenta/options.lua` | Lua-side options don't change dynamically |

## Performance Considerations

- **`fs.statSync`** is ~5-10μs — negligible overhead on every permission check
- File re-parsing only happens when mtime changes (rare — only when user edits options.json)
- `mergeOptions()` is lightweight (array concatenation, object spread)
- No file watchers needed — mtime polling on access is simpler and sufficient

## Test Considerations

### Unit tests for `DynamicOptionsLoader`

1. Returns initial options when no files exist
2. Returns merged options when files exist
3. Re-reads file when mtime changes
4. Caches result when mtime unchanged (verify no re-parse)
5. Handles file deletion gracefully (reverts to base options)
6. Handles malformed JSON gracefully (keeps last good options)

### Integration tests

1. Modify `permission-shell` tests to verify that changing options mid-session affects permission checks
2. Modify `permission-file-io` tests to verify same
3. End-to-end: write options.json, verify command is auto-allowed, delete it, verify command requires approval again

### Existing test compatibility

- Existing tests pass `options: MagentaOptions` directly — these need updating to pass `getOptions: () => options` instead, which is a mechanical change