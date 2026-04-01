# context

The goal is to support custom subagents defined as markdown files (like Claude Code's `.claude/agents/`). Agents are discovered from configurable directories, and the `spawn_subagents` tool dynamically includes them in its description and schema. Built-in agents (explore, plan) live alongside custom ones.

Key changes:
- **Decouple ThreadType from subagent configuration**: `ThreadType` becomes just `"subagent"` (no more `subagent_default`/`subagent_fast`/`subagent_explore`). Subagent behavior is configured via a new `SubagentConfig` that specifies model (normal/fast), environment (docker/host), and agent definition (built-in or custom).
- **Agent discovery**: New `loadAgents()` function (parallel to `loadSkills()`) discovers `.md` files from configurable `agentsPaths` directories.
- **Dynamic tool spec**: `spawn_subagents` spec becomes a function that takes discovered agents and generates the description + enum dynamically.
- **System prompt/reminder from agent files**: The markdown body becomes the system prompt. `<system_reminder>` blocks are extracted and *appended* to the standard subagent reminder.
- **`fastModel: true` frontmatter**: Signals the subagent should use the fast model.
- **Built-in agents**: `explore` and `plan` become `.md` files in `node/core/src/agents/`.

Relevant files:
- `node/core/src/chat-types.ts`: `ThreadType` union — needs `subagent_explore` removed, consolidated to `subagent`
- `node/core/src/tools/spawn-subagents.ts`: Tool implementation — spec becomes dynamic, spawning uses `SubagentConfig`
- `node/core/src/tools/spawn-subagents-description.md`: Static description — becomes a template
- `node/core/src/tools/toolManager.ts`: `getToolSpecs()` — must handle new `"subagent"` ThreadType, pass agents to spawn_subagents spec
- `node/core/src/tools/tool-registry.ts`: Tool name lists — update for consolidated subagent type
- `node/core/src/providers/system-prompt.ts`: `getBaseSystemPrompt()`, `AGENT_TYPES` — remove explore-specific branching, add custom agent support
- `node/core/src/providers/system-reminders.ts`: `getSubsequentReminder()` — consolidate subagent cases, support appending custom reminders
- `node/core/src/providers/skills.ts`: Pattern to follow for agent discovery
- `node/core/src/capabilities/thread-manager.ts`: `ThreadManager.spawnThread()` — needs to accept `SubagentConfig`
- `node/chat/chat.ts`: `spawnThread()` — implements new config-based spawning
- `node/chat/thread.ts`: Thread constructor — bridges core and root
- `node/providers/system-prompt.ts`: Root wrapper — update for new signature
- `node/core/src/providers/prompts/explore-subagent.md`: Move to `node/core/src/agents/explore.md`
- `node/core/src/providers/prompts/subagent-common.md`: Default subagent system prompt (used when no custom agent specified)
- `node/skills/plan/skill.md`: To be deleted, replaced by `node/core/src/agents/plan.md`
- `node/options.ts`: Add `agentsPaths` option with defaults
- `node/core/src/provider-options.ts`: Add `agentsPaths` to `ProviderOptions`

# implementation

## Phase 1: Agent discovery infrastructure

- [x] Create `node/core/src/agents/` directory
- [x] Create `node/core/src/agents/explore.md` — move content from `node/core/src/providers/prompts/explore-subagent.md`, add frontmatter:
  ```
  ---
  name: explore
  description: Specialized in searching and understanding codebases. Use when you don't know where to look.
  ---
  ```
  Extract the `<system_reminder>` block if one exists (or add one with the explore-specific reminders).
- [x] Create `node/core/src/agents/plan.md` — convert `node/skills/plan/skill.md` content into agent format with frontmatter:
  ```
  ---
  name: plan
  description: Creates implementation plans. Use when breaking down complex work into actionable steps.
  ---
  ```
- [x] Delete `node/skills/plan/` directory
- [x] Create `node/core/src/agents/agents.ts` — agent loading module:
  - `AgentInfo` type: `{ agentFile: AbsFilePath, name: string, description: string, systemPrompt: string, systemReminder?: string, fastModel?: boolean }`
  - `AgentsMap` type: `{ [agentName: string]: AgentInfo }`
  - `loadAgents(context)` function — discovers `.md` files from `agentsPaths` directories (flat files, not subdirectories like skills)
  - `parseAgentFile(filePath)` — extracts frontmatter (`name`, `description`, `fastModel`), body (system prompt), and `<system_reminder>` block
  - `formatAgentsIntroduction(agents)` — generates text describing available custom agents for the spawn_subagents description
- [x] Add `agentsPaths: string[]` to `ProviderOptions` in `node/core/src/provider-options.ts`
- [x] Add `agentsPaths` to `node/options.ts` with defaults: `[BUILTIN_AGENTS_PATH, "~/.claude/agents", "~/.magenta/agents", ".claude/agents", ".magenta/agents"]` where `BUILTIN_AGENTS_PATH = path.join(coreDir, "agents")`
  - Follow the same pattern as `skillsPaths` for parsing and merging
- [x] Write unit tests for `parseAgentFile` and `loadAgents`
- [x] Iterate until tests pass

## Phase 2: Consolidate ThreadType

- [x] In `node/core/src/chat-types.ts`: Replace `subagent_default | subagent_fast | subagent_explore` with just `subagent`
- [x] Define `SubagentConfig` type (in a new file or in `chat-types.ts`):
  ```typescript
  type SubagentConfig = {
    agentName?: string;       // undefined = default subagent
    fastModel?: boolean;      // use fast model
    systemPrompt?: string;    // custom system prompt from agent file
    systemReminder?: string;  // custom system reminder from agent file
  };
  ```
- [x] Update `ThreadManager.spawnThread()` in `node/core/src/capabilities/thread-manager.ts` — replace `threadType: ThreadType` with `threadType: ThreadType` + optional `subagentConfig?: SubagentConfig`
- [x] Run type checker, fix all references to old `ThreadType` variants:
  - `node/core/src/tools/toolManager.ts` — `getToolSpecs()`: collapse `subagent_default|subagent_fast|subagent_explore` cases to `subagent`
  - `node/core/src/tools/tool-registry.ts` — no changes needed (already has a single `SUBAGENT_STATIC_TOOL_NAMES`)
  - `node/core/src/providers/system-prompt.ts` — `getBaseSystemPrompt()`: single `subagent` case that uses `SubagentConfig.systemPrompt` if provided, else `DEFAULT_SUBAGENT_SYSTEM_PROMPT`
  - `node/core/src/providers/system-reminders.ts` — `getSubsequentReminder()`: single `subagent` case that returns standard subagent reminder + appended custom reminder if provided
  - `node/core/src/tools/spawn-subagents.ts` — spawning logic: determine `SubagentConfig` from agent type
  - `node/chat/chat.ts` — `spawnThread()`: use `subagentConfig` to determine profile (fast model vs normal) instead of checking `threadType === "subagent_fast"`
  - `node/chat/thread.ts` — thread creation
  - `node/providers/system-prompt.ts` — root wrapper
  - Any test files referencing old thread types
- [x] Iterate on type errors until `npx tsgo -b` passes

## Phase 3: Thread creation accepts SubagentConfig

- [x] Update `ThreadCoreContext` to include optional `subagentConfig?: SubagentConfig`
- [x] Update `createSystemPrompt()` to accept optional `SubagentConfig` — when provided with a custom `systemPrompt`, use that instead of the default subagent prompt
- [x] Update `getSubsequentReminder()` to accept optional `SubagentConfig` — when provided with a custom `systemReminder`, append it to the standard subagent reminder
- [x] Update `ThreadCore` to pass `subagentConfig` through to system prompt creation and reminder generation
- [x] Update root `Thread` class to accept and forward `SubagentConfig`
- [x] Update `Chat.spawnThread()` to:
  - Accept `subagentConfig` in options
  - Use `subagentConfig.fastModel` to determine profile instead of checking thread type
  - Pass `subagentConfig` through to `createThreadWithContext()`
- [x] Iterate on type errors until `npx tsgo -b` passes

## Phase 4: Dynamic spawn_subagents tool spec

- [x] Change `spawn-subagents.ts` `spec` from a constant to a function `getSpec(agents: AgentsMap): ProviderToolSpec`
  - The description includes the static description template + a dynamically generated section listing each discovered agent with its name and description
  - The `agentType` enum in the JSON schema includes `"default"`, `"fast"`, `"docker"`, `"docker_unsupervised"`, plus each custom agent name
  - Keep `"explore"` as a valid agent type (it's just a built-in agent now)
- [x] Update `TOOL_SPEC_MAP` in `toolManager.ts` — since spawn_subagents spec is now dynamic, it can't be in the static map. Either:
  - Make `getToolSpecs()` accept an `AgentsMap` parameter and special-case spawn_subagents, or
  - Change the map to allow function-based specs
- [x] Update `getToolSpecs()` to call `loadAgents()` at spec generation time (this enables dynamic discovery without restart)
- [x] Update `spawn-subagents-description.md` to be a template (or replace with a function that generates the description string)
- [x] Update `execute()` in spawn-subagents to resolve agent names:
  - When `agentType` matches a discovered agent name, look up the agent definition
  - Build `SubagentConfig` from the agent definition (systemPrompt, systemReminder, fastModel)
  - Pass config through `threadManager.spawnThread()`
  - When `agentType` is `"default"` or `"fast"` or undefined, use the existing behavior with appropriate config
- [x] Update `validateInput()` to accept custom agent names (not just the hardcoded `ALL_AGENT_TYPES`)
- [x] Iterate on type errors until `npx tsgo -b` passes

## Phase 5: Clean up old explore/plan artifacts

- [x] Delete `node/core/src/providers/prompts/explore-subagent.md`
- [x] Delete stale copy at `node/providers/prompts/explore-subagent.md` (if it exists)
- [x] Remove `EXPLORE_SUBAGENT_SYSTEM_PROMPT` export from `node/core/src/providers/system-prompt.ts`
- [x] Remove re-export of `EXPLORE_SUBAGENT_SYSTEM_PROMPT` from `node/providers/system-prompt.ts`
- [x] Remove `AGENT_TYPES` from `node/core/src/providers/system-prompt.ts` (no longer needed as a static constant — agent types are dynamic now)
- [x] Update `node/core/src/index.ts` exports for anything removed
- [x] Remove references to `AGENT_TYPES` from `spawn-subagents.ts`
- [x] Run `npx tsgo -b` and fix any remaining type errors
- [x] Run `npx biome check .` and fix lint/format issues

## Phase 6: Tests

- [x] Write unit tests for agent file parsing (frontmatter, system_reminder extraction, fastModel)
- [x] Write unit tests for dynamic spec generation (verify custom agents appear in description and enum)
- [x] Write unit test for spawn_subagents with a custom agent type (verify SubagentConfig is constructed correctly)
- [x] Update existing spawn_subagents tests for the new types
- [x] Update any system-prompt tests that reference old thread types
- [x] Run full test suite `npx vitest run` and iterate until all pass
- [x] Run `npx tsgo -b` for final type check
- [x] Run `npx biome check .` for final lint check
