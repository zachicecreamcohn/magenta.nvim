# Context

## Objective

Rework Docker subagent commit syncing to use per-worker anonymous branches instead of applying patches to a shared named branch.

### Current approach
- Parent agent specifies a `branch` name when spawning a docker subagent
- The container is provisioned with that branch checked out
- On teardown, `git format-patch` extracts commits, then `git am` applies them to the **same named branch** on the host
- This is fragile with parallel workers: multiple agents targeting the same branch will conflict during patch application
- Teardown requires checking out the target branch on the host, which is disruptive

### New approach
- Each docker worker gets a **unique anonymous branch** (e.g., `magenta/worker-{shortHash}`) forked from the user-specified base branch
- The agent commits to this anonymous branch inside the container
- On teardown, the anonymous branch (with all its commits) is synced to the host repo as a new ref — no merging, no `git am`, no checkout switching
- The parent agent is told the anonymous branch name and commit range, and can reference/merge it however it wants
- No conflicts because each worker has its own unique branch
- The sync mechanism uses `git fetch` from the temp clone (which already has the commits) rather than `format-patch`/`am`

## Key types and interfaces

- `ContainerConfig` (`node/core/src/container/types.ts`): dockerfile, workspacePath, installCommand
- `ProvisionResult` (`node/core/src/container/types.ts`): containerName, tempDir, imageName, startSha
- `DockerSpawnConfig` (`node/core/src/capabilities/thread-manager.ts`): branch, containerName, tempDir, imageName, startSha, workspacePath, supervised
- `ThreadManager` (`node/core/src/capabilities/thread-manager.ts`): spawnThread, waitForThread, yieldResult
- `DockerSupervisor` (`node/chat/thread-supervisor.ts`): manages docker agent lifecycle, calls teardownContainer on yield
- `provisionContainer()` (`node/core/src/container/provision.ts`): clones repo, checks out branch, builds image, starts container
- `teardownContainer()` (`node/core/src/container/teardown.ts`): extracts patches, stops container, applies to host branch
- `spawn_subagent` tool (`node/core/src/tools/spawn-subagent.ts`): the tool agents use to spawn docker subagents, passes `branch` through

## Relevant files

- `node/core/src/container/provision.ts`: Container provisioning — needs to create anonymous branch from base
- `node/core/src/container/teardown.ts`: Commit syncing — needs complete rewrite to use branch-based sync
- `node/core/src/container/types.ts`: Types — ProvisionResult needs new fields
- `node/core/src/capabilities/thread-manager.ts`: DockerSpawnConfig — needs to carry anonymous branch name
- `node/core/src/tools/spawn-subagent.ts`: spawn_subagent tool — needs to pass base branch, report anonymous branch name
- `node/chat/thread-supervisor.ts`: DockerSupervisor — needs to use new teardown and report branch info
- `node/core/src/container/container.test.ts`: Integration tests for provision/teardown

# Implementation

## Phase 1: Rename `branch` to `baseBranch` and introduce `workerBranch`

- [ ] In `provisionContainer()`, change the semantics:
  - `branch` parameter becomes `baseBranch` — the branch to fork from (e.g., user's feature branch or `main`)
  - Generate a unique `workerBranch` name: `magenta/worker-{shortHash}` (using the existing `shortHash`)
  - Clone the repo, checkout `baseBranch`, then create `workerBranch` from it
  - The agent works on `workerBranch` inside the container
- [ ] Update `ProvisionResult` to include:
  - `workerBranch: string` — the name of the anonymous branch created for this worker
  - (keep `startSha` — still needed to know the fork point)
- [ ] Update `DockerSpawnConfig` to replace `branch` with:
  - `baseBranch: string` — what the worker was forked from
  - `workerBranch: string` — the anonymous branch the worker is committing to
- [ ] Fix all type errors from the above changes
  - [ ] `spawn-subagent.ts` — pass `baseBranch` instead of `branch`, carry `workerBranch` from provision result
  - [ ] `thread-supervisor.ts` — update constructor params
  - [ ] `chat.ts` — update DockerSupervisor instantiation
- [ ] Check for type errors (`npx tsgo -b`) and iterate until clean

## Phase 2: Rewrite teardown to use branch-based sync

- [ ] Rewrite `teardownContainer()`:
  - Instead of `git format-patch` + `git am`, use a different strategy:
    1. Copy commits out of the container: run `docker exec ... git bundle create` to create a git bundle of the worker branch
    2. Copy the bundle file out: `docker cp {container}:{path} {hostPath}`
    3. On the host repo, `git fetch {bundlePath} {workerBranch}:{workerBranch}` to import the branch
    4. Stop and remove the container
    5. Clean up temp dir
  - This avoids any checkout switching on the host
  - This avoids any conflicts — each worker branch is unique
  - The function should return info about what was synced: `{ workerBranch, baseBranch, commitCount }`
- [ ] Update the return type of `teardownContainer()` from `Promise<void>` to `Promise<TeardownResult>`:
  ```typescript
  interface TeardownResult {
    workerBranch: string;
    baseBranch: string;
    commitCount: number;
  }
  ```
- [ ] Remove divergence checking logic (no longer needed — each worker has a unique branch)
- [ ] Remove the `force` parameter (no longer needed)
- [ ] Check for type errors and iterate until clean

## Phase 3: Update the supervisor and result reporting

- [ ] Update `DockerSupervisor.onYield()`:
  - Call the new `teardownContainer()` and capture the `TeardownResult`
  - Return `{ type: "accept" }` with the teardown info (may need to extend `SupervisorAction` or attach info to the yield result)
- [ ] Update the spawn_subagent tool's result messages:
  - For blocking docker agents: include the `workerBranch` name in the result text so the parent knows which branch has the commits
  - For non-blocking docker agents: the branch info should be included when `wait_for_subagents` resolves
- [ ] Consider how the parent agent receives the worker branch name:
  - The yield result text from the docker agent should include the worker branch name
  - The supervisor could append branch info to the yield result before accepting
- [ ] Check for type errors and iterate until clean

## Phase 4: Update tests

- [ ] Update `node/core/src/container/container.test.ts`:
  - [ ] Test that provisioning creates a unique `workerBranch` forked from `baseBranch`
  - [ ] Test that teardown syncs the worker branch to the host repo without affecting other branches
  - [ ] Test parallel workers: two workers forked from the same base don't conflict
  - [ ] Remove tests for divergence detection / force overwrite (no longer applicable)
- [ ] Update `node/chat/thread-supervisor.test.ts` if needed
- [ ] Update `node/core/src/tools/spawn-subagent.test.ts` if needed
- [ ] Run all tests (`npx vitest run`) and iterate until passing

## Phase 5: Update system prompt / tool description

- [ ] Update `node/core/src/tools/spawn-subagent-description.md`:
  - Remove references to the agent needing to specify a branch name for commits
  - Explain that each docker worker automatically gets its own anonymous branch
  - Clarify that the parent receives the worker branch name in the result
- [ ] Consider whether `branch` should still be a required parameter for docker agents:
  - It now means "base branch to fork from" rather than "branch to commit to"
  - Could default to current HEAD if not specified
  - Rename in the tool spec to `baseBranch` for clarity, or keep as `branch` with updated description

## Phase 6: Cleanup

- [ ] Verify `npx tsgo -b` passes
- [ ] Verify `npx vitest run` passes
- [ ] Verify `npx biome check .` passes
- [ ] Review for any remaining references to the old patch-based sync approach