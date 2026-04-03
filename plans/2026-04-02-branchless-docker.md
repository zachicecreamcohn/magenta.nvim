# context

## Objective

Rework the docker subagent to use a simpler directory-based model. Instead of requiring a git branch and using git clone + git bundle, the caller specifies a host directory to spawn from. The directory must contain a `.magenta/options.json` with a `container` config. The Dockerfile copies everything into the container (`.dockerignore` handles exclusions). On teardown, rsync copies changed files from the container back to the host directory.

This decouples container spawning from git entirely. The parent agent manages worktrees or directories however it wants (potentially via a skill), and the docker subagent just operates on a directory.

## Current flow (to be replaced)

1. `provisionContainer` (`node/core/src/container/provision.ts`) shallow-clones the repo into a temp dir, checks out a branch, creates a worker branch, builds a Docker image, starts the container.
2. `teardownContainer` (`node/core/src/container/teardown.ts`) extracts commits via git bundle, fetches into host repo, removes container + temp dir.
3. `DockerSupervisor` (`node/chat/thread-supervisor.ts`) checks git status is clean on yield, calls teardownContainer, reports worker branch + commit count.
4. `spawnDockerEntry` in `spawn-subagents.ts` requires `entry.branch`.

## New flow

1. Caller provides a `directory` parameter (a host path) to the docker spawn entry.
2. The directory must contain `.magenta/options.json` with `container: { dockerfile, workspacePath }`.
3. Provisioning: build Docker image using `directory` as build context, start container.
4. Agent runs in container, does its work, calls `yield_to_parent`.
5. Teardown: rsync container's `workspacePath` back to `directory` on host, then remove container.

## Key types and interfaces

```typescript
// node/core/src/container/types.ts (current — to be replaced)
interface ContainerConfig {
  dockerfile: string;
  workspacePath: string;
  installCommand?: string;
}

interface ProvisionResult {
  containerName: string;
  tempDir: string; // no longer needed
  imageName: string;
  startSha: string; // no longer needed
  workerBranch: string; // no longer needed
}

interface TeardownResult {
  workerBranch: string; // no longer needed
  baseBranch: string; // no longer needed
  commitCount: number; // no longer needed
}

// node/core/src/capabilities/thread-manager.ts (current — to be simplified)
type DockerSpawnConfig = {
  baseBranch: string; // remove
  workerBranch: string; // remove
  containerName: string; // keep
  tempDir: string; // remove
  imageName: string; // keep
  startSha: string; // remove
  workspacePath: string; // keep
  supervised: boolean; // keep
};
```

## Relevant files

- `node/core/src/container/provision.ts` — builds image, starts container
- `node/core/src/container/teardown.ts` — extracts changes, cleans up
- `node/core/src/container/types.ts` — ContainerConfig, ProvisionResult, TeardownResult
- `node/core/src/container/container.test.ts` — integration tests
- `node/core/src/tools/spawn-subagents.ts` — spawnDockerEntry, validation, spec
- `node/core/src/tools/spawn-subagents-description.md` — LLM-facing tool description
- `node/core/src/capabilities/thread-manager.ts` — DockerSpawnConfig type
- `node/core/src/providers/system-prompt.ts` — docker_root system prompt
- `node/core/src/providers/system-reminders.ts` — docker_root reminder
- `node/chat/thread-supervisor.ts` — DockerSupervisor
- `node/chat/chat.ts` — createThreadWithContext, spawnThread
- `node/options.ts` — parseContainerConfig, MagentaOptions

## Testing approaches

Three testing patterns are used for docker-related code. Each step below should use the appropriate pattern.

### Pattern A: Unit tests with mocks (no Docker required)

Mock `ThreadManager`, `containerProvisioner`, and other dependencies. Test logic, validation, wiring.

- **Reference:** `node/core/src/tools/spawn-subagents.test.ts` — uses `createMockThreadManager()` with `simulateYield()`, mocks `provision()` as `vi.fn().mockResolvedValue(provisionResult)`, and tests validation via `SpawnSubagents.validateInput()`.
- **Reference:** `node/core/src/tools/docker-toolspecs.test.ts` — pure unit tests for tool spec generation with no Docker.

