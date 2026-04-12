# Docker-aware Skills Loading

## Context

The goal is to make skill loading work correctly inside Docker containers. Currently `loadSkills()` in `node/core/src/providers/skills.ts` uses `fs.readFileSync/readdirSync/statSync` directly, which always reads from the host filesystem. When a docker thread is created, the skill paths in the system prompt point to host paths that don't exist in the container, so `get_file` on them fails.

The fix: make `loadSkills()` use the `FileIO` interface instead of `fs` directly, and add a `readdir` method to `FileIO` so we can list directory contents through `DockerFileIO`.

### Relevant files and entities

- `node/core/src/capabilities/file-io.ts`: `FileIO` interface and `FsFileIO` implementation. Need to add `readdir()`.
- `node/capabilities/docker-file-io.ts`: `DockerFileIO` class. Need to add `readdir()`.
- `node/core/src/providers/skills.ts`: `loadSkills()`, `findSkillFilesInDirectory()`, `parseSkillFile()`. All use sync `fs` calls. Need to convert to async using `FileIO`.
- `node/core/src/providers/system-prompt.ts`: `createSystemPrompt()` is sync, calls `loadSkills()`. Must become async.
- `node/providers/system-prompt.ts`: Async wrapper around core's `createSystemPrompt()`. Already async so this is fine.
- `node/chat/chat.ts:createThreadWithContext()`: Calls `createSystemPrompt()` at line 359. The `environment` (with `fileIO`) is already available before this call.
- `node/environment.ts`: `Environment` interface has `fileIO: FileIO` and `homeDir: HomeDir`.

### Key insight

In `createThreadWithContext()`, the `environment` is created before `createSystemPrompt()` is called (lines 324-351 create the environment, line 359 creates the system prompt). So we can pass `environment.fileIO` and `environment.homeDir` to `createSystemPrompt()` → `loadSkills()`.

## Implementation

- [ ] Add `readdir(path: string): Promise<string[]>` to `FileIO` interface
  - `node/core/src/capabilities/file-io.ts`: Add method to interface, implement in `FsFileIO` using `fs.promises.readdir()`

- [ ] Implement `readdir()` in `DockerFileIO`
  - `node/capabilities/docker-file-io.ts`: Use `docker exec <container> ls <path>` or similar
  - Check for type errors and iterate

- [ ] Convert `loadSkills()` to async, accepting `FileIO` instead of using `fs` directly
  - `node/core/src/providers/skills.ts`:
    - Change `loadSkills()` signature: add `fileIO: FileIO` to context, return `Promise<SkillsMap>`, make async
    - Change `findSkillFilesInDirectory()`: make async, use `fileIO.fileExists()`, `fileIO.readdir()`, `fileIO.stat()` instead of `fs.statSync/readdirSync`
    - Change `parseSkillFile()`: make async, use `fileIO.readFile()` instead of `fs.readFileSync()`
    - Note: `fileIO.stat()` returns `{ mtimeMs, size } | undefined` but doesn't tell us if it's a directory. We need to handle this - either add `isDirectory` to stat, or use `readdir` and catch errors for non-directories.
  - Test: existing skills.test.ts tests should still pass (they use local filesystem via FsFileIO)

- [ ] Handle the "is directory" check
  - Currently `loadSkills` uses `fs.statSync(path).isDirectory()`. `FileIO.stat()` doesn't expose `isDirectory`.
  - Option A: Add `isDirectory(path: string): Promise<boolean>` to FileIO
  - Option B: Try `readdir` and catch errors for non-directories
  - Option C: Add `isDirectory` field to `stat()` return type
  - Recommend Option A: simplest, most explicit. Add to interface, implement via `fs.stat().isDirectory()` in FsFileIO, `docker exec test -d` in DockerFileIO.

- [ ] Make core `createSystemPrompt()` async
  - `node/core/src/providers/system-prompt.ts`: Change `createSystemPrompt()` to async, `await loadSkills()`
  - Pass `fileIO` through the context parameter
  - Update the export in `node/core/src/index.ts` if needed

- [ ] Thread `fileIO` through from `createThreadWithContext` to `createSystemPrompt`
  - `node/providers/system-prompt.ts`: Add `fileIO` to context parameter, pass to `coreCreateSystemPrompt()`
  - `node/chat/chat.ts`: Pass `environment.fileIO` when calling `createSystemPrompt()` at line 359
  - Also handle the `createSystemPrompt("root", ...)` call at line 673 - this is for the main thread, pass `FsFileIO`

- [ ] Update the `homeDir` resolution for tilde expansion in skills paths
  - Currently `loadSkills` → `expandTilde` uses `os.homedir()` which is always the host's home
  - For docker, we need to use the container's home dir (available as `environment.homeDir`)
  - Add `homeDir` to `loadSkills` context, use it in `expandTilde` instead of `os.homedir()`

- [ ] Update tests
  - `node/providers/skills.test.ts`: Tests create skill files in tmpDir and use local filesystem. They should continue to work since `FsFileIO` is the default for local environments.
  - `node/providers/system-prompt.test.ts`: Check if it needs updates for the new async core signature
  - Check for type errors and iterate until they pass

- [ ] Run full test suite to verify nothing breaks
