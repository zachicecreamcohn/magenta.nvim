# Context

**Objective**: Build a general-purpose system for provisioning isolated development containers for agent work. The system has two layers:

1. **Per-project config** — each project describes its dev environment (Dockerfile, workspace path). This lives in the project repo.
2. **Generic orchestration** — scripts that handle the git lifecycle (clone, branch checkout, remote removal) and container lifecycle (build, run, teardown, fetch branch back). This lives in magenta.

We use magenta.nvim as the first example project, but the orchestration scripts should work with any project that provides the config.

**Lifecycle**:

1. **Provision**: Clone repo locally (`--local` for speed via hardlinks), checkout a branch, remove remote, build Docker image from the clone (code baked in via Dockerfile), run container
2. **Work**: Agent edits, runs tests, makes commits inside the container via `docker exec`
3. **Teardown**: Extract branch from container via `git bundle`, stop container, fetch branch back into host repo, clean up temp dir

**Key decisions**:

- **No bind mounts**: Code is baked into the Docker image at build time. Docker layer caching keeps rebuilds fast (only the final `COPY . .` layer changes between branches with the same deps). This avoids macOS bind-mount I/O penalties and eliminates the need for `installCommand` or `volumeOverlays`.
- **Dockerfile only** (no devcontainer.json): Devcontainers are designed for long-lived, bind-mounted environments — a different use case. We may add devcontainer support later as a separate code path.
- **Branch contract**: The agent operates on an existing branch. The caller (user or coordinator agent) is responsible for creating the branch beforehand. On teardown, only the named branch is fetched back — no merging, no other refs trusted.
- **Agent can commit**: Git is configured inside the container so the agent can split work into meaningful commits.

## Per-project config

Each project adds a `container` section to its `.magenta/options.json`:

```jsonc
{
  // ... existing options (commandConfig, etc.) ...
  "container": {
    // Path to a Dockerfile (relative to repo root)
    "dockerfile": "docker/Dockerfile",

    // Where the project lives inside the container (should match WORKDIR)
    "workspacePath": "/workspace",
  },
}
```

The orchestration scripts read `container` from `.magenta/options.json` and use it to drive the container lifecycle. Projects without this section can't use the dev container system.

**Dockerfile contract**: The Dockerfile receives the repo as its build context and should produce a container that is ready for the agent to work in. It should:

- Install the project's toolchain (compilers, language servers, etc.)
- Install project dependencies (using Docker layer caching for speed)
- Configure git user name/email (so the agent can commit)
- Set WORKDIR to the workspace path
- Use `tail -f /dev/null` or similar as CMD (keep container alive)

## Relevant files

- `.github/workflows/test.yml` — CI definition for magenta.nvim; the example Dockerfile should mirror its tooling (Node 24, Neovim, tree-sitter parser, ts-language-server, fzf, fd)
- Provisioning/teardown logic lives in `@magenta/core` as importable modules (using `child_process` for git/docker commands)
- `node/capabilities/docker-shell.ts`, `node/capabilities/docker-file-io.ts` — Docker capability implementations that use `docker exec` / `docker cp`
- `node/environment.ts` — `createDockerEnvironment` factory

## Temp directory layout

```
/tmp/magenta-dev-containers/<container-name>/
  repo/          # the cloned git repo, used as Docker build context
```

# Implementation

## Step 1: Define per-project config format ✅

- [x] Add `container` section to `.magenta/options.json` for magenta.nvim:
  - [x] `dockerfile`: `"docker/Dockerfile"`
  - [x] `workspacePath`: `"/workspace"`

## Step 2: Example Dockerfile for magenta.nvim ✅

- [x] Create `docker/Dockerfile`
  - [x] Base: `node:24-bookworm` (Debian-based, matches CI)
  - [x] `apt-get install`: `git`, `build-essential`, `fzf`, `fd-find`, `curl`
  - [x] Install Neovim stable
  - [x] Install `typescript-language-server` and `typescript` globally
  - [x] Build tree-sitter TypeScript parser
  - [x] Configure git user.name and user.email
  - [x] Set `WORKDIR /workspace`
  - [x] Copy project files and install deps (with layer caching)
  - [x] Default command: `tail -f /dev/null`

## Step 3: Provisioning module

- [ ] Create `node/core/src/container/provision.ts`
- [ ] `provisionContainer(opts)` function:
  - [ ] Input: `{ repoPath, branch, containerConfig }`
  - [ ] Generate a unique container name (e.g. `<branch>-<short-hash>`)
  - [ ] Create temp dir at `/tmp/magenta-dev-containers/<name>/repo`
  - [ ] `git clone --local <repo-path> <temp-dir>/repo`
  - [ ] `git checkout <branch>` (branch must already exist)
  - [ ] `git remote remove origin`
  - [ ] `docker build -t <image-tag> -f <dockerfile> <temp-dir>/repo`
  - [ ] `docker run -d --name <name> <image-tag>`
  - [ ] Return `{ containerName, tempDir, imageName }` for later teardown
- [ ] Write tests (using real Docker)

## Step 4: Teardown module

- [ ] Create `node/core/src/container/teardown.ts`
- [ ] `teardownContainer(opts)` function:
  - [ ] Input: `{ containerName, repoPath, branch, tempDir }`
  - [ ] Extract branch from container: `docker exec git bundle create /tmp/work.bundle <branch>`
  - [ ] Copy bundle out: `docker cp <containerName>:/tmp/work.bundle <tempDir>/work.bundle`
  - [ ] Stop and remove the container: `docker rm -f <containerName>`
  - [ ] Fetch branch into host repo: `git -C <repoPath> bundle unbundle <tempDir>/work.bundle` then `git fetch <tempDir>/work.bundle <branch>:<branch>`
  - [ ] Remove the temp directory: `rm -rf <tempDir>`
- [ ] Write tests:
  - [ ] Make a commit inside the container (via `docker exec git commit`)
  - [ ] Call `teardownContainer`, verify:
    - [ ] Container is stopped and removed
    - [ ] Branch was fetched back into the host repo with the new commit
    - [ ] Temp directory is cleaned up

## Step 5: Test end-to-end

- [ ] Start a container for magenta.nvim on a test branch
- [ ] `docker exec` to make a commit inside the container
- [ ] Stop the container and verify the commit appears in the host repo on the branch
- [ ] Verify the temp directory is cleaned up

## Step 6: User command to start a container thread

A `:Magenta docker <branch>` command that provisions a container and creates a thread inside it.

- [ ] Add `docker` to the command list in `lua/magenta/init.lua`
- [ ] Handle `docker <branch>` in `Magenta.command()`:
  - [ ] Read `container` config from `.magenta/options.json`
  - [ ] Run provisioning (clone, build, run)
  - [ ] Call `createDockerEnvironment` with the container ID
  - [ ] Create a new thread with that environment
  - [ ] Switch to the new thread in the sidebar
- [ ] On thread teardown / `:Magenta docker-stop <branch>`:
  - [ ] Run the teardown (extract branch, stop container, clean up)
- [ ] Verify: `:Magenta docker my-feature` opens a thread where the agent can edit files and run tests inside the container

**Future**: Orchestration agent that can spawn container threads programmatically via `spawn_subagent` tool with `docker` agent type.

## Step 7: Documentation ✅

- [x] Document the `.magenta/options.json` container config format
- [x] Add dev containers section to `doc/magenta-tools.txt`
- [x] Add to README features and changelog
- [x] Update `doc/magenta.txt` features and changelog