### Pattern B: Docker integration tests (requires Docker daemon)

Create real containers, execute commands, verify results. Use `describe.skipIf(!dockerAvailable)` to skip when Docker isn't running. Create temp dirs with minimal Dockerfiles in `beforeAll`.

- **Reference:** `node/core/src/container/container.test.ts` — creates a temp git repo + Dockerfile, calls `provisionContainer()` and `teardownContainer()` against real containers, verifies files via `docker exec`, cleans up in `afterAll`.
- **Reference:** `node/capabilities/docker-environment.test.ts` — starts a `bash:latest` container in `beforeAll`, tests `DockerFileIO`, `DockerShell`, and `createDockerEnvironment` against it.

### Pattern C: String/snapshot tests (no Docker required)

Test generated strings (system prompts, tool descriptions) by inspecting content.

- **Reference:** system prompt tests can call `createSystemPrompt()` directly and assert on the returned string.

# implementation

- [ ] **Step 1: Simplify container types**
  - Rewrite `node/core/src/container/types.ts`:
    - `ContainerConfig` stays as-is (dockerfile, workspacePath, installCommand?).
    - `ProvisionResult` → `{ containerName: string; imageName: string }` (remove tempDir, startSha, workerBranch).
    - `TeardownResult` → `{ syncedFiles: number }` or similar (remove git-related fields).
  - Simplify `DockerSpawnConfig` in `thread-manager.ts`:
    - `{ containerName: string; imageName: string; workspacePath: string; hostDir: string; supervised: boolean }`
    - `hostDir` is the directory to rsync back to.

  **Test:** None — type errors are expected and resolved in subsequent steps. Verify with `npx tsgo -p node/core/tsconfig.json --noEmit` to confirm only expected errors remain.

- [ ] **Step 2: Rewrite `provisionContainer`**
  - Replace the current implementation in `provision.ts`:
    1. Generate shortHash, containerName, imageName.
    2. Resolve Dockerfile path relative to the provided `hostDir`.
    3. `docker build -t {imageName} -f {dockerfilePath} {hostDir}` — uses hostDir as build context directly. No temp dir, no git clone.
    4. `docker run -d --name {containerName} {imageName}` — start container.
    5. Return `{ containerName, imageName }`.
  - New signature: `provisionContainer({ hostDir, containerConfig, onProgress? })`.
  - Remove the old git-clone-based implementation entirely.

  **Test (Pattern B):** Docker integration test in `container.test.ts`, following the existing `beforeAll` temp-dir + Dockerfile setup pattern.
  - Behavior: `provisionContainer` builds and starts a container from a host directory
  - Setup: create a temp dir with a Dockerfile and a test file (no git init needed)
  - Actions: call `provisionContainer({ hostDir: tempDir, containerConfig: { dockerfile: "Dockerfile", workspacePath: "/workspace" } })`
  - Expected: container is running, test file is present at /workspace/test.txt
  - Assertions: `docker inspect` shows running; `docker exec cat /workspace/test.txt` returns expected content

- [ ] **Step 3: Rewrite `teardownContainer` with rsync**
  - Replace the current implementation in `teardown.ts`:
    1. Copy `.dockerignore` from host dir into a temp file (for use as rsync exclude list).
    2. rsync from container to host: `docker exec {container} rsync` won't work since we need cross-host sync. Instead: use `docker cp` to extract the workspace to a temp dir, then `rsync --delete --exclude-from={hostDir}/.dockerignore {tempDir}/ {hostDir}/`. This uses `.dockerignore` as the exclude list — the same patterns that were excluded from the build context are excluded from the sync back. This means:
       - Build artifacts created inside the container (e.g. `node_modules/` from `npm install`) are excluded.
       - Host-only files (`.git/`, `node_modules/`, etc.) are preserved.
       - Agent's file changes and deletions propagate correctly.
    3. Clean up the temp dir.
    4. Remove the container: `docker rm -f {containerName}`.
  - New signature: `teardownContainer({ containerName, workspacePath, hostDir, onProgress? })`.
  - Note: rsync must be available on the host machine. The container does NOT need rsync.

  **Test (Pattern B):** Docker integration test in `container.test.ts`, reusing the container provisioned in the previous test (same pattern as existing test which provisions in one `it` block and tears down in the next).
  - Behavior: `teardownContainer` syncs changed files back and removes container
  - Setup: reuse provisioned container. `docker exec` to: (a) create a new file, (b) modify an existing file, (c) delete a file, (d) create a `node_modules/foo.js` (build artifact that should be excluded).
  - Actions: call `teardownContainer({ containerName, workspacePath: "/workspace", hostDir: tempDir })`
  - Expected: new file appears in hostDir, modified file updated, deleted file gone, `node_modules/foo.js` NOT copied to host, host's `.git/` untouched, container removed.
  - Assertions: verify file contents and absence; `docker inspect` fails (container gone)

