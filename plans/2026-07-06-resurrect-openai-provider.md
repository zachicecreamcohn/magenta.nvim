# Objective and Context

User request (verbatim):

> alright, can you come up with a plan to resurrect the openai provider?
>
> It's been commented out for a while, so I don't think it's compatible with the current provider/agent split. Look at how the anthropic one is implemented.

Motivating context: we want to run OpenAI-compatible models (GPT-5, and OpenAI-compatible endpoints such as OpenRouter, Z.ai, Fireworks, and Bedrock's `bedrock-mantle` gateway) through magenta so we can reach models like GLM-5.2 that are not served via the Anthropic Messages API. The current `openai` case in `getProvider` throws "Not implemented" and the old implementation (`node/providers/openai.ts`) is entirely commented out.

## Why the old code no longer fits

The old `OpenAIProvider` implements a **stateless streaming** interface: `sendMessage()`, `forceToolUse()`, and a stubbed `createThread()`, driving updates through an `onStreamEvent` callback. The current architecture replaced that with a **Provider factory + stateful Agent** split:

- `Provider` (provider-types.ts:196-206) exposes exactly two methods: `forceToolUse(options): ProviderToolUseRequest` and `createAgent(options: AgentOptions): Agent`.
- `Agent` (provider-types.ts:322-372) is a stateful, event-emitting conversation object. It owns the message history, drives streaming internally, and emits `didUpdate` / `stopped` / `error` (`AgentEvents`). `ThreadCore` subscribes to these events and orchestrates tool execution.

So the old `sendMessage(onStreamEvent)` shape is gone. The reusable part of the old file is its **message/tool translation** (`ProviderMessage[]` ↔ OpenAI Responses API input) and its **stream-event mapping** (OpenAI Responses stream events → `ProviderStreamEvent`). The new work is wrapping that translation in a stateful `OpenAIAgent`.

## Key types and files

- `node/core/src/providers/provider-types.ts` — `Provider`, `Agent`, `AgentOptions`, `AgentEvents`, `AgentState`, `AgentStatus`, `AgentStreamingBlock`, `ProviderStreamEvent` (note: this is `Anthropic.RawContentBlock*Event` shaped, plus optional `providerMetadata.openai.itemId`), `ProviderMessage`, `ProviderToolSpec`, `StopReason`, `Usage`.
- `node/core/src/providers/provider.ts` — `getProvider()` factory (switch on `profile.provider`); the `"openai"` case currently throws.
- `node/core/src/provider-options.ts` — `ProviderName` union (already includes `"openai"`) and `ProviderProfile` fields (`baseUrl`, `apiKeyEnvVar`, `reasoning`, etc.).
- `node/core/src/providers/anthropic.ts` — reference `Provider`: constructor `(logger, authUI, validateInput, anthropicAuth, options)`, `createStreamParameters()`, `forceToolUse()` (retry loop), `createAgent()`.
- `node/core/src/providers/anthropic-agent.ts` — reference `Agent`: `class AnthropicAgent extends Emitter<AgentEvents> implements Agent`. Owns `messages`, `status`, streaming block, an internal `update(Action)` state machine, retry/backoff, `clone()`, `abort()`, `truncateMessages()`.
- `node/core/src/emitter.ts` — `Emitter<Events>` base class.
- `node/providers/openai.ts` — the commented-out old implementation (root layer, wrong location, depends on `Nvim`). Source of reusable translation logic.
- `node/providers/openai.test.ts` — old tests, `describe.skip`'d, body commented out.

# Design

Rebuild the OpenAI provider **in the core layer** (`node/core/src/providers/openai.ts`), mirroring the Anthropic split. Core cannot depend on neovim, so the old `Nvim` constructor param must be dropped in favor of the standard core provider constructor signature.

Two classes:

1. **`OpenAIProvider implements Provider`**
   - Constructor matches the Anthropic shape used by `getProvider`: `(logger, validateInput, options: { baseUrl?, apiKeyEnvVar? })`. (No `authUI`/`anthropicAuth` — OpenAI uses a plain API key from `apiKeyEnvVar`, default `OPENAI_API_KEY`, with `baseUrl` overridable for OpenAI-compatible gateways.)
   - Owns the `OpenAI` SDK client and all the **pure translation helpers** ported from the old file: `makeOpenAICompatible`, `sanitizeSchemaForOpenAI`, `isReasoningModel`/`isGpt5`, `supportsWebSearch`, and `createStreamParameters` (ProviderMessage[] → `Responses.ResponseCreateParamsStreaming`).
   - `forceToolUse(options)`: port the old non-streaming `responses.create({ tool_choice: "required", stream: false })` logic, returning a `ProviderToolUseRequest` (`{ promise, abort, aborted }`) whose promise yields `{ toolRequest, stopReason, usage }`. Use core's `validateInput` (passed to the constructor) rather than importing it directly.
   - `createAgent(options: AgentOptions): Agent`: construct and return an `OpenAIAgent`, passing the shared client + translation helpers (or `this`) plus `AgentOptions`.

2. **`OpenAIAgent extends Emitter<AgentEvents> implements Agent`**
   - This is the bulk of the new work. It must satisfy the full `Agent` interface: `getState`, `getStreamingBlock`, `getNativeMessageIdx`, `appendUserMessage`, `toolResult`, `continueConversation`, `abort`, `abortToolUse`, `truncateMessages`, `clone`, plus `on`/`off` from `Emitter`.
   - Internal state parallels `AnthropicAgent`: a `ProviderMessage[]` history (OpenAI has no separate native message format we must retain the way Anthropic does — we can keep `ProviderMessage[]` as the single source of truth and translate to Responses input on each request), a `status: AgentStatus`, a current `AgentStreamingBlock`, and per-message `stopReason`/`usage`.
   - `continueConversation()`: build params via the provider's `createStreamParameters`, open the streaming `responses.create`, and consume events. For each OpenAI event, translate to a `ProviderStreamEvent` (reuse the old `sendMessage` switch: `output_item.added`, `output_text.delta`, `function_call_arguments.delta`, `reasoning_summary_*`, `output_item.done`, `response.completed`) and feed it into an internal `update()` state machine that mutates the streaming block / message history and emits `didUpdate`. On completion emit `stopped(stopReason, usage)`; on failure emit `error`.
   - The `providerMetadata.openai.itemId` plumbing is essential: OpenAI's Responses API requires echoing back `itemId`s for assistant text and reasoning blocks on subsequent turns. The old translation code already reads/writes these; the Agent must persist them on stored `ProviderMessage` content so `createStreamParameters` can reconstruct them.

## Reuse vs. reimplement

- **Reuse (port ~verbatim, minus `Nvim`):** all pure translation/streaming-mapping logic in the old `openai.ts`. This is provider-format code and is still correct against `ProviderStreamEvent`/`ProviderMessage`.
- **Reimplement:** the stateful lifecycle (`OpenAIAgent`). Study `AnthropicAgent`'s `update(Action)` state machine, `getState`, `clone`, `abort`, and `truncateMessages`. Much of that machinery (status transitions, streaming-block accumulation, emitting events) is provider-agnostic.

Consider extracting the provider-agnostic parts of `AnthropicAgent` into a shared base as a *later* refactor; for the first pass, implement `OpenAIAgent` directly (even with some duplication) to keep the change reviewable and avoid destabilizing the Anthropic path.

## Wiring

- In `getProvider()` (provider.ts), replace the `"openai"` throw with construction of `OpenAIProvider`. Keep the lazy-cache keyed on `profile.name`.
- `ProviderName` already includes `"openai"`, so no options-schema change is strictly required; confirm `ProviderProfile.reasoning` fields line up with what `AgentOptions.reasoning` passes through.
- Move/replace the old files: new implementation lives at `node/core/src/providers/openai.ts`; delete or empty the root-layer `node/providers/openai.ts` stub. New tests live alongside in core.

Invariants:
- Core layer must not import anything neovim-specific (no `Nvim`, no root `node/` imports). The `tsgo -b` project-reference build enforces this.
- `itemId` round-tripping must be preserved: any assistant text/reasoning block stored in history must retain its `providerMetadata.openai.itemId`, or OpenAI will reject the follow-up request.
- `forceToolUse` and `createAgent` must be total over the `Agent`/`Provider` contracts — every interface method implemented, `assertUnreachable` used on exhaustive switches.
- Reasoning config only applies to reasoning-capable models (`isReasoningModel`); non-reasoning models must not receive a `reasoning` param.
- Aborting a stream must reject/settle the in-flight promise and leave `status` in a consistent stopped/aborted state, matching `AnthropicAgent.abort()` semantics.

# Stages

## Stage 1 — Port the pure translation layer as `OpenAIProvider` (no Agent yet)

- Goal: `node/core/src/providers/openai.ts` exists with `OpenAIProvider` implementing the constructor + `createStreamParameters`, `forceToolUse`, and all schema/stream helpers, compiling against the current core types. `createAgent` may throw "not implemented" temporarily. `getProvider` still throws for `"openai"` (not wired yet).
- Verification:
  - Behavior: message/tool translation produces correct OpenAI Responses input, including reasoning-block aggregation and `itemId` placement.
  - Setup: port the relevant `createStreamParameters` unit tests from the old `openai.test.ts` (reasoning aggregation, reasoning ordering, error cases for missing/duplicate `itemId`), using a mocked `OpenAI` client — no `Nvim`/`withNvimClient`.
  - Actions: call `createStreamParameters(...)` with crafted `ProviderMessage[]`.
  - Expected outcome: `params.input` matches expected system/user/assistant/reasoning ordering and reasoning summaries, as in the old tests.
- Before moving on: `npx tsgo -b`, `npx vitest run node/core/`, and `npx biome check .` all pass.

## Stage 2 — Implement `OpenAIAgent` (stateful lifecycle)

- Goal: `OpenAIAgent extends Emitter<AgentEvents> implements Agent`, with full streaming via `continueConversation`, event mapping into an internal state machine, and all `Agent` methods (`getState`, `getStreamingBlock`, `getNativeMessageIdx`, `appendUserMessage`, `toolResult`, `abort`, `abortToolUse`, `truncateMessages`, `clone`). `OpenAIProvider.createAgent` returns it.
- Verification:
  - Behavior: streaming a model turn emits the correct sequence of `didUpdate` events and a terminal `stopped(stopReason, usage)`; tool calls surface as `tool_use` blocks and a `tool_use` stop reason.
  - Setup: mocked `OpenAI` client yielding a scripted Responses event stream (adapt the old `mockStreamEvents` fixtures for reasoning, text, and function-call streams).
  - Actions: `createAgent(...)`, `appendUserMessage(...)`, subscribe to events, `continueConversation()`, await terminal event.
  - Expected outcome: accumulated `getState().messages` and streaming block match the scripted stream; `itemId`s are retained on stored blocks; a follow-up `continueConversation` round-trips them without error.
  - Behavior (abort): aborting mid-stream settles the request and leaves a consistent stopped/aborted state.
  - Behavior (clone): `clone()` returns a stopped deep copy with history preserved and no in-flight block.
- Before moving on: `npx tsgo -b`, `npx vitest run node/core/`, and `npx biome check .` all pass.

## Stage 3 — Wire into `getProvider` and clean up old stubs

- Goal: `getProvider` constructs `OpenAIProvider` for the `"openai"` case; the commented-out root-layer `node/providers/openai.ts` and skipped `openai.test.ts` are removed (or the root file reduced to nothing). An OpenAI-compatible profile can drive a real thread end-to-end.
- Verification:
  - Behavior: selecting an `openai` profile yields a working provider from `getProvider` (cached per `profile.name`), and a thread-level integration test can run a mocked OpenAI turn through `ThreadCore`.
  - Setup: an `openai` `ProviderProfile` fixture with `baseUrl`/`apiKeyEnvVar`; mocked OpenAI client.
  - Actions: `getProvider(...)` with the profile, run a scripted turn.
  - Expected outcome: provider instance is an `OpenAIProvider`; switching between two `openai` profiles with different `baseUrl`s yields distinct instances with the right base URL (port the old baseUrl-switching test); the mocked turn completes and produces expected agent state.
- Before moving on: `npx tsgo -b`, full `npx vitest run`, and `npx biome check .` all pass.

# Notes / Open Questions

- **Protocol reality check (GLM-5.2):** GLM-5.2 does NOT speak the OpenAI Responses API — the surface the old implementation and this plan target. It speaks (a) OpenAI **Chat Completions** (Z.ai `https://api.z.ai/api/paas/v4/chat/completions`, plus OpenRouter/Together/Fireworks/Bedrock `bedrock-mantle`), and (b) the **Anthropic Messages API** (Z.ai `https://api.z.ai/api/anthropic`). Consequences:
  - Resurrecting the Responses-based provider (Stages 1–3 above) only unlocks OpenAI's own GPT-5, NOT GLM-5.2.
  - To reach GLM-5.2 via OpenAI compatibility we'd need a **Chat Completions** provider (different streaming event shapes; thinking via `reasoning_content` replay with `thinking: { type: "enabled", clear_thinking: false }`; `reasoning_effort` param). This is a distinct translation layer from Responses and would be a separate provider/agent (or a mode within the OpenAI provider).
  - **Fastest path to GLM-5.2:** point the existing `AnthropicProvider` at an Anthropic-compatible base URL (Z.ai `/api/anthropic`). This may work today with little/no new code — worth a spike before committing to the Chat Completions build.
- Decision to make before implementing: is the goal (i) GPT-5 support (→ Responses provider, this plan), (ii) GLM-5.2 via OpenAI compat (→ new Chat Completions provider, re-scope needed), or (iii) GLM-5.2 quickly (→ Anthropic-endpoint spike, possibly no OpenAI work at all)?
- Web search: the old code enabled `web_search_preview` for supported OpenAI models. Keep it behind the same `supportsWebSearch` gate; it should be disabled for custom `baseUrl` gateways (mirroring how the Anthropic provider disables web search when a custom base URL is set).
- Consider a later refactor to extract a provider-agnostic `BaseAgent` from the shared parts of `AnthropicAgent`/`OpenAIAgent`, once both exist and the common surface is clear.
