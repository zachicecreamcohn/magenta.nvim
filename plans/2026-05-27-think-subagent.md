# context

Add a new `think` subagent (peer to `explore`, `bash_summarizer`, etc.) that runs in an isolated thread with maximum thinking effort. The parent main agent invokes it via the existing `spawn_subagents` tool when the user asks for deep reasoning. Keeping deep thinking in an isolated subagent thread preserves the main thread's prompt cache (which would otherwise be invalidated by changes to thinking parameters).

Key facts established in conversation:

- Anthropic invalidates the messages cache when `budget_tokens` / thinking params change between requests (system + tools stay cached). A per-turn effort flip on the main thread is therefore expensive on long threads.
- Amp's "oracle" pattern shows that an isolated subagent with its own context + reasoning model keeps the main thread cache intact; only a distilled summary returns.
- We are not exposing this as a slash-command or keyword. It is a normal agent type discovered through the existing agents loader.
- We are not adding main-agent prompt guidance; the user explicitly tells the main agent "use the think subagent to figure out X".
- We do not currently restrict tooling per agent type, so the `think` agent gets the same tools as `subagent`/`explore`. Its prompt will steer it toward analysis rather than edits.
- Provider/model: same as the active profile. We only override `thinking.effort = "max"`.

Relevant files and entities:

- `node/core/src/agents/agents.ts` — loader for `*.md` agents with YAML frontmatter. Defines `AgentInfo` and `AgentFrontmatter`. We need to add an `effort` field here.
- `node/core/src/agents/explore.md` / `bash_summarizer.md` — reference shape for the new `think.md`.
- `node/core/src/chat-types.ts` — `SubagentConfig` struct that flows from agent definition → spawn-subagents → thread context. We add `effort` to it.
- `node/core/src/tools/spawn-subagents.ts` — `resolveSubagentConfig` copies fields from `AgentInfo` into `SubagentConfig`. We add `effort` to this copy.
- `node/core/src/thread-core.ts` — `createFreshAgent` builds the provider agent params; reads `this.context.profile.thinking`. We override `thinking.effort` from `subagentConfig.effort` when present.
- `node/core/src/provider-options.ts` — defines the `effort` enum (`"low" | "medium" | "high" | "xhigh" | "max"`). Reuse this type.
- `node/core/src/providers/anthropic-agent.ts` — already maps `effort` through `effortToBudgetTokens` / adaptive thinking output_config. No change needed here.
- `node/core/src/agents/agents.test.ts` — frontmatter parsing tests. Add a case for `effort`.
- `node/core/src/tools/spawn-subagents.test.ts` — verifies AgentInfo → SubagentConfig copy. Add a case for `effort`.

Key types added/changed:

- `AgentInfo` gains `effort?: "low" | "medium" | "high" | "xhigh" | "max"`.
- `AgentFrontmatter` gains the same `effort?` field.
- `SubagentConfig` gains the same `effort?` field.

# implementation

- [ ] Plumb an `effort` field through agent loading
  - Edit `node/core/src/agents/agents.ts`:
    - Add `effort?: "low" | "medium" | "high" | "xhigh" | "max"` to `AgentInfo` and `AgentFrontmatter`.
    - In `extractAgentFrontmatter`, parse the `effort` key and validate it against the allowed set.
    - In `parseAgentFile`, pass `effort: frontmatter.effort` into the returned `AgentInfo`.
  - Edit `node/core/src/chat-types.ts`: add `effort?: ...` to `SubagentConfig` (reuse the enum literal — or import a shared type).
  - Edit `node/core/src/tools/spawn-subagents.ts` `resolveSubagentConfig`: copy `effort: agentDef.effort` into the returned `SubagentConfig`.
  - Run `npx tsgo -b` and fix any reference fallout (mock `SubagentConfig` literals in tests will need the new field allowed via `?`).
  - Unit test for the loader:
    - Behavior: agents.ts parses `effort: max` from frontmatter into `AgentInfo.effort`
    - Setup: create a tmp agent file with `effort: max` in frontmatter (mirror existing `fastModel` tests in `agents.test.ts`)
    - Actions: call `parseAgentFile`
    - Expected output: returned `AgentInfo.effort === "max"`
    - Assertions: also verify that an invalid `effort` value is dropped (left undefined)
  - Unit test for spawn-subagents config resolution:
    - Behavior: `resolveSubagentConfig` propagates `effort` from `AgentInfo` to `SubagentConfig`
    - Setup: build an `AgentsMap` with an agent that has `effort: "max"`
    - Actions: call `resolveSubagentConfig({agentType: "think"}, agents)`
    - Expected output: returned config has `effort: "max"`
    - Assertions: also verify undefined effort case passes through as undefined

