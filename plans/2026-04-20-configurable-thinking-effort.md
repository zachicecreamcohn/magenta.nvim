# Context

The goal is to make the Anthropic "thinking effort" configurable per profile, so a developer can explicitly pick an effort level (e.g. `"high"` or `"max"`) instead of relying on the API default.

Today, when a profile has `thinking.enabled = true` and the model supports adaptive thinking (Opus 4.7+, Sonnet 4.6+), `anthropic-agent.ts` passes only `{type: "adaptive", display: ...}`. Anthropic now exposes an `output_config.effort` parameter (values `"low" | "medium" | "high" | "xhigh" | "max"`) that lets callers steer how aggressively Claude thinks (and spends tokens on tool calls). We want to expose this via the profile.

## Relevant files and entities

- `node/core/src/provider-options.ts` — defines `ProviderProfile`, the provider-facing shape of a profile. Needs a new optional `effort` field inside `thinking` (Anthropic-only).
- `node/options.ts` — defines the root `Profile` type and the runtime validator that parses the lua-side profile table into `Profile`. Needs to accept and validate the new `effort` field.
- `node/core/src/providers/provider-types.ts` — defines `AgentOptions.thinking`. Needs the new `effort` field so it can be threaded from `ThreadCore` to the agent.
- `node/core/src/thread-core.ts` — `createFreshAgent` copies `profile.thinking` into `AgentOptions`. No structural change beyond passing the new field through (spread already does this).
- `node/core/src/providers/anthropic-agent.ts` — `createNativeStreamParameters` builds the Anthropic request. Needs to set `output_config.effort` on the stream params when `thinking.effort` is provided.
- `node/core/src/providers/anthropic.ts` — `createStreamParameters` and `forceToolUse` also build stream params. For consistency, `forceToolUse` and the legacy `createStreamParameters` path should also honor `thinking.effort` (though the latter is stale code; see below).
- `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts` — confirms the SDK exposes `OutputConfig.effort` with values `"low" | "medium" | "high" | "xhigh" | "max"` and that `MessageStreamParams` has an optional `output_config`.
- `doc/magenta-providers.txt` and `doc/magenta-config.txt` — user-facing help docs for the `thinking` block.
- `node/providers/anthropic-agent.test.ts` — existing unit tests for thinking-related behavior; new tests for effort go here.
- `node/sidebar.ts` — `thinkingStatus` string in the input buffer title. Optional: include effort level when it is set.

## Key type shape

New `thinking` shape (additive, fully backwards-compatible):

```ts
thinking?: {
  enabled: boolean;
  budgetTokens?: number;
  displayThinking?: boolean;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
};
```

Mapping to the Anthropic API:
- If `thinking.effort` is set AND the model supports adaptive thinking → include `output_config: { effort }` on the stream params.
- If `thinking.effort` is set AND the model does NOT support adaptive thinking → log a warning and ignore (older models use `budget_tokens` instead).
- If `thinking.effort` is not set → send no `output_config`, preserving today's behavior (API default, which is `"high"` for supported models).

# Implementation

- [x] extend the `thinking` type in `node/core/src/provider-options.ts` and `node/options.ts` to include an optional `effort` field with values `"low" | "medium" | "high" | "xhigh" | "max"`
  - mirror the same field in `AgentOptions.thinking` in `node/core/src/providers/provider-types.ts`
  - run `npx tsgo -b` and fix any type errors

- [x] update the runtime validator in `node/options.ts` (the `"thinking" in p` block around line 351) to accept and validate the `effort` string
  - accept only the five literal values listed above; otherwise `logger.warn` and drop the field
  - write a unit test for the validator
    - Behavior: parsing a profile with `thinking.effort = "max"` yields `Profile.thinking.effort === "max"`
    - Setup: construct a raw profile object with `thinking = { enabled = true, effort = "max" }`
    - Actions: call the profiles parser
    - Expected output: `out.thinking.effort` is `"max"`; no warnings logged
    - Assertions: `expect(profile.thinking?.effort).toBe("max")`; also verify an invalid value (e.g. `"turbo"`) produces a warning and `effort` is undefined

- [x] update `createNativeStreamParameters` in `node/core/src/providers/anthropic-agent.ts` to set `output_config.effort` when `thinking.effort` is provided
  - only apply when `supportsAdaptiveThinking(model)` is true; otherwise `logger.warn` once and skip
  - write a unit test
    - Behavior: when `thinking.effort = "max"` is set on an adaptive-thinking model, the outgoing stream params include `output_config: { effort: "max" }`
    - Setup: create an `AnthropicAgent` with `model = "claude-opus-4-7"`, `thinking = { enabled: true, effort: "max" }`, using the existing mock Anthropic client
    - Actions: trigger a single user message and inspect the captured stream params
    - Expected output: `params.output_config.effort === "max"` and `params.thinking.type === "adaptive"`
    - Assertions: `expect(capturedStreamParams.output_config?.effort).toBe("max")`

- [x] for non-adaptive models, assert effort is ignored and a warning is logged
  - Behavior: on `claude-sonnet-4-5` (no adaptive support), `thinking.effort` is dropped
  - Setup: same as above but with an older model
  - Expected output: `capturedStreamParams.output_config` is undefined; one warning in the logger
  - Assertions: `expect(capturedStreamParams.output_config).toBeUndefined()` and verify warn was called

- [x] apply the same logic in `forceToolUse` in `node/core/src/providers/anthropic.ts` so single-call tool requests honor the same effort setting
  - extract the effort-resolution into a small helper (e.g. `resolveOutputConfig(model, thinking)`) to avoid duplication between `anthropic-agent.ts` and `anthropic.ts`
  - the legacy `createStreamParameters` in `anthropic.ts` is only kept for reference — skip if it's unused; otherwise update it too and run `npx tsgo -b` to confirm nothing else depends on the old shape

- [x] optional polish: surface the effort level in the sidebar title in `node/sidebar.ts`
  - e.g. `"Magenta Input (<profile> thinking:max)"` when `thinking.effort` is set
  - no new test required; the existing sidebar-title test (if any) can be extended

- [x] update documentation
  - `doc/magenta-providers.txt`: add a new subsection showing `effort = "max"` alongside the existing adaptive-thinking example; add `effort` to the configuration options list with its allowed values and note that it maps to Anthropic's `output_config.effort`
  - `doc/magenta-config.txt`: add a one-line pointer to the new option under the thinking example, deferring full detail to `magenta-providers.txt`
  - mention that `effort` applies only to adaptive-thinking models (Opus 4.7+, Sonnet 4.6+) and is ignored elsewhere with a warning
  - cross-reference the Anthropic docs page (`https://platform.claude.com/docs/en/build-with-claude/effort`)

- [x] run `TEST_MODE=sandbox npx vitest run node/providers/anthropic-agent.test.ts node/options.test.ts` and iterate until green
- [x] run `npx tsgo -b` and `npx biome check .` and fix any issues
