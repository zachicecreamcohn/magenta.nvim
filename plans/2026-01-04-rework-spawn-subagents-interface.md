## Plan: Rework `spawn_subagents` parameter model

### Current state

Today, the `SubagentEntry` mixes three orthogonal concerns into a single `agentType` field:

- **Agent identity** (system prompt / personality): `"default"`, `"explore"`, `"plan"`, or any custom agent name
- **Model speed**: `"fast"` (uses `fastModel` from profile)
- **Execution environment**: `"docker"` / `"docker_unsupervised"` (provisions a container, creates docker environment, attaches supervisor)

The `BASE_AGENT_TYPES` array hardcodes `["default", "fast", "docker", "docker_unsupervised"]`, then custom agent names from `AgentsMap` are appended. The `resolveSubagentConfig()` function has special-case branches for `"fast"` and `"default"`.

There's also no way to specify a shared prompt or shared context files list across all sub-agents in a single invocation.

### Goal

Separate these into orthogonal parameters and add shared prompt/contextFiles:

1. **`agentType`** — selects the agent personality/system-prompt. Values: `"default"` + all custom agent names (e.g. `"explore"`, `"plan"`, user-defined). The `"fast"` base type goes away — replaced by a builtin `fast-edit` agent (or similar) loaded from an `.md` file.

2. **`environment`** — selects where the agent runs. Values: `"host"` (default), `"docker"`, `"docker_unsupervised"`. The `branch` parameter remains and is required when environment is docker.

3. **Shared fields** — top-level `sharedPrompt` and `sharedContextFiles` that get prepended/merged into every sub-agent entry.

### Implementation steps

#### Step 1: Create a `fast-edit.md` builtin agent

Create `node/core/src/agents/fast-edit.md` with:

- Frontmatter: `name: fast-edit`, `description: ...`, `fastModel: true`
- System prompt body focused on quick, predictable edits

This replaces the current `"fast"` base agent type. The `explore` agent already has `fastModel: true` in its frontmatter, so it continues to work.

#### Step 2: Rework `SubagentEntry` type

```typescript
export type SubagentEntry = {
  prompt?: string; // per-agent prompt (optional if sharedPrompt provided)
  contextFiles?: UnresolvedFilePath[]; // per-agent context files
  agentType?: string; // "default" | custom agent name (no more "fast", "docker", etc.)
  environment?: "host" | "docker" | "docker_unsupervised"; // default: "host"
  branch?: string; // required when environment is docker*
};
```

#### Step 3: Rework `Input` type

```typescript
export type Input = {
  sharedPrompt?: string; // prepended to each agent's prompt
  sharedContextFiles?: UnresolvedFilePath[]; // merged with each agent's contextFiles
  agents: SubagentEntry[];
};
```

#### Step 4: Update `resolveSubagentConfig()`

Remove the `"fast"` special case. The function only needs to handle:

- `undefined` / `"default"` → `{}`
- Custom agent name → look up in `AgentsMap`, return `{ agentName, fastModel, systemPrompt, systemReminder }`
- Unknown name → `{ agentName }` (current fallback behavior)

#### Step 5: Update `execute()`

- Merge `sharedPrompt` and `sharedContextFiles` into each entry before processing.
- Determine docker vs host based on `entry.environment` instead of `entry.agentType`.
- The `spawnDockerEntry` function stays largely the same but checks `entry.environment` instead of `entry.agentType`.
- `threadType` for docker entries remains `"docker_root"`.
- The `supervised` field on `dockerSpawnConfig` is set based on `entry.environment === "docker"` (supervised) vs `"docker_unsupervised"`.

#### Step 6: Update `getSpec()`

- Remove `BASE_AGENT_TYPES`. The `agentType` enum is just `["default", ...agentNames]`.
- Add `environment` property with enum `["host", "docker", "docker_unsupervised"]`.
- Add `sharedPrompt` and `sharedContextFiles` as top-level properties in the input schema.
- Make individual `prompt` optional (but validate that at least one of `prompt` or `sharedPrompt` is set).

#### Step 7: Update `validateInput()`

- Validate new `sharedPrompt` (optional string) and `sharedContextFiles` (optional string array).
- Validate `environment` field on each agent entry.
- `prompt` is now optional per-agent if `sharedPrompt` is provided; validate that at least one exists.
- `agentType` validation: ensure it's a string if present (no change needed since it's already permissive).

#### Step 8: Update `spawn-subagents-description.md`

Rewrite the description to document the new parameter model:

- `agentType` → agent personality
- `environment` → execution environment
- `sharedPrompt` / `sharedContextFiles` → shared across all agents
- Update examples to use the new parameter names

#### Step 9: Update system prompt references

The system prompt in `context.md` (which gets injected into the conductor) references the old parameter model. Update the `spawn_subagents` tool description there to match the new parameters.

#### Step 10: Update tests

Find and update all tests that reference the old `spawn_subagents` parameter model (particularly any that use `agentType: "fast"`, `agentType: "docker"`, etc.).

### Things that stay the same

- `ThreadType` enum (`"subagent"`, `"docker_root"`, etc.) — unchanged
- `SubagentConfig` type — unchanged
- `DockerSpawnConfig` type — unchanged
- `ThreadManager` interface — unchanged
- The provisioning flow for docker containers — unchanged
- `AgentsMap` and agent loading — unchanged (just adding a new builtin agent file)

### Migration concerns

