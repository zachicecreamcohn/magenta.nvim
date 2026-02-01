# Context

## Objective

Add an "explore" subagent type that encourages proactive exploration of the codebase. When the agent needs to search for something (grepping, reading multiple files, etc.), it should delegate to an explore subagent that returns code locations and snippets. This will allow us to use a cheaper "fast" agent, and save context tokens inside of the main agent going back and forth and exploring files in the code.

Additionally, add a "blocking" option so the parent agent doesn't need to explicitly call `wait_for_subagents`.

## Relevant Files and Entities

- `node/tools/spawn-subagent.ts`: The spawn_subagent tool implementation
  - `Input` type: defines `prompt`, `contextFiles`, `agentType`
  - `spec`: ProviderToolSpec with the tool description
  - `SpawnSubagentTool` class: handles spawning and state management

- `node/tools/wait-for-subagents.ts`: The wait tool that blocks until subagents complete
  - Used to gather results from spawned subagents

- `node/providers/system-prompt.ts`: System prompts for different thread types
  - `AGENT_TYPES`: currently `["default", "fast"]`
  - `ThreadType`: `"subagent_default" | "subagent_fast" | "root"`
  - `DEFAULT_SUBAGENT_SYSTEM_PROMPT`: shared by both subagent types
  - `createSystemPrompt()`: generates system prompt based on thread type

- `node/chat/types.ts`: Defines `ThreadType`

- `node/chat/chat.ts`: Handles thread spawning via `spawn-subagent-thread` message

# Implementation

## Phase 1: Add "explore" agent type

- [x] In `node/chat/types.ts`, add `"subagent_explore"` to `ThreadType`
- [x] In `node/providers/system-prompt.ts`:
  - [x] Add `"explore"` to `AGENT_TYPES`
  - [x] Create `EXPLORE_SUBAGENT_SYSTEM_PROMPT` with instructions for:
    - Using search tools (rg, fd, grep) effectively
    - Using hover and get_file to understand code
    - Reporting findings as code locations with file paths and line numbers
    - Including relevant code snippets in the yield response
    - Keeping exploration focused on answering the specific question
  - [x] Update `getBaseSystemPrompt()` to return explore prompt for `"subagent_explore"`
- [x] In `node/tools/spawn-subagent.ts`:
  - [x] Update `spawnSubagent()` to map `"explore"` agentType to `"subagent_explore"` threadType
  - [x] Update `spec.description` with guidance on when to use explore subagents:
    - Use for "where in the code do we do X?" questions
    - Use when searching/grepping to find relevant code
    - Expect response to contain code locations and snippets
- [x] Run type checks and fix any errors (also fixed `system-reminders.ts` and `toolManager.ts`)

## Phase 2: Add blocking option

- [x] In `node/tools/spawn-subagent.ts`:
  - [x] Add `blocking?: boolean` to `Input` type
  - [x] Add `blocking` property to `spec.input_schema`
  - [x] Update `validateInput()` to handle `blocking` field
  - [x] Update tool description to explain blocking behavior
- [x] Modify `SpawnSubagentTool` to handle blocking mode:
  - [x] Add state to track spawned threadId (`waiting-for-subagent` state)
  - [x] When blocking is true, don't complete until subagent yields
  - [x] Use `chat.getThreadResult()` to check subagent completion (same pattern as `WaitForSubagentsTool`)
  - [x] Include subagent result in the tool result instead of just threadId
- [x] Run type checks and fix any errors

## Phase 3: Tests

- [x] Add tests for explore subagent in `node/tools/spawn-subagent.test.ts`:
  - [x] Test that explore agentType creates subagent_explore thread
  - [x] Test that explore subagent gets correct system prompt
- [x] Add tests for blocking option:
  - [x] Test that blocking=true waits for subagent completion
  - [x] Test that blocking=false returns immediately with threadId
  - [x] Test that blocking subagent result includes yield message
- [x] Run tests and iterate until they pass
- [x] Fixed blocking notification by adding spawn_subagent check to `notifyParent` in chat.ts

## Notes

- The explore subagent should use the fast model (like `subagent_fast`) since it's doing quick exploration tasks
- The blocking option essentially combines spawn + wait into a single tool call, reducing round trips
- The explore subagent prompt should emphasize concrete questions, situations when the explore agent is most useful, and structured output: file paths, line numbers, and short snippets
- Also add reminders for using the explore subagent to the periodic system reminder