- [ ] **Step 4: Rewrite `DockerSupervisor`**
  - In `node/chat/thread-supervisor.ts`, simplify `DockerSupervisor`:
    - Remove git status check from `onYield`.
    - Call the new `teardownContainer` (rsync-based) with `hostDir`.
    - `onYield` returns `{ type: "accept", resultPrefix: "[Changes synced to {hostDir}]" }`.
    - `onEndTurnWithoutYield`: same auto-restart logic.
    - `onAbort`: clean up container (`docker rm -f`).
  - Constructor takes: `containerName`, `workspacePath`, `hostDir`, `opts?`.
  - Remove the old git-bundle-related fields.

  **Test (Pattern A):** Unit test in a new `thread-supervisor.test.ts`. Mock `teardownContainer` as a vi.fn() to avoid needing Docker.
  - Behavior: `DockerSupervisor.onYield` calls teardownContainer and returns accept
  - Setup: create supervisor with mock teardownContainer
  - Actions: call `supervisor.onYield("done")`
  - Expected: teardownContainer called with correct args, returns `{ type: "accept", resultPrefix: "..." }`
  - Behavior: `DockerSupervisor.onEndTurnWithoutYield` auto-restarts
  - Setup: create supervisor
  - Actions: call `supervisor.onEndTurnWithoutYield("end_turn")` multiple times
  - Expected: returns `send-message` up to maxRestarts, then `none`

- [ ] **Step 5: Update `spawnDockerEntry` in spawn-subagents.ts**
  - Replace `branch` parameter with `directory` parameter in `SubagentEntry`. `directory` is optional — defaults to `"."` (resolved to `cwd`), so the common case of "run docker from the current project" requires no extra config.
  - In `spawnDockerEntry`:
    1. Read `.magenta/options.json` from `entry.directory` to get `ContainerConfig`.
    2. Call new `provisionContainer({ hostDir: entry.directory, containerConfig, onProgress })`.
    3. Create thread with simplified `DockerSpawnConfig`: `{ containerName, imageName, workspacePath, hostDir: entry.directory, supervised }`.
  - Remove the `containerProvisioner` from the context — provisioning is now self-contained (just calls `provisionContainer` directly). The `ContainerConfig` comes from the directory's options file, not from the parent thread's options.
  - Update `validateInput`: `directory` is optional for docker environments (defaults to `"."`). If provided, must be a string. Remove `branch` validation entirely.
  - Update `getSpec`: replace `branch` with `directory` in the input schema. Mark it as optional with description noting the `"."` default.
  - Update `spawn-subagents-description.md`:
    - Replace the `branch` parameter docs with `directory` parameter docs.
    - Update the Environment section to describe the new model: docker environments build from a host directory (default: cwd), the directory must have `.magenta/options.json` with container config, and changes are rsynced back on yield.
    - Remove mentions of "worker branch", "base branch", git bundle.
    - Update examples if any reference the old branch-based flow.

  **Test (Pattern A):** Unit tests in `spawn-subagents.test.ts`, following the existing `createMockThreadManager` pattern. Mock `provisionContainer` at the module level.
  - Behavior: docker subagent spawns from a directory with `.magenta/options.json`
  - Setup: create a real temp dir with `.magenta/options.json`. Mock `provisionContainer` and `threadManager`.
  - Actions: execute spawn_subagents with `{ agents: [{ prompt: "run tests", environment: "docker_unsupervised", directory: tempDir }] }`
  - Expected: `provisionContainer` called with hostDir, thread spawned with correct DockerSpawnConfig
  - Assertions: verify `threadManager.spawnThread` called with `{ dockerSpawnConfig: { hostDir: tempDir, ... } }`
  - Behavior: validation accepts docker environment without `directory` (defaults to ".")
  - Actions: `validateInput({ agents: [{ prompt: "test", environment: "docker" }] })`
  - Expected: `{ status: "ok" }`
  - Behavior: validation accepts docker environment with explicit `directory`
  - Actions: `validateInput({ agents: [{ prompt: "test", environment: "docker", directory: "/some/path" }] })`
  - Expected: `{ status: "ok" }`
  - Behavior: execute resolves missing directory to cwd
  - Setup: mock threadManager, mock provisionContainer
  - Actions: execute with `{ agents: [{ prompt: "test", environment: "docker_unsupervised" }] }` and context `cwd: "/my/project"`
  - Expected: `provisionContainer` called with `hostDir: "/my/project"`

