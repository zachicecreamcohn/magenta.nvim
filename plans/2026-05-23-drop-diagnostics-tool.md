# context

The goal is to drop the `diagnostics` agent tool — the LSP-backed tool that
the agent could call to fetch workspace diagnostics. The `@diag` / `@diagnostics`
chat keywords (which let the user forward their current diagnostics to the agent
as context) must continue to work unchanged.

The agent tool wiring touches the core tool registry, the `DiagnosticsProvider`
capability, the environment wiring (both local and docker), the render layer,
and several tests. The chat command path (in `node/chat/commands/diagnostics.ts`)
uses `getDiagnostics` from `node/utils/diagnostics.ts` directly — it does **not**
go through `DiagnosticsProvider`, so the keyword path is independent of the
tool path we are deleting.

## Relevant files

Tool implementation (delete):
- `node/core/src/tools/diagnostics.ts` — tool execute/spec/validateInput
- `node/core/src/tools/diagnostics.test.ts` — unit tests for the tool
- `node/core/src/capabilities/diagnostics-provider.ts` — capability interface
- `node/capabilities/noop-diagnostics-provider.ts` — docker noop impl
- `node/render-tools/diagnostics.ts` — TUI rendering for tool calls/results
- `node/tools/diagnostics.test.ts` — end-to-end driver test for the tool

Tool wiring (edit):
- `node/core/src/tools/tool-registry.ts` — `STATIC_TOOL_NAMES`,
  `CHAT_STATIC_TOOL_NAMES`, `SUBAGENT_STATIC_TOOL_NAMES`, `TOOL_CAPABILITIES`,
  `TOOL_REQUIRED_CAPABILITIES`
- `node/core/src/tools/toolManager.ts` — `StaticToolMap`, `TOOL_SPEC_MAP`,
  imports
- `node/core/src/tools/create-tool.ts` — switch case, `diagnosticsProvider`
  in `CreateToolContext`
- `node/core/src/tools/helpers.ts` — `validateInput` switch case
- `node/core/src/tool-types.ts` — `ToolStructuredResult` union
- `node/core/src/index.ts` — public re-exports of `Diagnostics` and
  `DiagnosticsProvider`
- `node/core/src/compaction-manager.ts` — `CompactionManagerContext`,
  `createTool` call site
- `node/core/src/thread-core.ts` — `ThreadCoreContext`, `createTool` and
  `CompactionManager` construction sites
- `node/environment.ts` — `Environment` interface, `createLocalEnvironment`,
  `createDockerEnvironment`, `availableCapabilities`
- `node/chat/thread.ts` — `ThreadCoreContext` construction (two places)
- `node/render-tools/index.ts` — `renderToolSummary`, `renderToolResultSummary`
  switches, import
- `node/render-tools/streaming.ts` — `renderStreamdedTool` switch arm

Tests to update:
- `node/core/src/thread-core.test.ts` — drop `diagnosticsProvider` from the
  mock `ThreadCoreContext`
- `node/core/src/tools/toolManager.test.ts` — drop diagnostics-related
  assertions/test
- `node/core/src/tools/docker-toolspecs.test.ts` — drop "diagnostics" from
  capability set type + assertions
- `node/capabilities/docker-environment.test.ts` — drop diagnostics
  capability/tool assertions

Tests to keep (verify they still pass):
- `node/chat/commands/registry.test.ts` — exercises `@diag` keyword
- `node/chat/thread.test.ts` — exercises `@diag` / `@diagnostics` keywords
- `node/test/completions.test.ts` — verifies `@diag` appears in completions

# implementation

- [ ] Remove the tool itself from the static registry.
  - Edit `node/core/src/tools/tool-registry.ts`:
    - Drop `"diagnostics"` from `STATIC_TOOL_NAMES`.
    - Drop `"diagnostics"` from `CHAT_STATIC_TOOL_NAMES` and
      `SUBAGENT_STATIC_TOOL_NAMES`.
    - Drop `"diagnostics"` from `TOOL_CAPABILITIES`.
    - Drop the `diagnostics:` entry from `TOOL_REQUIRED_CAPABILITIES`.

- [ ] Remove the tool from the manager / dispatcher / validator.
  - Edit `node/core/src/tools/toolManager.ts`: remove `Diagnostics` import,
    the `diagnostics:` entry in `StaticToolMap`, and the `diagnostics:` entry
    in `TOOL_SPEC_MAP`.
  - Edit `node/core/src/tools/create-tool.ts`: remove the `Diagnostics`
    import, `DiagnosticsProvider` import, the `diagnosticsProvider` field
    on `CreateToolContext`, and the `case "diagnostics":` switch arm.
  - Edit `node/core/src/tools/helpers.ts`: remove the `Diagnostics` import
    and the `case "diagnostics":` switch arm.
  - Edit `node/core/src/tool-types.ts`: remove the `Diagnostics` import and
    `Diagnostics.StructuredResult` from `ToolStructuredResult`.

