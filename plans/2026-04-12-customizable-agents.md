# Customizable Agent Definitions via Override Chain

## Context

The goal is to make all agent types — including `default`, `root`, and `docker_root` — customizable via `.md` files in the standard `agentsPaths` override chain (builtin → user → project).

Currently:
- `explore.md` and `fast-edit.md` exist as builtin `.md` files in `node/core/src/agents/`
- `tests-in-docker.md`, `tests-in-sandbox.md`, `worktree.md` exist in `.magenta/agents/`
- **`default`** subagent prompt is hardcoded: assembled from `subagent-common.md` + `codebase-conventions.md` + `code-changes.md` fragments in `node/core/src/providers/prompts/`
- **`root`** thread prompt is hardcoded: assembled from `default-system-prompt.md` + `codebase-conventions.md` + `code-changes.md` + `system-reminder.md`
- **`docker_root`** appends a docker preamble to the root prompt in `getBaseSystemPrompt()`
- `resolveSubagentConfig()` in `spawn-subagents.ts` short-circuits for `agentType === "default"`, bypassing the agents map
- System info (timestamp, platform, nvim version, cwd) and skills are appended dynamically in `createSystemPrompt()` — these stay as-is

### Relevant files and entities

- `node/core/src/agents/agents.ts`: `loadAgents()`, `parseAgentFile()`, `AgentsMap`, `AgentInfo` — loads and parses agent `.md` files from `agentsPaths`
- `node/core/src/providers/system-prompt.ts`: `createSystemPrompt()`, `getBaseSystemPrompt()`, `DEFAULT_SYSTEM_PROMPT`, `DEFAULT_SUBAGENT_SYSTEM_PROMPT` — builds final system prompts
- `node/providers/system-prompt.ts`: root-layer wrapper that adds nvim version info, calls core `createSystemPrompt()`
- `node/core/src/tools/spawn-subagents.ts`: `resolveSubagentConfig()` — resolves agent type to config, has hardcoded `"default"` bypass
- `node/chat/chat.ts`: `createThreadWithContext()`, `createNewAgentThread()`, `handleResubmit()` — creates threads, calls `createSystemPrompt()` with thread type
- `node/core/src/providers/prompts/`: fragment files (`default-system-prompt.md`, `subagent-common.md`, `codebase-conventions.md`, `code-changes.md`, `system-reminder.md`)
- `node/core/src/chat-types.ts`: `ThreadType` — `"root" | "subagent" | "compact" | "docker_root"`
- `node/options.ts`: `BUILTIN_AGENTS_PATH`, `agentsPaths` defaults
- `node/core/src/agents/agents.test.ts`: existing agent loading tests

### Override priority (already correct)

`agentsPaths` default order: `[BUILTIN_AGENTS_PATH, ~/.claude/agents, ~/.magenta/agents, .claude/agents, .magenta/agents]`

`loadAgents()` iterates in order, later entries override earlier → project > user > builtin. ✓

## Implementation

- [ ] Create `node/core/src/agents/default.md` — builtin default subagent
  - frontmatter: `name: default`, `description: ...`, `tier: thread`
  - body: inline content from `subagent-common.md` + `codebase-conventions.md` + `code-changes.md`
  - test: `loadAgents()` returns an agent named `"default"` from the builtin path
  - test: placing a `default.md` in a later path overrides the builtin

- [ ] Create `node/core/src/agents/root.md` — builtin root thread agent
  - frontmatter: `name: root`, `description: ...`, `tier: thread`
  - body: inline content from `default-system-prompt.md` + `codebase-conventions.md` + `code-changes.md`
  - `<system_reminder>` tags wrapping content from `system-reminder.md`
  - test: `loadAgents()` returns an agent named `"root"`

- [ ] Create `node/core/src/agents/docker-root.md` — builtin docker root agent
  - frontmatter: `name: docker-root`, `description: ...`, `tier: thread`
  - body: root prompt + docker addendum (currently in `getBaseSystemPrompt("docker_root")`)
  - `<system_reminder>` tags wrapping same system reminder content
  - test: `loadAgents()` returns an agent named `"docker-root"`

- [ ] Update `resolveSubagentConfig()` in `node/core/src/tools/spawn-subagents.ts`
  - Remove the `"default"` short-circuit (`if (!agentType || agentType === "default") return { tier: "thread" }`)
  - All agent types resolve through the `AgentsMap` lookup
  - Unknown types still fall back to `{ agentName: agentType, tier: "leaf" }`
  - test: `resolveSubagentConfig({ agentType: "default" }, agents)` returns the loaded default agent config
  - test: existing behavior for known/unknown types is preserved

- [ ] Update `getBaseSystemPrompt()` in `node/core/src/providers/system-prompt.ts`
  - For `"root"`: use `subagentConfig?.systemPrompt` if provided, else fall back to loaded `"root"` agent
  - For `"docker_root"`: use `subagentConfig?.systemPrompt` if provided, else fall back to loaded `"docker-root"` agent
  - For `"subagent"`: already works (uses `subagentConfig?.systemPrompt ?? DEFAULT_SUBAGENT_SYSTEM_PROMPT`)
  - The function needs the agents map (or pre-resolved config) passed in. Best approach: have the callers always resolve the agent config and pass it as `subagentConfig`.

- [ ] Update callers in `node/chat/chat.ts` to pass agent config for root/docker_root threads
  - `createThreadWithContext()`: if `threadType === "root"` and no `subagentConfig` provided, load agents and look up `"root"`
  - Same for `"docker_root"` → look up `"docker-root"`
  - `handleResubmit()` (line ~682): same treatment
  - test: creating a root thread uses `root.md` system prompt
  - test: creating a docker_root thread uses `docker-root.md` system prompt

- [ ] Delete prompt fragment files in `node/core/src/providers/prompts/`
  - Delete `default-system-prompt.md`, `subagent-common.md`, `codebase-conventions.md`, `code-changes.md`, `system-reminder.md`
  - Remove `DEFAULT_SYSTEM_PROMPT`, `DEFAULT_SUBAGENT_SYSTEM_PROMPT` constants from `node/core/src/providers/system-prompt.ts`
  - Remove `PROMPTS_DIR`, `loadPrompt()` helper
  - Keep `COMPACT_SYSTEM_PROMPT` (compact is not a proper agent)
  - Update `node/providers/system-prompt.ts` to stop re-exporting removed constants
  - Check for any other references to the deleted constants and update them
  - test: type-check passes (`npx tsgo -b`)

- [ ] Update `node/core/src/agents/agents.test.ts`
  - Add test: builtin `default`, `root`, `docker-root` agents are loaded
  - Add test: user-provided `default.md` overrides builtin `default.md`
  - Add test: user-provided `root.md` overrides builtin `root.md`

- [ ] Update `node/providers/system-prompt.test.ts`
  - Adapt tests that reference `DEFAULT_SYSTEM_PROMPT` / `DEFAULT_SUBAGENT_SYSTEM_PROMPT`
  - Add test: root thread system prompt comes from `root.md` agent
  - Add test: overridden root agent changes the system prompt

- [ ] Run full test suite and fix any failures
  - `npx tsgo -b` for type checks
  - `TEST_MODE=sandbox npx vitest run` for tests