- [ ] Apply subagent `effort` override when creating the provider agent
  - Edit `node/core/src/thread-core.ts` `createFreshAgent`:
    - If `this.context.subagentConfig?.effort` is set and the profile has `thinking` configured, build the `thinking` arg as `{ ...profile.thinking, effort: subagentConfig.effort }`.
    - If `thinking` is not enabled on the profile, we still want max thinking on the think subagent — decide: either force-enable thinking when an `effort` override is present (preferred, since the agent definition expressed intent), or skip silently. Recommendation: force-enable `{ enabled: true, effort: subagentConfig.effort, displayThinking: profile.thinking?.displayThinking }` only for anthropic/bedrock/mock providers. For non-anthropic providers we currently have no way to override reasoning per-subagent — log a warning and ignore.
  - Type-check with `npx tsgo -b`.
  - Unit test:
    - Behavior: when subagentConfig has `effort: max`, the created Agent receives thinking with `effort: "max"`
    - Setup: instantiate a `ThreadCore` with a mock provider profile (anthropic, thinking enabled), pass `subagentConfig: { effort: "max" }` in context
    - Actions: trigger creation of a fresh agent (e.g. call the relevant ThreadCore entry point, or call `createFreshAgent` indirectly via a public method per existing patterns in `thread-core.test.ts`)
    - Expected output: the mock provider's `createAgent` was called with `thinking.effort === "max"`
    - Assertions: spy on `provider.createAgent` calls

- [ ] Create the `think` agent definition
  - Add `node/core/src/agents/think.md` with frontmatter:
    - `name: think`
    - `description`: short hint about deep reasoning on architecture, debugging, design tradeoffs; only invoke when the user asks for deep analysis or for complex problems where multiple approaches must be weighed.
    - `tier: leaf`
    - `effort: max`
    - (no `fastModel` flag; use main model)
  - Body content (the system prompt for the think subagent):
    - Frame the role: "deep-reasoning subagent for architecture, debugging, tradeoff analysis"
    - Encourage exploration: it can use `get_file`, `rg`, `fd`, `hover`, `find_references`, `bash_command` to verify assumptions. It should not edit files.
    - Encourage considering edge cases, alternative designs, and failure modes.
    - Output guidance: deliver key insights, recommendations, and tradeoffs in the final `yield_to_parent` message — not a verbatim dump of explored code. Parent has access to the codebase and only sees the yield.
  - Verify the loader picks it up: run a quick existence-style unit test or rely on the new effort-loading tests above.

- [ ] Verify end-to-end via existing test infrastructure
  - Run `npx vitest run node/core/src/agents/ node/core/src/tools/spawn-subagents.test.ts node/core/src/thread-core.test.ts` and iterate until green.
  - Run `npx tsgo -b` and `npx biome check .` for final cleanliness.

# Notes / open questions

- We should decide whether `effort` on the agent definition should also override the profile thinking when the profile has thinking *disabled*. Decision proposed above: force-enable for supported providers, warn otherwise. Confirm with user before implementing the override branch.
- We are not changing main-agent prompts. If the user finds they often need to nudge the main agent toward the think subagent, we can later add a sentence to the default system prompt or to `formatAgentsIntroduction`.
- Cache behavior: spawning a subagent creates a separate thread with its own request prefix, so changing `effort` on the subagent does not affect the parent thread's cache. This is the whole point of the design.