- [ ] Remove the `DiagnosticsProvider` capability from contexts that only
      forward it to the tool.
  - Edit `node/core/src/compaction-manager.ts`: drop the
    `DiagnosticsProvider` import, the `diagnosticsProvider` field on
    `CompactionManagerContext`, and the `diagnosticsProvider:` line in the
    `createTool` context.
  - Edit `node/core/src/thread-core.ts`: drop the `DiagnosticsProvider`
    import, the `diagnosticsProvider` field on `ThreadCoreContext`, the
    `diagnosticsProvider:` line in the tool-use `createTool` context, and
    the `diagnosticsProvider:` line in the `CompactionManager` construction.
  - Edit `node/core/src/index.ts`: remove the
    `export type { DiagnosticsProvider } ...` and
    `export * as Diagnostics ...` lines.

- [ ] Remove the provider from the environment wiring.
  - Edit `node/environment.ts`:
    - Drop `DiagnosticsProvider` from the `@magenta/core` imports.
    - Drop the `NoopDiagnosticsProvider` import.
    - Drop the `diagnosticsProvider` field on `Environment`.
    - In `createLocalEnvironment`, drop the `diagnosticsProvider` local and
      its inclusion in the returned object, and drop `"diagnostics"` from
      `availableCapabilities`.
    - In `createDockerEnvironment`, drop the `diagnosticsProvider` local
      and its inclusion in the returned object.
  - Delete `node/capabilities/noop-diagnostics-provider.ts`.
  - Edit `node/chat/thread.ts`: drop the two `diagnosticsProvider:` lines
    inside `ThreadCoreContext` construction.

- [ ] Delete the tool source files.
  - Delete `node/core/src/tools/diagnostics.ts`.
  - Delete `node/core/src/tools/diagnostics.test.ts`.
  - Delete `node/core/src/capabilities/diagnostics-provider.ts`.
  - Delete `node/render-tools/diagnostics.ts`.
  - Delete `node/tools/diagnostics.test.ts`.

- [ ] Remove the tool from the render layer.
  - Edit `node/render-tools/index.ts`:
    - Drop the `DiagnosticsRender` import.
    - Remove the `case "diagnostics":` arms in `renderToolSummary` and
      `renderToolResultSummary`.
  - Edit `node/render-tools/streaming.ts`: remove `case "diagnostics":` from
    the fall-through list.

- [ ] Update tests that referenced the removed tool/capability.
  - Edit `node/core/src/thread-core.test.ts`: remove the
    `diagnosticsProvider: { ... }` block from the mock `ThreadCoreContext`.
  - Edit `node/core/src/tools/toolManager.test.ts`:
    - Drop `expect(names).toContain("diagnostics")` assertions.
    - Drop `expect(names).not.toContain("diagnostics")` assertions.
    - Drop `"diagnostics"` from the capability `Set` used in tests.
    - Drop the test that specifically exercises the diagnostics capability.
  - Edit `node/core/src/tools/docker-toolspecs.test.ts`:
    - Drop `"diagnostics"` from the `Set<...>` type.
    - Drop the `not.toContain("diagnostics")` assertion (and update the
      test name to mention only LSP).
  - Edit `node/capabilities/docker-environment.test.ts`:
    - Drop the `expect(env.availableCapabilities.has("diagnostics"))` line.
    - Drop the two `expect(toolNames).not.toContain("diagnostics")` lines
      (and update the test names to mention only LSP).

  - Testing:
    - Behavior: the agent tool registry no longer advertises a
      `diagnostics` tool.
    - Setup: call `getToolSpecs("root", noopMcpToolManager)`.
    - Actions: read the returned spec list.
    - Expected output: no spec with `name === "diagnostics"`.
    - Assertions: `expect(names).not.toContain("diagnostics")` in the
      registry test; existing thread/chat-keyword tests for `@diag` and
      `@diagnostics` still pass.

- [ ] Type-check and lint.
  - Run `npx tsgo -b` from the project root and resolve any errors.
  - Run `npx biome check --write .` to apply formatting/lint fixes.

- [ ] Run the test suite.
  - Run `TEST_MODE=sandbox npx vitest run` and ensure all suites pass,
    paying special attention to:
    - `node/chat/commands/registry.test.ts`
    - `node/chat/thread.test.ts` (`@diag` / `@diagnostics` keyword tests)
    - `node/test/completions.test.ts` (`@diag` completion)
    - `node/core/src/tools/toolManager.test.ts`
    - `node/core/src/tools/docker-toolspecs.test.ts`
    - `node/capabilities/docker-environment.test.ts`
