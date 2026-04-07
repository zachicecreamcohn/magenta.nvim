# Worktree-based Parallel Development

## Context

The goal is to enable a root agent to orchestrate work across multiple git worktrees simultaneously, with subagents operating independently in each worktree. This replaces the current conductor model with a more composable system.

### Current state

**Subagent spawning** (`node/core/src/tools/spawn-subagents.ts`):

- `SubagentEntry` has `environment` (host/docker/docker_unsupervised) and `directory` fields
- `directory` is only used for docker environments — it resolves where to find `.magenta/options.json` for container config
- Host subagents always inherit the parent thread's environment config and cwd
- Subagents get `threadType: "subagent"` which **excludes** `spawn_subagents` from their tool list (see `SUBAGENT_STATIC_TOOL_NAMES` in `tool-registry.ts`)
- Docker subagents get `threadType: "docker_root"` which includes `spawn_subagents`

**Conductor** (`node/core/src/chat-types.ts`, `conductor-system-prompt.md`):

- `ThreadType = "subagent" | "compact" | "root" | "docker_root" | "conductor"`
- Conductor gets same tools as root (`CHAT_STATIC_TOOL_NAMES`) — includes `spawn_subagents`, excludes `yield_to_parent`
- Has its own system prompt focused on task tracking in `~/.magenta/tasks/`
- Created via `:Magenta new-conductor-thread` command / `<leader>mc` keymap
- Has special system reminder in `system-reminders.ts`

**Agent definitions** (`.magenta/agents/`, `node/core/src/agents/`):

- Markdown files with YAML frontmatter: `name`, `description`, `fastModel`
- Body becomes systemPrompt, optional `<system_reminder>` tags
- Loaded by `loadAgents()` in `agents.ts`, resolved by `resolveSubagentConfig()` in spawn-subagents
- Currently no frontmatter field to control tool availability (e.g. allowing `spawn_subagents`)

**Docker container config** (`.magenta/options.json`):

- `container: { dockerfile, workspacePath }`
- Read from the `directory` field in spawn_subagents when environment is docker
- Also loaded globally by `DynamicOptionsLoader` in `options-loader.ts`

**Thread creation** (`node/chat/chat.ts`):

- `spawnThread()` receives `threadType`, `dockerSpawnConfig`, `subagentConfig`
- For docker: creates `EnvironmentConfig` with type "docker" using container/workspacePath
- For host: copies parent thread's environmentConfig
- Tracks depth for UI indentation

### Key files

- `node/core/src/tools/spawn-subagents.ts` — spawn logic, docker provisioning, tool schema
- `node/core/src/tools/tool-registry.ts` — tool lists per thread type
- `node/core/src/tools/toolManager.ts` — routes thread type to tool list
- `node/core/src/chat-types.ts` — ThreadType union, SubagentConfig
- `node/core/src/agents/agents.ts` — agent loading, frontmatter parsing
- `node/core/src/providers/system-prompt.ts` — system prompt selection per thread type
- `node/core/src/providers/system-reminders.ts` — system reminders per thread type
- `node/core/src/providers/prompts/conductor-system-prompt.md` — conductor prompt
- `node/core/src/providers/prompts/conductor-docker-addendum.md` — docker addendum
- `node/chat/chat.ts` — thread creation, depth tracking
- `node/magenta.ts` — command dispatch, including `new-conductor-thread`
- `lua/magenta/keymaps.lua` — keymaps
- `node/options.ts` — options parsing, BUILTIN_AGENTS_PATH
- `node/core/src/container/types.ts` — ContainerConfig type

## Implementation

### Phase 1: Allow host subagents to specify cwd

Currently `directory` is documented as docker-only. We need host subagents to run with a different cwd.

- [ ] In `spawn-subagents.ts`, update the host subagent path in `spawnEntry()`:
  - Resolve `entry.directory` relative to `ctx.cwd` (like docker already does)
  - Pass the resolved directory as `cwd` to `threadManager.spawnThread()`
