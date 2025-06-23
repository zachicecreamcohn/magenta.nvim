# Copilot Provider Architecture Plan

## Overview

This document outlines the architecture for implementing a GitHub Copilot provider in magenta.nvim. The provider will use OpenAI's Chat Completions API and handle Copilot's OAuth authentication while maintaining compatibility with the existing `Provider` interface.

**Key Architectural Insight**: The existing `OllamaProvider` already demonstrates the exact patterns needed for Copilot:

- Chat completions-style streaming API with direct message translation
- Simple tool call handling without complex batching
- Standard Anthropic-compatible stream event generation
- Clean separation between API client and provider logic

This makes Copilot implementation much simpler than the complex OpenAI Responses API approach currently used in `OpenAIProvider`.

## Core Architecture

### Provider Implementation Strategy

The `CopilotProvider` will:

- Implement the existing `Provider` interface (no interface changes needed)
- Use OpenAI's Chat Completions API (like Ollama, not Responses API like current OpenAI provider)
- Handle Copilot's OAuth authentication through a separate auth layer
- Follow OllamaProvider's proven streaming and message translation patterns
- Leverage existing tool validation and error handling infrastructure

### Key Components

#### 1. Authentication Layer (`CopilotAuth`)

```typescript
class CopilotAuth {
  private tokenInfo?: {
    token: string;
    endpoints: { api: string };
    expiresAt: Date;
  };

  async getGitHubToken(): Promise<{
    token: string;
    endpoints: { api: string };
  }>;
  private async refreshTokenIfNeeded(): Promise<void>;
  private discoverOAuthToken(): string; // from ~/.config/github-copilot/
  private async exchangeOAuthForGitHubToken(): Promise<void>;
}
```

**Responsibilities:**

- Discover existing Copilot OAuth tokens from standard file locations
- Exchange OAuth tokens for GitHub API tokens with endpoint discovery
- Handle automatic token refresh (every 28 minutes, 2 minutes before expiry)
- Provide dynamic endpoint URLs for API calls
- Cache tokens with expiration tracking

#### 2. Provider Class Structure

```typescript
export class CopilotProvider implements Provider {
  private auth: CopilotAuth;
  private model: string;

  constructor(nvim: Nvim) {
    this.auth = new CopilotAuth();
    this.model = "gpt-4o";
  }

  private async createClient(): Promise<OpenAI> {
    const { token, endpoints } = await this.auth.getGitHubToken();
    return new OpenAI({
      apiKey: token,
      baseURL: endpoints.api,
      defaultHeaders: {
        "Copilot-Integration-Id": "neovim-magenta",
        "Editor-Version": `Neovim/${this.nvim.version}`,
      },
    });
  }
}
```

## API Translation Strategy - Following OllamaProvider Patterns

### Message Translation (Simplified vs Current OpenAI Provider)

**Current OpenAI Provider Problem**: Uses complex Responses API with message batching, content accumulation, and state management.

**Copilot Solution**: Chat Completions API allows direct translation like OllamaProvider:

```typescript
// Following OllamaProvider's createStreamParameters pattern
createStreamParameters(
  messages: Array<ProviderMessage>,
  tools: Array<ProviderToolSpec>,
  options?: { disableCaching?: boolean; systemPrompt?: string }
): OpenAI.Chat.ChatCompletionCreateParamsStreaming {

  const chatMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: options?.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    },
  ];

  // Simple direct translation - no batching complexity
  for (const message of messages) {
    for (const content of message.content) {
      switch (content.type) {
        case "text":
          chatMessages.push({
            role: message.role,
            content: content.text
          });
          break;

        case "tool_use":
          // Following Ollama's tool_calls pattern
          const toolCall: OpenAI.Chat.ChatCompletionMessageToolCall = {
            id: content.id,
            type: "function",
            function: {
              name: content.name,
              arguments: content.request.status === "ok"
                ? JSON.stringify(content.request.value.input)
                : JSON.stringify(content.request.rawRequest)
            }
          };

          chatMessages.push({
            role: "assistant",
            content: null,
            tool_calls: [toolCall]
          });
          break;

        case "tool_result":
          chatMessages.push({
            role: "tool",
            tool_call_id: content.id,
            content: content.result.status === "ok"
              ? this.formatToolResult(content.result.value)
              : content.result.error
          });
          break;

        // Handle other content types...
      }
    }
  }

  return {
    model: this.model,
    stream: true,
    messages: chatMessages,
    tools: tools.map(spec => ({
      type: "function",
      function: {
        name: spec.name,
        description: spec.description,
        parameters: spec.input_schema
      }
    }))
  };
}
```

### Streaming Event Translation (Following OllamaProvider)

**From:** Chat Completions `ChatCompletionChunk` events
**To:** Anthropic-compatible `ProviderStreamEvent` format