- The `"fast"` agentType disappears. Any existing prompts/configurations using `agentType: "fast"` will fall through to the unknown-agent-name path. The new `fast-edit` agent serves the same purpose.
- `"docker"` / `"docker_unsupervised"` move from `agentType` to `environment`. Old usages will break — but since these are only used by the LLM (not persisted config), this is fine as long as the tool spec is updated.

### Testing Strategy

There are three test files covering `spawn_subagents`:

1. **`node/core/src/tools/spawn-subagents.test.ts`** — Core unit tests (mock `ThreadManager`, no neovim)
2. **`node/render-tools/spawn-subagents.test.ts`** — Integration tests for TUI rendering (uses `withDriver`)
3. **`node/tools/spawn-subagents.test.ts`** — Integration tests for tool behavior and agent types (uses `withDriver`)

#### Tests to update (existing)

**`node/core/src/tools/spawn-subagents.test.ts`:**

- **"maps agentType to correct threadType"** — Currently tests `agentType: "fast"` → `"subagent"`. Update to use `agentType: "fast-edit"` (the new builtin agent) and add a case with `environment: "host"` (explicit) to confirm it stays `"subagent"`.
- **"mixed agents: docker and non-docker in parallel"** — Currently uses `agentType: "docker"`. Change to `environment: "docker"` with a separate `agentType` (or none).
- **All docker provisioning tests** — Currently pass `agentType: "docker"` / `"docker_unsupervised"`. Update to use `environment: "docker"` / `"docker_unsupervised"` instead, keeping `agentType` independent.
- **"docker_unsupervised agentType sets supervised=true"** — Rename/update to test `environment: "docker_unsupervised"`.
- **"returns error when branch is missing for docker agentType"** — Update to test `environment: "docker"` without `branch`.
- **Validation tests** — The existing ones (`rejects empty agents`, `rejects missing prompt`, `rejects non-string agentType`, etc.) stay mostly the same but need additions (see below).

**`node/tools/spawn-subagents.test.ts`:**

- **"uses fast model for subagents when agentType is 'fast'"** — Update to use `agentType: "fast-edit"` and verify it still uses the fast model (via the `fast-edit.md` agent definition).
- **"Explore subagent"** test — Should be unaffected (explore agent stays the same).
- **Custom agent discovery tests** — Should be unaffected.

**`node/render-tools/spawn-subagents.test.ts`:**

- Scan for any tests that construct `spawn_subagents` tool calls with `agentType: "docker"` or `"fast"` and update accordingly. These tests mostly deal with rendering, so the main change is updating the mock tool inputs.

#### New tests to add

**`node/core/src/tools/spawn-subagents.test.ts`** (unit tests):

1. **`sharedPrompt` merging** — Verify that when `sharedPrompt` is provided, it is prepended to each agent's individual `prompt` in the `spawnThread` call. Test with and without per-agent `prompt`.
2. **`sharedContextFiles` merging** — Verify that `sharedContextFiles` are merged with per-agent `contextFiles`. Test deduplication behavior (if any) and ordering.
3. **`prompt` optional when `sharedPrompt` provided** — Verify that an agent entry without `prompt` succeeds when `sharedPrompt` is set, and the spawned thread receives `sharedPrompt` as its prompt.
4. **`environment` routing** — Verify `environment: "host"` (or omitted) goes through the non-docker path, `environment: "docker"` / `"docker_unsupervised"` go through docker provisioning.
5. **`environment` + `agentType` orthogonality** — Verify you can combine `environment: "docker"` with `agentType: "explore"` (i.e., run an explore agent inside a docker container). The spawned thread should get both the explore system prompt AND docker provisioning.
6. **`resolveSubagentConfig` with new `fast-edit` agent** — Verify that `agentType: "fast-edit"` resolves to a config with `fastModel: true` and a system prompt (loaded from the `.md` file).

**Validation tests** (in the same core test file):

7. **Rejects non-string `sharedPrompt`** — `validateInput({ sharedPrompt: 123, agents: [...] })` → error.
8. **Rejects non-array `sharedContextFiles`** — `validateInput({ sharedContextFiles: "file.ts", agents: [...] })` → error.
9. **Rejects non-string items in `sharedContextFiles`** — e.g., `sharedContextFiles: [123]` → error.
10. **Rejects invalid `environment` value** — `validateInput({ agents: [{ prompt: "x", environment: "invalid" }] })` → error.
11. **Rejects missing `prompt` when no `sharedPrompt`** — `validateInput({ agents: [{ agentType: "explore" }] })` → error (same as today).
12. **Accepts missing per-agent `prompt` when `sharedPrompt` provided** — `validateInput({ sharedPrompt: "do stuff", agents: [{ agentType: "explore" }] })` → ok.

**`getSpec()` tests** (new describe block in core test file):

13. **Spec does not include `"fast"`, `"docker"`, `"docker_unsupervised"` in `agentType` enum** — Verify these are gone from the agent type enum in the generated spec.
14. **Spec includes `"default"` and custom agent names in `agentType` enum** — Verify the enum contains `["default", "explore", "plan", "fast-edit", ...]`.
15. **Spec includes `environment` property** with enum `["host", "docker", "docker_unsupervised"]`.
16. **Spec includes top-level `sharedPrompt` and `sharedContextFiles` properties**.

**Integration test** (`node/tools/spawn-subagents.test.ts`):

17. **`sharedPrompt` appears in subagent thread** — End-to-end test: send a `spawn_subagents` tool call with `sharedPrompt` and verify the subagent stream receives the shared prompt content in its messages.
18. **`fast-edit` agent is discoverable in tool spec** — Similar to existing "Built-in agents" test: verify `fast-edit` appears with correct description.