- [ ] Update `ThreadManager.spawnThread()` interface in `node/core/src/capabilities/thread-manager.ts` to accept an optional `cwd` parameter
- [ ] Update `Chat.spawnThread()` in `node/chat/chat.ts` to use the provided `cwd` when creating the thread's environment config
- [ ] Update the tool schema description for `directory` in `getSpec()` to reflect that it now works for host subagents too (not just docker)
- [ ] Update the `spawn-subagents-description.md` doc to mention the directory parameter works for host environments

**Testing:**

- Unit test: spawn a host subagent with `directory: "/some/path"`, verify the thread is created with that cwd
- Integration test: spawn a host subagent with a different directory, verify it can `get_file` relative to that directory

### Phase 2: Move docker config from options.json to spawn_subagents tool parameter

Instead of requiring `.magenta/options.json` in each directory, let the agent specify dockerfile/workspacePath directly in the tool call.

- [ ] Add optional fields to `SubagentEntry` type:
  ```
  dockerfile?: string;      // path to Dockerfile, relative to directory
  workspacePath?: string;    // cwd for the agent inside container
  ```
- [ ] Rewrite `spawnDockerEntry()` to use inline fields only:
  - Remove all `.magenta/options.json` reading logic from `spawnDockerEntry()`
  - Require `dockerfile` and `workspacePath` on the entry (validate in `validateInput()`)
- [ ] Remove `container` field from `MagentaOptions` in `node/options.ts`
- [ ] Remove `parseContainerConfig()` from `node/options.ts`
- [ ] Remove `container` from `mergeOptions()` in `node/options.ts`
- [ ] Remove `ContainerConfig` type from `node/core/src/container/types.ts` (or repurpose if still needed internally)
- [ ] Remove `container` from `.magenta/options.json`
- [ ] Update the tool schema in `getSpec()` to include the new optional properties
- [ ] Update validation in `validateInput()` for the new fields
- [ ] Update `spawn-subagents-description.md` to document both approaches

**Testing:**

- Unit test: validate that inline docker config is accepted and required
- Unit test: validate that missing dockerfile/workspacePath for docker env produces error
- Integration test (docker): spawn a docker subagent with inline config, verify container provisions correctly

### Phase 3: Agent tier system for spawn control

Replace the binary "has spawn_subagents or not" with a tier-based system that controls which agents each agent can spawn.

**Tier definitions:**

| Tier           | Can spawn                                            | Built-in examples                                     |
| -------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| `leaf`         | nothing                                              | explore, fast-edit, tests-in-sandbox, tests-in-docker |
| `thread`       | leaf (any env) + thread (docker only)                | default                                               |
| `orchestrator` | leaf + thread (any env) + orchestrator (docker only) | worktree                                              |

Root user chat is implicitly above all tiers — can spawn any agent in any environment.

**Consistent rule: each tier can spawn lower tiers in any environment. Thread agents can spawn other thread agents in docker.** This prevents host-agent recursion while allowing docker isolation for same-tier work (e.g. default spawns default-in-docker).

**Frontmatter:** `tier: leaf | thread | orchestrator` (default: `leaf` for custom agents)

When `agentType` is omitted or `"default"` in spawn_subagents, the implicit tier is `thread`.

**Implementation:**

- [ ] Add `AgentTier = "leaf" | "thread" | "orchestrator"` type to `agents.ts`
- [ ] Add `tier` field to `AgentFrontmatter` and `AgentInfo` types
- [ ] Parse `tier` in `extractAgentFrontmatter()`, default to `"leaf"` if absent
- [ ] Assign tiers to built-in agents:
  - `explore.md`, `fast-edit.md`: `tier: leaf`
  - `tests-in-sandbox.md`, `tests-in-docker.md`: `tier: leaf`
- [ ] Add `tier` to `SubagentConfig` in `chat-types.ts`
- [ ] Propagate tier from `resolveSubagentConfig()` in `spawn-subagents.ts`
- [ ] Change `getToolSpecs()` in `toolManager.ts`:
  - Accept `subagentConfig?: SubagentConfig` parameter
  - If tier is `leaf` (or absent), exclude `spawn_subagents`
  - If tier is `thread` or `orchestrator`, include `spawn_subagents` with filtered agent list
