import OpenAI from "openai";
import * as ToolManager from "../tools/toolManager.ts";
import { extendError, type Result } from "../utils/result.ts";
import type {
  StopReason,
  Provider,
  ProviderMessage,
  Usage,
} from "./provider.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { ToolName, ToolRequestId } from "../tools/toolManager.ts";
import type { Nvim } from "nvim-node";
import type { Stream } from "openai/streaming.mjs";
import { DEFAULT_SYSTEM_PROMPT } from "./constants.ts";
import tiktoken from "tiktoken";
import type { InlineEditToolRequest } from "../tools/inlineEdit.ts";

export type OpenAIOptions = {
  model: "gpt-4o";
};

export class OpenAIProvider implements Provider {
  private client: OpenAI;
  private request: Stream<unknown> | undefined;

  abort() {
    if (this.request) {
      this.request.controller.abort();
      this.request = undefined;
    }
  }

  constructor(
    private nvim: Nvim,
    private options: OpenAIOptions,
  ) {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      throw new Error("OPENAI_API_KEY key not found in environment");
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: process.env.OPENAI_BASE_URL,
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async countTokens(messages: Array<ProviderMessage>): Promise<number> {
    const enc = tiktoken.encoding_for_model("gpt-4o");
    let totalTokens = 0;

    // Count system message
    totalTokens += enc.encode(DEFAULT_SYSTEM_PROMPT).length;

    for (const message of messages) {
      if (typeof message.content === "string") {
        totalTokens += enc.encode(message.content).length;
      } else {
        for (const content of message.content) {
          switch (content.type) {
            case "text":
              totalTokens += enc.encode(content.text).length;
              break;
            case "tool_use":
              totalTokens += enc.encode(content.request.name).length;
              totalTokens += enc.encode(
                JSON.stringify(content.request.input),
              ).length;
              break;
            case "tool_result":
              totalTokens += enc.encode(
                content.result.status === "ok"
                  ? content.result.value
                  : content.result.error,
              ).length;
              break;
          }
        }
      }
      // Add tokens for message format (role, etc)
      totalTokens += 3;
    }

    enc.free();
    return totalTokens;
  }

  createStreamParameters(
    messages: Array<ProviderMessage>,
  ): OpenAI.ChatCompletionCreateParamsStreaming {
    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: DEFAULT_SYSTEM_PROMPT,
      },
    ];

    for (const m of messages) {
      if (typeof m.content == "string") {
        openaiMessages.push({
          role: m.role,
          content: m.content,
        });
      } else {
        const messageContent: Array<OpenAI.ChatCompletionContentPartText> = [];
        const toolCalls: Array<OpenAI.ChatCompletionMessageToolCall> = [];

        const toolResponses: OpenAI.ChatCompletionToolMessageParam[] = [];

        for (const content of m.content) {
          switch (content.type) {
            case "text":
              messageContent.push({
                type: "text",
                text: content.text,
              });
              break;
            case "tool_use":
              toolCalls.push({
                type: "function",
                id: content.request.id,
                function: {
                  name: content.request.name,
                  arguments: JSON.stringify(content.request.input),
                },
              });
              break;
            case "tool_result":
              toolResponses.push({
                role: "tool",
                tool_call_id: content.id,
                content:
                  content.result.status == "ok"
                    ? content.result.value
                    : content.result.error,
              });
              break;
            default:
              assertUnreachable(content);
          }
        }

        if (m.role == "user" && messageContent.length) {
          openaiMessages.push({
            role: m.role,
            content: messageContent,
          });
        } else if (
          m.role == "assistant" &&
          (messageContent.length || toolCalls.length)
        ) {
          const mes: OpenAI.ChatCompletionMessageParam = {
            role: m.role,
            content: messageContent,
          };

          if (toolCalls.length) {
            mes.tool_calls = toolCalls;
          }
          openaiMessages.push(mes);
        }

        if (toolResponses.length) {
          openaiMessages.push(...toolResponses);
        }
      }
    }

    return {
      model: this.options.model,
      stream: true,
      messages: openaiMessages,
      // see https://platform.openai.com/docs/guides/function-calling#parallel-function-calling-and-structured-outputs
      // this recommends disabling parallel tool calls when strict adherence to schema is needed
      parallel_tool_calls: false,
      tools: ToolManager.TOOL_SPECS.map((s): OpenAI.ChatCompletionTool => {
        return {
          type: "function",
          function: {
            name: s.name,
            description: s.description,
            strict: true,
            parameters: s.input_schema as OpenAI.FunctionParameters,
          },
        };
      }),
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async inlineEdit(_messages: Array<ProviderMessage>): Promise<{
    inlineEdit: Result<InlineEditToolRequest, { rawRequest: unknown }>;
    stopReason: StopReason;
    usage: Usage;
  }> {
    return {
      inlineEdit: {
        status: "error",
        error: "not implemented",
        rawRequest: undefined,
      },
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  async sendMessage(
    messages: Array<ProviderMessage>,
    onText: (text: string) => void,
    _onError: (error: Error) => void,
  ): Promise<{
    toolRequests: Result<ToolManager.ToolRequest, { rawRequest: unknown }>[];
    stopReason: StopReason;
    usage: Usage;
  }> {
    try {
      const stream = (this.request = await this.client.chat.completions.create(
        this.createStreamParameters(messages),
      ));

      const toolRequests = [];
      let stopReason: StopReason | undefined;
      let lastChunk: OpenAI.ChatCompletionChunk | undefined;
      for await (const chunk of stream) {
        lastChunk = chunk;
        const choice = chunk.choices[0];
        if (choice.delta.content) {
          onText(choice.delta.content);
        }

        if (choice.delta.tool_calls) {
          toolRequests.push(...choice.delta.tool_calls);
        }

        if (choice.finish_reason) {
          switch (choice.finish_reason) {
            case "function_call":
            case "tool_calls":
              stopReason = "tool_use";
              break;
            case "length":
              stopReason = "max_tokens";
              break;
            case "stop":
              stopReason = "end_turn";
              break;
            case "content_filter":
              stopReason = "content";
              break;
            default:
              assertUnreachable(choice.finish_reason);
          }
        }
      }

      return {
        toolRequests: toolRequests
          .filter((req) => req.id)
          .map((req) => {
            const result = ((): Result<ToolManager.ToolRequest> => {
              this.nvim.logger?.debug(
                `openai function call: ${JSON.stringify(req)}`,
              );

              if (typeof req.id != "string") {
                return {
                  status: "error",
                  error: "expected req.id to be a string",
                };
              }

              const name = req.function?.name;
              if (typeof name != "string") {
                return {
                  status: "error",
                  error: "expected req.function.name to be a string",
                };
              }

              const input = ToolManager.validateToolInput(
                name,
                (req.function?.arguments
                  ? JSON.parse(req.function.arguments)
                  : {}) as {
                  [key: string]: unknown;
                },
              );

              if (input.status == "ok") {
                return {
                  status: "ok",
                  value: {
                    name: name as ToolName,
                    id: req.id as unknown as ToolRequestId,
                    input: input.value,
                  },
                };
              } else {
                return input;
              }
            })();

            return extendError(result, { rawRequest: req });
          }),
        stopReason: stopReason || "end_turn",
        usage: lastChunk?.usage
          ? {
              inputTokens: lastChunk.usage.prompt_tokens,
              outputTokens: lastChunk.usage.completion_tokens,
            }
          : {
              inputTokens: 0,
              outputTokens: 0,
            },
      };
    } finally {
      this.request = undefined;
    }
  }
}