- [ ] **Step 6: Update `chat.ts` thread creation**
  - In `createThreadWithContext` / `spawnThread` in `node/chat/chat.ts`:
    - Update to use simplified `DockerSpawnConfig` (no more baseBranch, workerBranch, startSha, tempDir).
    - Create `DockerSupervisor` with new constructor args (containerName, workspacePath, hostDir).
    - Docker environment config stays the same (container name + cwd).

  **Test:** No new tests — verify by running existing test suite (`npx vitest run`) and type check (`npx tsgo -b`). The spawn-subagents unit tests (Pattern A) from Step 5 already verify the DockerSpawnConfig shape passed to `spawnThread`.

- [ ] **Step 7: Update system prompt and reminders**
  - In `system-prompt.ts`, update the `docker_root` case:
    - Remove branch info from the prompt (no more workerBranch/baseBranch).
    - Remove git commit requirements.
    - New prompt: "You are running inside an isolated Docker container. You have full shell access and can install packages, run builds, and execute tests freely. When your task is complete, call yield_to_parent with a summary of what you did. Your file changes will be automatically synced back to the host."
  - Simplify `DockerContext` type: remove `workerBranch` and `baseBranch`, or remove entirely if no context is needed.
  - In `system-reminders.ts`, update docker_root reminder: remove git commit mention, replace with "Call yield_to_parent when done. Your changes will be synced back automatically."

  **Test (Pattern C):** String tests, can be added to a new `system-prompt.test.ts` or inline in an existing test file.
  - Behavior: docker_root system prompt doesn't mention git
  - Setup: call `createSystemPrompt("docker_root", { ... })` with minimal context
  - Expected: prompt contains "Docker container", "yield_to_parent", "synced back"; does NOT contain "commit", "clean working tree", "worker branch"
  - Behavior: docker_root system reminder doesn't mention git
  - Setup: call `getSubsequentReminder("docker_root")`
  - Expected: contains "yield_to_parent"; does NOT contain "commit"

- [ ] **Step 8: Update container.test.ts**
  - Rewrite integration tests for the new provision + teardown flow:
    - Test provisioning from a directory (no git required).
    - Test that untracked files are present in the container.
    - Test that teardown copies changed files back and removes the container.
    - Test that new files created in the container appear on host after teardown.

  **Test (Pattern B):** This IS the integration test in `container.test.ts` — Steps 2 and 3 tests combined into a single describe block that tests the full lifecycle. No separate test needed here; this step is about rewriting `container.test.ts` to use the new API (which is the test file for Steps 2+3).

- [ ] **Step 9: Clean up dead code**
  - Remove any remaining references to the old git-based flow: tempDir, startSha, workerBranch, baseBranch, git bundle logic.
  - Remove `containerProvisioner` from spawn-subagents context if no longer needed.
  - Run `npx tsgo -b` and `npx biome check .` to verify everything compiles and passes lint.

  **Test:** Run `npx tsgo -b`, `npx biome check .`, and `npx vitest run` to verify everything compiles, passes lint, and all tests pass.
