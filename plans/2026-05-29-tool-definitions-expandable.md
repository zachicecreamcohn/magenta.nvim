# Objective and Context

User request (verbatim):

> right now we show an expandable System Prompt, but not the tool definitions. We should add an expandable Tool definitions section where we pretty-print all of the tool specs that we send to the agent. I'd like to pretty-print them in a way where the descriptions for all the parts of the schema are written out in text, rather than stringified as part of JSON output (so newlines show up properly)

We want to add a new collapsible section to the thread view, analogous to the existing "System Prompt" section, that displays the tool specs that get sent to the agent. The key requirement is *readable* pretty-printing: every \`description\` field in a tool spec (the top-level tool description and the per-property descriptions in the JSON schema) must be rendered as wrapped plain text with real newlines, not as escaped JSON string literals.

Key entities:

- \`ProviderToolSpec\` (\`node/core/src/providers/provider-types.ts\`) — \`{ name, description, input_schema }\` where \`input_schema\` is a \`JSONSchemaType\` (from \`openai/lib/jsonschema.mjs\`).
- \`getToolSpecs(...)\` (\`node/core/src/tools/toolManager.ts\`) — pure function that produces \`ProviderToolSpec[]\` from thread type, mcp manager, capabilities, agents, subagent config. This is the exact list passed to \`provider.createAgent({ tools })\` in \`ThreadCore.createFreshAgent\` (\`thread-core.ts\` ~line 439).
- \`renderSystemPrompt\` (\`node/chat/thread-view.ts\` ~line 155) — the existing collapsible section we mirror.
- \`Thread.state.showSystemPrompt\` + the \`toggle-system-prompt\` \`Msg\` (\`node/chat/thread.ts\`) — the existing toggle state/message we mirror.

Relevant files:

- \`node/core/src/tools/toolManager.ts\` — source of the tool specs; add an accessor so the view can get the same list.
- \`node/core/src/thread-core.ts\` — exposes a method/getter returning the current tool specs (reusing the same args it already passes to \`getToolSpecs\`).
- \`node/chat/thread.ts\` — add \`showToolDefinitions\` state + \`toggle-tool-definitions\` Msg + update handler.
- \`node/chat/thread-view.ts\` — add \`renderToolDefinitions\` helper and place it next to \`systemPromptView\`.
- New helper module for the pretty-printer (core, no nvim dep), e.g. \`node/core/src/tools/format-tool-spec.ts\`, so it can be unit-tested without neovim.

# Design

## Getting the specs to the view

\`ThreadCore.createFreshAgent\` already calls \`getToolSpecs(this.state.threadType, this.context.mcpToolManager, this.context.availableCapabilities, this.context.getAgents(), this.context.subagentConfig)\`. Add a small public method on \`ThreadCore\` (e.g. \`getToolSpecs(): ProviderToolSpec[]\`) that calls the same function with the same arguments, and have \`createFreshAgent\` use it too (single source of truth). The view reaches it via \`thread.core.getToolSpecs()\`.

This avoids storing a duplicate copy in state; the spec list is cheap to recompute and only computed when the section renders.

## Pretty-printing (the core of the task)

Write a pure formatter \`formatToolSpecs(specs: ProviderToolSpec[]): string\` (and a per-spec helper). The goal: descriptions appear as wrapped text with real newlines, schema structure appears as readable indented text — NOT \`JSON.stringify\` (which would escape \`\\n\` inside descriptions).

For each tool render something like:

\`\`\`
## <name>

<description text, verbatim with real newlines>

Parameters:
  <propName> (<type>)<", required" if in required[]>:
    <property description text, real newlines, indented>
    <nested object/array properties recursively indented>
\`\`\`

Design notes:

- Walk the JSON schema manually rather than stringifying. Handle the common \`JSONSchemaType\` shapes we actually emit: \`type: "object"\` with \`properties\`/\`required\`, \`type: "array"\` with \`items\`, scalars (\`string\`/\`number\`/\`boolean\`), \`enum\`, and \`anyOf\`/\`oneOf\`. For each node print its \`type\` (or enum/anyOf summary) and, on its own indented lines, its \`description\` with newlines preserved.
- For any schema shape not explicitly handled, fall back to a JSON dump of just that node so we never lose information — but descriptions on handled nodes must always be text.
- \`JSONSchemaType\` is loosely typed; the walker will need to read fields like \`.properties\`, \`.items\`, \`.required\`, \`.enum\` defensively. Do this with narrow, well-typed local guard helpers — do NOT introduce \`any\` (per project rules); use \`unknown\` + type guards.
- Indentation for description lines: split on \`\\n\` and re-indent each line so multi-line descriptions stay aligned.

## View / state wiring

Mirror the System Prompt section exactly:

- \`Thread.state\`: add \`showToolDefinitions: boolean\` (init \`false\`).
- \`Msg\`: add \`{ type: "toggle-tool-definitions" }\`; handle it in \`myUpdate\` by flipping the flag (next to the \`toggle-system-prompt\` case).
- \`thread-view.ts\`: add \`renderToolDefinitions(specs, show, dispatch)\` modeled on \`renderSystemPrompt\`. Collapsed: \`🔧 [Tool Definitions (N)]\`. Expanded: header + the formatted text, all \`@comment\` highlighted, bound to \`"="\` → \`dispatch({ type: "toggle-tool-definitions" })\`. Render it right after \`systemPromptView\` in both the empty-thread branch and the main view.

Invariants:

- The specs shown must be exactly those sent to the agent — both \`createFreshAgent\` and the view go through the single \`ThreadCore.getToolSpecs()\` accessor.
- No \`description\` field is ever rendered as an escaped JSON string; newlines render as real line breaks.
- No new \`any\` types introduced.
- The formatter is pure and nvim-independent so it lives in \`node/core\` and is unit-testable there.

# Stages

## Stage 1: Pretty-printer in core

- Goal: \`formatToolSpecs\` exists in \`node/core/src/tools/format-tool-spec.ts\` and turns \`ProviderToolSpec[]\` into readable text with real newlines in all descriptions.
- Verification (unit test in \`node/core\`):
  - Behavior: descriptions with embedded \`\\n\` render as real newlines, not \`\\\\n\`.
  - Setup: a hand-built \`ProviderToolSpec\` with a multi-line top-level description and an object schema whose properties have multi-line descriptions, a required prop, an enum, and a nested object/array.
  - Actions: call \`formatToolSpecs([spec])\`.
  - Expected outcome: output contains the literal newline-separated description lines, property names with types, the \`required\` marker, enum values, and indented nested props; output contains no \`\\\\n\` escape sequences.
- Before moving on: \`npx vitest run node/core/\`, \`npx tsgo -b\`, \`npx biome check .\` pass.

## Stage 2: Expose specs from ThreadCore

- Goal: \`ThreadCore.getToolSpecs()\` returns the spec list, and \`createFreshAgent\` uses it.
- Verification: existing thread-core tests still pass (the agent still receives the same tools); optionally assert the accessor returns a non-empty list for a normal thread.
- Before moving on: type checks + tests pass.

## Stage 3: View + toggle wiring

- Goal: a collapsible "Tool Definitions" section appears under the System Prompt and toggles with \`=\`.
- Verification (integration test via \`withDriver\`, mirroring existing system-prompt view tests):
  - Behavior: the collapsed \`🔧 [Tool Definitions ...]\` line appears; pressing \`=\` on it expands to show formatted specs; pressing again collapses.
  - Setup: open a thread in the sidebar.
  - Actions: assert collapsed text present, trigger the binding, assert an expanded tool name/description line appears.
  - Expected outcome: expanded content shows real wrapped descriptions; toggling collapses again.
- Before moving on: full test suite, \`npx tsgo -b\`, \`npx biome check .\` pass.
