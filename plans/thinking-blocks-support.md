# Context

The objective is to add thinking block support to the Anthropic provider in magenta.nvim, enabling users to see Claude's step-by-step reasoning process during complex tasks.

Key types and interfaces:

- `AnthropicProvider`: Main provider class in `node/providers/anthropic.ts` that handles streaming and message creation
- `ProviderStreamEvent`: Union type based on Anthropic's streaming events, defined in `node/providers/provider-types.ts`
- `ProviderMessageContent`: Union type for all possible message content types
- `StreamingBlock`: Type used during streaming to accumulate content as it arrives
- `Message`: Class in `node/chat/message.ts` that handles individual message rendering and state
- `Profile`: Configuration type in `node/options.ts` that defines provider settings

Relevant files:

- `node/providers/anthropic.ts`: Contains AnthropicProvider implementation with stream handling
- `node/providers/provider-types.ts`: Defines provider interface types and stream events
- `node/providers/helpers.ts`: Contains streaming block handling logic (applyDelta, finalizeStreamingBlock)
- `node/chat/message.ts`: Message rendering and content display logic
- `node/options.ts`: Configuration options parsing and Profile type definitions
- `notes/thinking.md`: Documentation on Anthropic's thinking block API

Key findings from thinking block API:

- Claude 3.7 returns full thinking content, Claude 4 models return summarized thinking
- Thinking blocks come as `thinking_delta` and `signature_delta` events during streaming
- Thinking blocks must be preserved in conversation history for tool use to work correctly
- Configuration requires `thinking: { type: "enabled", budget_tokens: number }` parameter
- Thinking blocks appear as first content block in assistant messages when enabled
- Budget tokens must be >= 1024 and < max_tokens

# Implementation

- [x] Extend ProviderMessageContent and ProviderStreamEvent types to support thinking blocks
  - [x] Add `thinking` and `redacted_thinking` content block types to ProviderMessageContent union
  - [x] Add `thinking_delta` and `signature_delta` to stream event delta types
  - [x] Check all references and ensure type compatibility
  - [x] Iterate until you get no compilation/type errors

- [x] Add thinking configuration options to Profile type
  - [x] Add optional `thinking?: { enabled: boolean; budgetTokens?: number }` field to Profile type in `node/options.ts`
  - [x] Update profile parsing logic to handle thinking configuration
  - [x] Add sensible defaults (enabled: false, budgetTokens: 1024)
  - [x] Iterate until you get no compilation/type errors

- [x] Implement thinking block support in streaming helpers
  - [x] Update `applyDelta` function in `node/providers/helpers.ts` to handle `thinking_delta` and `signature_delta`
  - [x] Update `finalizeStreamingBlock` to finalize thinking blocks correctly
  - [x] Add thinking block types to StreamingBlock union

- [x] Update AnthropicProvider to send thinking parameters
  - [x] Modify `createStreamParameters` method to include thinking config when enabled
  - [x] Add interleaved thinking support for Claude 4 models using `interleaved-thinking-2025-05-14` beta header
  - [x] Add thinking option to the `sendMessage` method (make sure to propagate it through the whole Provider type)
  - [x] `forceToolUse` does not use a thinking-compatible API parameter
  - [x] iterate until no compilaton/type errors

- [x] Implement thinking and redacted_thinking block rendering in Message class
  - [x] Add thinking block rendering logic to `renderContent` method in `node/chat/message.ts`
  - [x] Add thinking block support to `renderStreamingBlock` method
  - [x] Create expandable/collapsible UI for thinking blocks (similar to tool details)
  - [x] Add thinking block handling to `stringifyContent` in helpers
  - [x] iterate until no compilation / type errors

- [x] Add user interface controls for thinking blocks
  - [x] Display whether thinking is enabled in the input buffer next to "Magenta Input" in the sidebar

- [ ] write integration tests. Test both thinking and redacted_thinking blocks. Verify that the blocks are displayed correctly and included in followup messages.

# Anthropic thinking types

export type ContentBlock =
| TextBlock
| ToolUseBlock
| ServerToolUseBlock
| WebSearchToolResultBlock
| ThinkingBlock
| RedactedThinkingBlock;

export interface ThinkingBlock {
signature: string;

thinking: string;

type: 'thinking';
}

export interface RedactedThinkingBlock {
data: string;

type: 'redacted_thinking';
}

export type RawMessageStreamEvent =
| RawMessageStartEvent
| RawMessageDeltaEvent
| RawMessageStopEvent
| RawContentBlockStartEvent
| RawContentBlockDeltaEvent
| RawContentBlockStopEvent;

export interface ThinkingDelta {
thinking: string;

type: 'thinking_delta';
}

in `/Users/denislantsman/src/magenta.nvim/node_modules/@anthropic-ai/sdk/src/resources/messages/messages.ts`