```typescript
// Following OllamaProvider's sendMessage streaming pattern
sendMessage(
  messages: Array<ProviderMessage>,
  onStreamEvent: (event: ProviderStreamEvent) => void,
  tools: Array<ProviderToolSpec>,
  options?: { systemPrompt?: string }
): ProviderStreamRequest {

  let streamRequest: OpenAI.Chat.Completions.Stream<OpenAI.Chat.ChatCompletionChunk>;
  let currentContentBlockIndex = 0;
  let blockStarted = false;

  const promise = (async () => {
    const client = await this.createClient();

    streamRequest = await client.chat.completions.create(
      this.createStreamParameters(messages, tools, options)
    );

    // Start first content block (following Ollama pattern)
    onStreamEvent({
      type: "content_block_start",
      index: currentContentBlockIndex,
      content_block: {
        type: "text",
        text: "",
        citations: null,
      },
    });
    blockStarted = true;

    for await (const chunk of streamRequest) {
      const delta = chunk.choices[0]?.delta;

      if (delta?.content) {
        // Text content delta (following Ollama pattern)
        onStreamEvent({
          type: "content_block_delta",
          index: currentContentBlockIndex,
          delta: {
            type: "text_delta",
            text: delta.content,
          },
        });
      }

      if (delta?.tool_calls) {
        // Tool call handling (following Ollama pattern)
        if (blockStarted) {
          onStreamEvent({
            type: "content_block_stop",
            index: currentContentBlockIndex,
          });
        }

        currentContentBlockIndex++;
        const toolCall = delta.tool_calls[0];

        onStreamEvent({
          type: "content_block_start",
          index: currentContentBlockIndex,
          content_block: {
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function?.name || "",
            input: {},
          },
        });

        if (toolCall.function?.arguments) {
          onStreamEvent({
            type: "content_block_delta",
            index: currentContentBlockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: toolCall.function.arguments,
            },
          });
        }

        blockStarted = false;
      }
    }

    // Final cleanup
    if (blockStarted) {
      onStreamEvent({
        type: "content_block_stop",
        index: currentContentBlockIndex,
      });
    }

    return {
      stopReason: "end_turn" as const,
      usage: { inputTokens: 0, outputTokens: 0 } // TODO: Extract from response
    };
  })();

  return {
    abort: () => streamRequest?.controller?.abort(),
    promise,
  };
}
```

## Authentication Implementation Details

### Token Discovery and Management

```typescript
class CopilotAuth {
  private static readonly TOKEN_PATHS = [
    path.join(os.homedir(), ".config", "github-copilot", "hosts.json"),
    path.join(os.homedir(), ".config", "github-copilot", "apps.json"),
  ];

  private async discoverOAuthToken(): Promise<string> {
    for (const tokenPath of CopilotAuth.TOKEN_PATHS) {
      if (
        await fs.access(tokenPath).then(
          () => true,
          () => false,
        )
      ) {
        const data = await fs.readFile(tokenPath, "utf-8");
        const parsed = JSON.parse(data);
        // Extract token from various possible structures
        return this.extractTokenFromConfig(parsed);
      }
    }
    throw new Error("No Copilot OAuth token found");
  }

  private async exchangeOAuthForGitHubToken(): Promise<{
    token: string;
    endpoints: { api: string };
  }> {
    const oauthToken = await this.discoverOAuthToken();

    // Exchange OAuth token for GitHub API token
    const response = await fetch(
      "https://api.github.com/copilot_internal/v2/token",
      {
        method: "GET",
        headers: {
          Authorization: `token ${oauthToken}`,
          Accept: "application/vnd.github.v3+json",
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to exchange OAuth token: ${response.statusText}`);
    }

    const data = await response.json();
    return {
      token: data.token,
      endpoints: {
        api: data.endpoints?.api || "https://api.githubcopilot.com",
      },
    };
  }
}
```

## Tool Support and Error Handling

### Following Existing Patterns

The Copilot provider will leverage existing infrastructure:

- **Tool validation**: Use existing `validateInput()` from `tools/helpers.ts`
- **Error handling**: Use existing `Result` type system
- **Tool request IDs**: Use existing `ToolRequestId` system
- **Content formatting**: Follow patterns from other providers for images/documents

### Force Tool Use Implementation

```typescript
// Following OllamaProvider's forceToolUse pattern but with chat completions
forceToolUse(
  messages: Array<ProviderMessage>,
  spec: ProviderToolSpec,
  options?: { systemPrompt?: string }
): ProviderToolUseRequest {

  let aborted = false;
  const promise = (async (): Promise<ProviderToolUseResponse> => {
    const client = await this.createClient();

    const response = await client.chat.completions.create({
      model: this.model,
      messages: this.createChatMessages(messages, options?.systemPrompt),
      tools: [{
        type: "function",
        function: {
          name: spec.name,
          description: spec.description,
          parameters: spec.input_schema
        }
      }],
      tool_choice: { type: "function", function: { name: spec.name } },
      stream: false,
    });

    // Extract and validate tool call (following existing patterns)
    const toolCall = response.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall) {
      throw new Error("No tool call in forced response");
    }

    const input = validateInput(
      spec.name,
      JSON.parse(toolCall.function.arguments)
    );

    const toolRequest: Result<ToolRequest, { rawRequest: unknown }> =
      input.status === "ok" ? {
        status: "ok",
        value: {
          toolName: spec.name,
          id: toolCall.id as ToolRequestId,
          input: input.value,
        }
      } : { ...input, rawRequest: toolCall.function.arguments };

    return {
      toolRequest,
      stopReason: "tool_use",
      usage: { inputTokens: 0, outputTokens: 0 }, // TODO: Extract from response
    };
  })();

  return {
    abort: () => { aborted = true; },
    promise,
  };
}
```

## Implementation Phases

### Phase 1: Authentication Foundation

- [ ] Implement `CopilotAuth` class with token discovery
- [ ] Add OAuth token exchange functionality
- [ ] Implement token refresh logic with 28-minute intervals

### Phase 2: Basic Provider Structure

- [ ] Create `CopilotProvider` class implementing `Provider` interface
- [ ] Implement basic message translation (text content only)
- [ ] Add `createStreamParameters` method following Ollama patterns.
- [ ] Make sure to use the openai conversions for schema compatibility (ollama is missing these too, we will update that later)
- [ ] iterate until typechecks pass

### Phase 3: Streaming Implementation

- [ ] Implement `sendMessage` with chat completions streaming
- [ ] Add proper stream event translation to Anthropic format
- [ ] Handle text content streaming following Ollama patterns

### Phase 4: Tool Support

- [ ] Implement `forceToolUse` method
