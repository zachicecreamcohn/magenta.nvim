# context

## Objective

Replace three subagent tools (`spawn_subagent`, `spawn_foreach`, `wait_for_subagents`) with a single unified tool called `spawn_subagents` (plural). The new tool:

- Always takes an array of subagent specs
- Always blocks until all subagents complete
- Supports shared prompt/contextFiles (applied to all) and per-agent prompt/contextFiles
- Each subagent can independently specify agentType, prompt, contextFiles, branch
- No more non-blocking mode or `wait_for_subagents`

## New tool schema

```typescript
// The unified input
type Input = {
  subagents: SubagentSpec[];
  sharedPrompt?: string; // prepended to each subagent's prompt
  sharedContextFiles?: UnresolvedFilePath[]; // merged with each subagent's contextFiles
};

type SubagentSpec = {
  prompt: string;
  contextFiles?: UnresolvedFilePath[];
  agentType?: AgentType | "docker" | "docker_unsupervised";
  branch?: string; // required for docker types
};

// Progress tracks each subagent individually (like spawn_foreach)
type SpawnSubagentsProgress = {
  subagents: Array<{
    index: number;
    prompt: string; // truncated for display
    state: SubagentState;
  }>;
};

type SubagentState =
  | { status: "pending" }
  | { status: "provisioning"; message: string }
  | { status: "running"; threadId: ThreadId }
  | { status: "completed"; threadId?: ThreadId; result: Result<string> };

type SubagentStructuredResult =
  | { status: "ok"; threadId: ThreadId; responseBody: string }
  | { status: "error"; threadId?: ThreadId; error: string };

type StructuredResult = {
  toolName: "spawn_subagents";
  subagents: Array<{
    index: number;
    result: SubagentStructuredResult;
  }>;
};
```

## Relevant files and entities

### Core tool definitions (to replace)

- `node/core/src/tools/spawn-subagent.ts` — current single-subagent tool (execute, spec, Input, validateInput, StructuredResult, SpawnSubagentProgress)
- `node/core/src/tools/spawn-foreach.ts` — current foreach tool (execute, spec, Input, validateInput, StructuredResult, SpawnForeachProgress, ForEachElement)
- `node/core/src/tools/wait-for-subagents.ts` — current wait tool (execute, spec, Input, validateInput, StructuredResult, WaitForSubagentsProgress)
- `node/core/src/tools/spawn-subagent-description.md` — tool description for LLM

### Registration/wiring

- `node/core/src/tools/tool-registry.ts` — STATIC_TOOL_NAMES, CHAT_STATIC_TOOL_NAMES, etc., TOOL_REQUIRED_CAPABILITIES
- `node/core/src/tools/toolManager.ts` — StaticToolMap, TOOL_SPEC_MAP, imports
- `node/core/src/tools/create-tool.ts` — createTool switch cases
- `node/core/src/tool-types.ts` — ToolStructuredResult union
- `node/core/src/index.ts` — namespace re-exports

### Rendering (root layer)

- `node/render-tools/spawn-subagent.ts` — render functions for spawn_subagent
- `node/render-tools/spawn-foreach.ts` — render functions for spawn_foreach
- `node/render-tools/wait-for-subagents.ts` — render functions for wait_for_subagents
- `node/render-tools/index.ts` — switch-case dispatch for all render functions
- `node/render-tools/streaming.ts` — streaming display switch cases

### Tests

- `node/core/src/tools/spawn-subagent.test.ts` — unit tests for spawn_subagent
- `node/core/src/tools/spawn-foreach.test.ts` — unit tests for spawn_foreach
- `node/core/src/tools/wait-for-subagents.test.ts` — unit tests for wait_for_subagents
- `node/tools/spawn-subagent.test.ts` — integration tests
- `node/tools/spawn-foreach.test.ts` — integration tests
- `node/tools/wait-for-subagents.test.ts` — integration tests

### Capabilities

- `node/core/src/capabilities/thread-manager.ts` — ThreadManager interface (spawnThread, waitForThread, yieldResult)
- `node/core/src/providers/system-prompt.ts` — AGENT_TYPES, AgentType

# implementation

- [ ] **Create the new `spawn_subagents` tool**
  - [ ] Create `node/core/src/tools/spawn-subagents.ts` with the unified types (Input, SubagentSpec, SpawnSubagentsProgress, StructuredResult, ToolRequest)
  - [ ] Implement `validateInput()` — validate subagents array, sharedPrompt, sharedContextFiles, per-agent fields
  - [ ] Implement `execute()`:
    - Merge sharedPrompt (prepend) and sharedContextFiles (concat) into each subagent's effective prompt/contextFiles
    - Use slot-based concurrency (like spawn-foreach) with `maxConcurrentSubagents`
    - Support docker provisioning for individual subagents (like spawn-subagent docker path)
    - Track progress per-subagent with the new SubagentState type
    - Always block — wait for all subagents to complete, then build result
  - [ ] Write the `spec` with input_schema matching the new schema
  - [ ] Create `node/core/src/tools/spawn-subagents-description.md` with updated examples showing the unified interface (single agent, multiple agents, mixed types, shared prompt)