- [ ] Change `SpawnSubagents.getSpec()` to accept the current agent's tier, and filter the agents enum:
  - `thread`: only show `leaf` agents, plus `thread` agents (for docker spawning)
  - `orchestrator`: show `leaf` and `thread` agents, plus `orchestrator` agents (for docker spawning)
  - The tool description should note that same-tier agents require docker environment
- [ ] Add validation in `spawn-subagents.ts` `execute()`: if spawning a same-tier agent, require `environment` to be docker/docker_unsupervised
- [ ] Thread the `subagentConfig` through from `ThreadCore` where `getToolSpecs` is called
- [ ] Remove the `docker_root` thread type from `ThreadType` union — docker is now just an environment concern:
  - Subagents in docker get `yield_to_parent` (because they're subagents) + docker-specific system prompt additions
  - Their tier determines spawning ability, not their thread type
  - Update `DOCKER_ROOT_STATIC_TOOL_NAMES` removal and related switches

**Testing:**

- Unit test: `leaf` agent → no `spawn_subagents` in tool specs
- Unit test: `thread` agent → `spawn_subagents` with only leaf + thread agents in enum
- Unit test: `orchestrator` agent → `spawn_subagents` with leaf + thread + orchestrator agents in enum
- Unit test: `thread` agent trying to spawn a `thread` agent on host → validation error
- Unit test: `thread` agent spawning a `thread` agent in docker → allowed
- Integration test: spawn a `thread` subagent that itself spawns a `leaf` subagent, verify nested completion

### Phase 4: Replace conductor with a worktree agent

Convert the conductor from a hardcoded thread type to a builtin agent definition.

- [ ] Create `.magenta/agents/worktree.md` with:
  - Frontmatter: `name: worktree`, `description: ...`, `tier: orchestrator`
  - Body: adapted from `conductor-system-prompt.md`, focused on worktree orchestration
  - System reminder focused on git worktree workflow
- [ ] Remove `"conductor"` from the `ThreadType` union in `chat-types.ts`
- [ ] Remove conductor-specific branches in:
  - `system-prompt.ts` (`getBaseSystemPrompt` switch)
  - `system-reminders.ts` (`getSubsequentReminder` switch)
  - `toolManager.ts` (`getToolSpecs` switch)
  - `magenta.ts` (the `new-conductor-thread` command)
  - `lua/magenta/keymaps.lua` (the `<leader>mc` keymap)
  - `node/chat/chat.ts` (`createNewConductorThread` method)
  - `node/chat/thread-view.ts` (the 🎼 emoji)
- [ ] Remove `conductor-system-prompt.md` and `conductor-docker-addendum.md`
- [ ] Run type checker (`npx tsgo -b`) and fix all errors from the removed type

**Testing:**

- Type check passes with conductor removed
- Existing tests still pass
- The worktree agent can be spawned via `spawn_subagents` with `agentType: "worktree"` and can itself spawn subagents

### Phase 5: Add `:Magenta agent <name>` command

Allow the user to start a new root-level thread with a custom agent prompt, replacing the dedicated conductor command.

- [ ] Add a new command `agent` to the Magenta command handler in `magenta.ts`
  - Accepts one argument: the agent name (e.g., "worktree")
  - Dispatches a new message: `{ type: "chat-msg", msg: { type: "new-agent-thread", agentName: string } }`
- [ ] Add `new-agent-thread` to the Chat message types
- [ ] Implement `createNewAgentThread(agentName)` in `chat.ts`:
  - Look up the agent in the loaded agents map
  - Create a new thread with `threadType: "root"` but using the agent's system prompt, system reminder, and tier-based tool list
  - This means root threads also need to accept optional `subagentConfig` to customize their system prompt and tier
- [ ] Update the lua command registration to accept the argument
- [ ] Update keymaps: replace `<leader>mc` conductor keymap with `<leader>mw` for `:Magenta agent worktree`

**Testing:**

- `:Magenta agent worktree` creates a thread with the worktree system prompt
- The thread has `spawn_subagents` available
- `:Magenta agent nonexistent` gives a clear error
