# Extended Thinking - Summary from Anthropic Documentation

## Overview

Extended thinking gives Claude enhanced reasoning capabilities for complex tasks, providing transparency into its step-by-step thought process before delivering a final answer.

## Supported Models

- Claude Opus 4 (`claude-opus-4-20250514`)
- Claude Sonnet 4 (`claude-sonnet-4-20250514`)
- Claude Sonnet 3.7 (`claude-3-7-sonnet-20250219`)

## How It Works

- Claude creates `thinking` content blocks with internal reasoning
- API response includes thinking blocks followed by text blocks
- Thinking insights inform the final response

## Basic API Usage

```json
{
  "model": "claude-sonnet-4-20250514",
  "max_tokens": 16000,
  "thinking": {
    "type": "enabled",
    "budget_tokens": 10000
  },
  "messages": [...]
}
```

## Key Parameters

- **`budget_tokens`**: Maximum tokens for internal reasoning (minimum: 1024)
- Must be less than `max_tokens` (except with interleaved thinking)
- Budget is a target, not strict limit
- Actual usage may vary based on task complexity

## Model Differences

### Claude 3.7 Sonnet

- Returns full thinking output
- No interleaved thinking support

### Claude 4 Models (Opus 4 & Sonnet 4)

- Returns **summarized thinking** (you're billed for full thinking tokens)
- Supports interleaved thinking with beta header
- Can use tools between thinking blocks

## Interleaved Thinking (Claude 4 only)

- Enables thinking between tool calls
- Requires beta header: `interleaved-thinking-2025-05-14`
- `budget_tokens` can exceed `max_tokens`
- Allows chaining multiple tool calls with reasoning

## Tool Use Considerations

- Only supports `tool_choice: {"type": "auto"}` or `"none"`
- Must preserve thinking blocks when passing tool results
- Critical for maintaining reasoning continuity
- Pass complete unmodified thinking blocks back to API

## Streaming

- Uses `thinking_delta` events for thinking content
- Chunky delivery pattern is expected behavior
- Required when `max_tokens` > 21,333

## Context Window & Token Management

- Previous thinking blocks stripped from context (don't count)
- Current thinking counts toward `max_tokens`
- Strict validation: prompt + max_tokens must fit in context window
- Use token counting API for accurate counts

## Thinking Encryption & Safety

- Full content encrypted in `signature` field
- Thinking redaction may occur for safety reasons
- `redacted_thinking` blocks contain encrypted content
- Redacted blocks still inform responses while maintaining safety

## Best Practices

### Budget Optimization

- Start with minimum (1024 tokens) and increase incrementally
- Use 16k+ tokens for complex tasks
- Above 32k tokens: use batch processing
- Monitor usage to optimize cost/performance

# Code example

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const stream = await client.messages.stream({
  model: "claude-opus-4-20250514",
  max_tokens: 16000,
  thinking: {
    type: "enabled",
    budget_tokens: 10000,
  },
  messages: [
    {
      role: "user",
      content: "What is 27 * 453?",
    },
  ],
});

let thinkingStarted = false;
let responseStarted = false;

for await (const event of stream) {
  if (event.type === "content_block_start") {
    console.log(`\nStarting ${event.content_block.type} block...`);
    // Reset flags for each new block
    thinkingStarted = false;
    responseStarted = false;
  } else if (event.type === "content_block_delta") {
    if (event.delta.type === "thinking_delta") {
      if (!thinkingStarted) {
        process.stdout.write("Thinking: ");
        thinkingStarted = true;
      }
      process.stdout.write(event.delta.thinking);
    } else if (event.delta.type === "text_delta") {
      if (!responseStarted) {
        process.stdout.write("Response: ");
        responseStarted = true;
      }
      process.stdout.write(event.delta.text);
    }
  } else if (event.type === "content_block_stop") {
    console.log("\nBlock complete.");
  }
}
```

# Example streaming output

```
event: message_start
data: {"type": "message_start", "message": {"id": "msg_01...", "type": "message", "role": "assistant", "content": [], "model": "claude-sonnet-4-20250514", "stop_reason": null, "stop_sequence": null}}

event: content_block_start
data: {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "Let me solve this step by step:\n\n1. First break down 27 * 453"}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "\n2. 453 = 400 + 50 + 3"}}

// Additional thinking deltas...

event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds..."}}

event: content_block_stop
data: {"type": "content_block_stop", "index": 0}

event: content_block_start
data: {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "27 * 453 = 12,231"}}

// Additional text deltas...

event: content_block_stop
data: {"type": "content_block_stop", "index": 1}

event: message_delta
data: {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": null}}

event: message_stop
data: {"type": "message_stop"}
```

