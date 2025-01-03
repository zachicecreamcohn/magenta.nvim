import OpenAI from "openai";
import * as ToolManager from "../tools/toolManager.ts";
import { extendError, type Result } from "../utils/result.ts";
import type { StopReason, Provider, ProviderMessage } from "./provider.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { ToolName, ToolRequestId } from "../tools/toolManager.ts";

export class OpenAIProvider implements Provider {
  private client: OpenAI;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      throw new Error("Anthropic API key not found in config or environment");
    }

    this.client = new OpenAI({
      apiKey,
    });
  }

  async sendMessage(
    messages: Array<ProviderMessage>,
    onText: (text: string) => void,
    _onError: (error: Error) => void,
  ): Promise<{
    toolRequests: Result<ToolManager.ToolRequest, { rawRequest: unknown }>[];
    stopReason: StopReason;
  }> {
    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [];

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
          openaiMessages.push({
            role: m.role,
            content: messageContent,
            tool_calls: toolCalls.length ? toolCalls : [],
          });
        }

        if (toolResponses.length) {
          openaiMessages.push(...toolResponses);
        }
      }
    }

    const stream = await this.client.chat.completions.create({
      model: "gpt-4o",
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
            parameters: s.input_schema as OpenAI.FunctionParameters,
            strict: true,
          },
        };
      }),
    });

    const toolRequests = [];
    let stopReason: StopReason | undefined;
    for await (const chunk of stream) {
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
      toolRequests: toolRequests.map((req) => {
        const result = ((): Result<ToolManager.ToolRequest> => {
          if (typeof req.id != "string") {
            return { status: "error", error: "expected req.id to be a string" };
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
            JSON.parse(req.function?.arguments || "") as {
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
    };
  }
}
