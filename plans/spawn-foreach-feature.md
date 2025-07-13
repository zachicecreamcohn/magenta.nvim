# Context

The goal is to implement a separate `spawn_foreach` tool that creates multiple subagents running in parallel, each processing a specific element from the provided array. This is a standalone tool separate from `spawn_subagent` to keep the responsibilities focused and clear.

The relevant files and entities are:

**node/tools/spawn-foreach.ts**: New foreach tool implementation

- `SpawnForeachTool`: Main tool class that manages parallel subagent spawning
- `State`: Union type defining tool states (`running` | `done`)
- `Msg`: Message type for tool communication (`foreach-subagent-created` | `subagent-completed`)
- `Input`: Input validation and types for foreach elements
- `spec`: Tool specification for provider integration

**node/tools/wait-for-subagents.ts**: Reference implementation for parallel subagent management

- `WaitForSubagentsTool`: Shows patterns for waiting on multiple threads
- `checkThreads()`: Method to check completion status of multiple threads
- `renderThreadStatus()`: UI pattern for displaying thread status

**node/chat/chat.ts**: Chat manager that handles thread lifecycle

- `getThreadResult()`: Returns completion status and results for threads
- `getThreadSummary()`: Provides thread status summaries for UI display
- `handleSpawnSubagentThread()`: Handles creation of new subagent threads
- `notifyParent()`: Notifies parent threads when subagents complete

**lua/magenta/options.lua**: Plugin configuration

- `defaults`: Default configuration object where new options are added

Key types and interfaces:

- `ThreadId`: Unique identifier for threads
- `Result<T>`: Status wrapper (`ok` | `error`) for operation results
- `ProviderToolResult`: Tool result format returned to provider
- `RootMsg`/`Msg`: Message types for dispatching updates through system

# Implementation

- [x] Create separate spawn_foreach tool

  - [x] Create `node/tools/spawn-foreach.ts` with its own Input type for `elements: string[]`
  - [x] Implement `validateInput()` function to validate elements array (non-empty, all strings)
  - [x] Add validation error for empty elements arrays
  - [x] Keep spawn_subagent.ts clean and focused on single subagent spawning

- [x] Create tool specification schema for spawn_foreach

  - [x] Add `elements` to `input_schema.properties` with array of strings type
  - [x] Create comprehensive tool description documenting foreach usage patterns
  - [x] Add examples showing spawn_foreach usage. In the example, use the find_references tool to get a list of locations, then spawn a foreach call to update each location. In another example, the user provides us with a list of quickfix locations in their prompt. The agent then spawns a foreach to fix each file present in the quickfix list.

- [x] Add configuration option for concurrency control

  - [x] Add `maxConcurrentSubagents: 3` to `defaults` in `lua/magenta/options.lua`
  - [x] Pass maxConcurrentSubagents through tool context to spawn_foreach tool

- [x] Design State type for foreach execution

  - [x] Add `running` state variant with per-element tracking
  - [x] Add `done` state variant for completed foreach execution
  - [x] Define ElementState data structure for tracking individual elements:
    ```typescript
    type ElementState =
      | { status: "pending" }
      | { status: "spawning" }
      | { status: "running"; threadId: ThreadId }
      | { status: "completed"; threadId: ThreadId; result: Result<string> };
    ```

- [x] Implement foreach initialization logic

  - [x] Initialize SpawnForeachTool constructor with `running` state and element queue setup
  - [x] Create all elements with `pending` status initially
  - [x] Create helper method `startNextBatch()` to launch initial subagents up to concurrency limit

- [x] Add new message types for subagent lifecycle tracking

  - [x] Add `foreach-subagent-created` message type for initial subagent creation
  - [x] Add `subagent-completed` message type containing threadId, element, and result
  - [x] Update message handling in `update()` method to process both creation and completion notifications
  - [x] Implement queue management logic to start next pending subagent when slot opens
  - [x] Detect when all subagents complete and transition to `done` state

- [x] Implement subagent spawning for foreach elements

  - [x] Create `spawnSubagentForElement()` method that modifies prompt with foreach context
  - [x] Generate enhanced prompt: `<original_prompt>\n\nYou are one of several agents working in parallel on this prompt. Your task is to complete this prompt for this specific case:\n\n<element>`
  - [x] Track element-to-threadId mapping in element state
  - [x] Handle spawning failures gracefully by moving to next element

- [x] Update view rendering for foreach progress

  - [x] Implement `renderSummary()` to show foreach progress across all elements
  - [x] Display element list with status indicators (pending ⏸️, spawning 🚀, running ⏳, completed ✅/❌)
  - [x] Add click handlers to navigate to individual subagent threads
  - [x] Follow UI patterns from `wait-for-subagents.ts` for consistency

- [x] Implement result aggregation and tool completion

  - [x] Override `getToolResult()` for foreach mode to return combined results from all subagents
  - [x] Format final result as structured summary with individual element results
  - [x] Include both successful and failed element results in final output
  - [x] Ensure tool remains marked as not done until all subagents complete

- [x] Add abort handling for foreach mode

  - [x] Extend `abort()` method to handle foreach states
  - [ ] Cancel all running subagents when tool is aborted
  - [x] Properly clean up state and return appropriate error result

- [ ] Write tests and iterate until tests pass

  - [ ] Integration tests for full foreach workflow with multiple elements

- [x] Listen for subagent completion via chat notification system

  - [x] Ensure `notifyParent()` in `chat.ts` triggers appropriate messages for spawn_foreach tools
  - [x] Handle completion notifications in tool's message processing
  - [x] Integrate with existing chat subagent lifecycle management

- [ ] Register spawn_foreach tool in tool system
  - [ ] Add spawn_foreach to tool registry (node/tools/tool-registry.ts)
  - [ ] Add spawn_foreach to tool manager (node/tools/toolManager.ts)
  - [ ] Update root message types to include spawn_foreach messages
- [ ] Check for compilation/type errors and iterate until resolved
  - [ ] Run `npx tsc --noEmit` to verify no type errors
  - [ ] Address any type mismatches in state management or message handling
  - [ ] Ensure proper typing of foreach-specific data structures

