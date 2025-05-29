import {
  type AbortableAsyncIterator,
  Ollama,
  type ChatRequest,
  type ChatResponse,
  type Message,
  type Tool,
  type ToolCall,
} from "ollama";

import * as ToolManager from "../tools/toolManager.ts";
import type {
  StopReason,
  Provider,
  ProviderMessage,
  Usage,
  ProviderStreamRequest,
  ProviderToolSpec,
  ProviderStreamEvent,
  ProviderToolUseRequest,
} from "./provider-types.ts";
import type { Nvim } from "../nvim/nvim-node";
import { DEFAULT_SYSTEM_PROMPT } from "./constants.ts";

export type OllamaOptions = {
  model: string;
};

export class OllamaProvider implements Provider {
  private client: Ollama;
  private model: string;

  constructor(
    private nvim: Nvim,
    options?: {
      baseUrl?: string | undefined;
      apiKeyEnvVar?: string | undefined;
    },
  ) {
    this.client = new Ollama({
      host: options?.baseUrl ? options?.baseUrl : "http://127.0.0.1:11434",
    });
    this.model = "llama3";
  }

  setModel(model: string): void {
    // It is possible to set the model to a model that is not downloaded or does not exist
    // Ollama itself returns an error if it can't find a model, so seperate checking here is not necessary
    this.model = model;
  }

  createStreamParameters(
    history: ProviderMessage[],
  ): ChatRequest & { stream: true } {
    const messages: Message[] = [
      { role: "system", content: DEFAULT_SYSTEM_PROMPT },
    ];

    for (const m of history) {
      for (const c of m.content) {
        switch (c.type) {
          case "text":
            messages.push({ role: m.role, content: c.text });
            break;

          case "tool_use": {
            // Extract tool arguments based on request status
            const args: Record<string, unknown> =
              c.request.status === "ok"
                ? c.request.value.input
                : (c.request.rawRequest as Record<string, unknown>);

            const toolCall: ToolCall = {
              function: {
                name: c.name,
                arguments: args,
              },
            };

            messages.push({
              role: "assistant",
              content: "",
              tool_calls: [toolCall],
            });
            break;
          }

          case "tool_result": {
            const result =
              c.result.status === "ok" ? c.result.value : c.result.error;

            messages.push({
              role: "tool",
              content:
                typeof result === "string" ? result : JSON.stringify(result),
            });
            break;
          }

          default:
            throw new Error(`content type '${c.type}' not supported by Ollama`);
        }
      }
    }

    const tools = ToolManager.CHAT_TOOL_SPECS.map((s) => ({
      type: "function",
      function: {
        name: s.name,
        description: s.description,
        parameters: s.input_schema,
      },
    })) as Tool[];

    return {
      model: this.model,
      stream: true,
      messages,
      tools,
    };
  }

  countTokens(
    messages: Array<ProviderMessage>,
    tools: Array<ProviderToolSpec>,
  ): number {
    const CHARS_PER_TOKEN = 4;
    let charCount = DEFAULT_SYSTEM_PROMPT.length;
    charCount += JSON.stringify(tools).length;
    charCount += JSON.stringify(messages).length;
    return Math.ceil(charCount / CHARS_PER_TOKEN);
  }

  forceToolUse(
    _messages: Array<ProviderMessage>,
    _spec: ProviderToolSpec,
  ): ProviderToolUseRequest {
    // NOTE: tool choice is not currently supported by ollama, but is listed under "Future Improvements".
    // On some models, this isn't an issue and the correct tool will be called anyway
    return {
      abort: () => {},
      promise: Promise.resolve({
        toolRequest: {
          status: "error" as const,
          error: "Not implemented",
          rawRequest: {},
        },
        stopReason: "tool_use" as const,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
      }),
    };
  }

  sendMessage(
    messages: Array<ProviderMessage>,
    onStreamEvent: (event: ProviderStreamEvent) => void,
  ): ProviderStreamRequest {
    let stopReason: StopReason | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let currentContentBlockIndex = 0;
    let aborted = false;

    const streamParams = this.createStreamParameters(messages);
    let streamingResponse: AbortableAsyncIterator<ChatResponse>;

    const promise = (async (): Promise<{
      usage: Usage;
      stopReason: StopReason;
    }> => {
      streamingResponse = await this.client.chat(streamParams);

      let blockStarted = false;

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

      for await (const chunk of streamingResponse) {
        if (aborted) {
          stopReason = "aborted";
          break;
        }

        if (chunk.message?.content) {
          onStreamEvent({
            type: "content_block_delta",
            index: currentContentBlockIndex,
            delta: {
              type: "text_delta",
              text: chunk.message.content,
            },
          });
        }

        if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
          if (blockStarted) {
            onStreamEvent({
              type: "content_block_stop",
              index: currentContentBlockIndex,
            });
          }

          currentContentBlockIndex++;
          // Although we only access the first tool call, this is okay because Ollama sends the tool calls in seperate chunks in the stream
          // So no need to seperately iterate through tool_calls here
          const toolCall = chunk.message.tool_calls[0];
          stopReason = "tool_use";

          const toolId = `tool-${Date.now()}`;

          onStreamEvent({
            type: "content_block_start",
            index: currentContentBlockIndex,
            content_block: {
              type: "tool_use",
              id: toolId,
              name: toolCall.function.name,
              input: {},
            },
          });

          onStreamEvent({
            type: "content_block_delta",
            index: currentContentBlockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(toolCall.function.arguments),
            },
          });

          onStreamEvent({
            type: "content_block_stop",
            index: currentContentBlockIndex,
          });
          blockStarted = false;
        }

        if (chunk.eval_count) {
          inputTokens = chunk.prompt_eval_count || 0;
          outputTokens = chunk.eval_count;
        }
      }

      if (blockStarted) {
        onStreamEvent({
          type: "content_block_stop",
          index: currentContentBlockIndex,
        });
      }

      return {
        stopReason: stopReason || "end_turn",
        usage: {
          inputTokens,
          outputTokens,
        },
      };
    })();

    return {
      abort: () => {
        aborted = true;
        if (streamingResponse) {
          streamingResponse.abort();
        }
      },
      promise,
    };
  }
}