- [ ] **Update the tool registry and wiring**
  - [ ] `node/core/src/tools/tool-registry.ts`: replace `spawn_subagent`, `spawn_foreach`, `wait_for_subagents` with `spawn_subagents` in all arrays (STATIC_TOOL_NAMES, CHAT_STATIC_TOOL_NAMES, DOCKER_ROOT_STATIC_TOOL_NAMES, TOOL_REQUIRED_CAPABILITIES)
  - [ ] `node/core/src/tools/toolManager.ts`: replace imports and StaticToolMap/TOOL_SPEC_MAP entries
  - [ ] `node/core/src/tools/create-tool.ts`: replace 3 switch cases with 1 for `spawn_subagents`
  - [ ] `node/core/src/tool-types.ts`: replace the 3 StructuredResult variants with `SpawnSubagents.StructuredResult` in ToolStructuredResult union
  - [ ] `node/core/src/index.ts`: replace 3 namespace exports with `SpawnSubagents`

- [ ] **Check for type errors and iterate until they pass** (`npx tsgo -p node/core/tsconfig.json --noEmit`)

- [ ] **Write unit tests for the new tool**
  - [ ] Create `node/core/src/tools/spawn-subagents.test.ts`
  - [ ] Test: single subagent spawns correctly and blocks
  - [ ] Test: multiple subagents run with concurrency control
  - [ ] Test: sharedPrompt is prepended to each subagent's prompt
  - [ ] Test: sharedContextFiles are merged with per-agent contextFiles
  - [ ] Test: docker subagent provisioning flow
  - [ ] Test: error handling (missing branch for docker, provisioner not configured, spawn failure)
  - [ ] Test: agentType mapping (fast → subagent_fast, explore → subagent_explore, default → subagent_default)
  - [ ] Test: abort cancels pending subagents
  - [ ] Test: progress tracking updates correctly
  - [ ] Run tests and iterate until they pass

- [ ] **Update the render layer**
  - [ ] Create `node/render-tools/spawn-subagents.ts` combining rendering from the 3 old render files:
    - `renderSummary`: show "🚀 spawn N subagents" or "🚀 spawn subagent" for single
    - `renderInput`: show prompts if expanded
    - `renderProgress`: show per-subagent status with icons, pending approvals, click-to-navigate bindings (merge logic from spawn-subagent + spawn-foreach progress renderers)
    - `renderResultSummary`: show N/N subagents completed
    - `renderResult`: show per-subagent results with click-to-navigate bindings
  - [ ] `node/render-tools/index.ts`: replace 3 switch cases with 1 for `spawn_subagents` in each render function
  - [ ] `node/render-tools/streaming.ts`: replace 3 cases with 1 for `spawn_subagents`

- [ ] **Delete old files**
  - [ ] Delete `node/core/src/tools/spawn-subagent.ts`
  - [ ] Delete `node/core/src/tools/spawn-foreach.ts`
  - [ ] Delete `node/core/src/tools/wait-for-subagents.ts`
  - [ ] Delete `node/core/src/tools/spawn-subagent-description.md`
  - [ ] Delete `node/core/src/tools/spawn-subagent.test.ts`
  - [ ] Delete `node/core/src/tools/spawn-foreach.test.ts`
  - [ ] Delete `node/core/src/tools/wait-for-subagents.test.ts`
  - [ ] Delete `node/render-tools/spawn-subagent.ts`
  - [ ] Delete `node/render-tools/spawn-foreach.ts`
  - [ ] Delete `node/render-tools/wait-for-subagents.ts`

- [ ] **Check for type errors across the whole project** (`npx tsgo -b`)

- [ ] **Update integration tests**
  - [ ] Update `node/tools/spawn-subagent.test.ts` → `node/tools/spawn-subagents.test.ts` (adapt to new tool interface)
  - [ ] Update `node/tools/spawn-foreach.test.ts` → merge into `spawn-subagents.test.ts` or delete
  - [ ] Update `node/tools/wait-for-subagents.test.ts` → delete (no longer needed)
  - [ ] Run all tests and iterate until they pass (`npx vitest run`)

- [ ] **Run linting** (`npx biome check --write .`)
