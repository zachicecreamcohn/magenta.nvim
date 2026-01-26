# context

The goal is to simplify the compact tool by removing checkpoints and the from-to replacement capability. Instead, compact should produce a single summary of the entire thread plus a `contextFiles` list of important files to include in the compacted thread.

## Current Implementation

### Key Files

- `node/chat/checkpoint.ts` - generates checkpoint IDs (`<checkpoint:xxxxxx>`), embedded in user messages after system reminders
- `node/tools/compact.ts` - compact tool with `replacements: [{from, to, summary}]` and `continuation` parameters
- `node/providers/anthropic-agent.ts` - `Agent.compact()` method that builds checkpoint maps, resolves ranges, applies replacements
- `node/providers/provider-types.ts` - `CompactReplacement` type, `ProviderCheckpointContent` type, `Agent.compact()` interface
- `node/chat/thread.ts` - handles `@compact` command, `awaiting_control_flow` mode, checkpoint content in messages

### Key Types

- `CompactReplacement = { from?: string; to?: string; summary: string }` - checkpoint-based range replacement
- `ProviderCheckpointContent = { type: "checkpoint"; id: string }` - checkpoint content block
- `ProviderMessageContent` union includes `ProviderCheckpointContent`

### Files that reference checkpoint

- `node/providers/anthropic.ts`
- `node/providers/anthropic-agent.ts` (heavy usage in compact logic)
- `node/providers/anthropic-agent.spec.ts`
- `node/chat/thread.ts` (generates checkpoints, renders them)
- `node/tools/compact.ts` and `compact.spec.ts`
- `node/context/context-manager.spec.ts`
- `node/test/setup.ts`

## New Design

### New Compact Tool Input

```typescript
type Input = {
  summary: string; // Single summary of the entire thread
  contextFiles?: string[]; // File paths to include in compacted thread
  continuation?: string; // Optional: what to do after compaction
};
```

### New Agent.compact() Interface

```typescript
compact(summary: string, contextFiles?: string[]): void;
```

The compacted thread will:

1. Have a single user message with the context files (if any)
2. Have a single assistant message with the summary

# implementation

- [x] Update `CompactReplacement` type and `Agent.compact()` interface in `provider-types.ts`
  - [x] Replace `CompactReplacement` with simple `{summary: string; contextFiles?: string[]}`
  - [x] Update `Agent.compact()` signature
  - [x] Remove `ProviderCheckpointContent` from `ProviderMessageContent` union
  - [x] Delete `ProviderCheckpointContent` type

- [x] Update compact tool in `node/tools/compact.ts`
  - [x] Simplify `Input` type to `{summary: string; contextFiles?: string[]; continuation?: string}`
  - [x] Update `spec` tool description and `input_schema`
  - [x] Update `validateInput` function
  - [x] Update `doCompact()` to pass new parameters to agent

- [x] Simplify `AnthropicAgent.compact()` in `node/providers/anthropic-agent.ts`
  - [x] Remove checkpoint map building (`buildCheckpointMap`)
  - [x] Remove range resolution methods (`resolveCheckpointPosition`, `resolveFromCheckpoint`)
  - [x] Remove `applyReplacementWithMap`
  - [x] Implement simple logic: replace entire thread with summary + optional context files preamble
  - [x] Remove imports from `../chat/checkpoint.ts`

- [x] Remove checkpoint generation from `node/chat/thread.ts`
  - [x] Remove `generateCheckpointId`, `checkpointToText` imports
  - [x] Remove checkpoint content from `prepareUserContent()`
  - [x] Remove checkpoint content from `sendToolResultsAndContinue()`
  - [x] Remove checkpoint rendering in `renderMessageContent()`
  - [x] Update `@compact` handling (remove `truncateIdx` tracking if no longer needed)

- [x] Delete `node/chat/checkpoint.ts`

- [x] Update tests
  - [x] Update `node/tools/compact.spec.ts` for new tool shape
  - [x] Update `node/providers/anthropic-agent.spec.ts` for new compact behavior
  - [x] Update `node/chat/thread.spec.ts` to remove checkpoint expectations
  - [x] Update any other tests that reference checkpoints
  - [x] Run tests and iterate until they pass

- [x] Clean up snapshots
  - [x] Delete/regenerate affected snapshot files

- [x] Type check and iterate until no errors
  - [x] `npx tsc --noEmit`
  - [x] `npx vitest run` (start with tests specific to this change, then run whole test suite)
