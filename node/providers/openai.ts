import OpenAI from "openai";
import { type Result } from "../utils/result.ts";
import type { ToolRequestId } from "../tools/toolManager.ts";
import type {
  StopReason,
  Provider,
  ProviderMessage,
  Usage,
  ProviderStreamRequest,
  ProviderToolSpec,
  ProviderStreamEvent,
  ProviderToolUseRequest,
  ProviderToolUseResponse,
} from "./provider-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { Stream } from "openai/streaming.mjs";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";
import { validateInput } from "../tools/helpers.ts";
import type { ToolRequest } from "../tools/types.ts";
import type {
  JSONSchemaObject,
  JSONSchemaType,
} from "openai/lib/jsonschema.mjs";

export type OpenAIOptions = {
  model: "gpt-4o";
};

export class OpenAIProvider implements Provider {
  private client: OpenAI;

  constructor(
    _nvim: Nvim,
    options?: {
      baseUrl?: string | undefined;
      apiKeyEnvVar?: string | undefined;
    },
  ) {
    const apiKeyEnvVar = options?.apiKeyEnvVar || "OPENAI_API_KEY";
    const apiKey = process.env[apiKeyEnvVar];

    if (!apiKey) {
      throw new Error(`${apiKeyEnvVar} not found in environment`);
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: options?.baseUrl || process.env.OPENAI_BASE_URL,
    });
  }

  /**
   * Makes a tool spec compatible with OpenAI by ensuring required properties and removing unsupported formats
   */
  private makeOpenAICompatible(spec: ProviderToolSpec): ProviderToolSpec {
    const schema = spec.input_schema;

    // First apply format sanitization
    const sanitizedSchema = this.sanitizeSchemaForOpenAI(schema);

    // Then apply OpenAI-specific requirements
    if (
      typeof sanitizedSchema !== "object" ||
      sanitizedSchema === null ||
      Array.isArray(sanitizedSchema) ||
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      (sanitizedSchema as any).type !== "object"
    ) {
      return { ...spec, input_schema: sanitizedSchema };
    }

    // copy to avoid mutating the underlying spec
    const compatibleSchema = JSON.parse(
      JSON.stringify(sanitizedSchema),
    ) as JSONSchemaObject;

    compatibleSchema.additionalProperties = false;

    if (
      compatibleSchema.properties &&
      typeof compatibleSchema.properties === "object"
    ) {
      const propertyNames = Object.keys(compatibleSchema.properties);
      compatibleSchema.required = propertyNames;
    } else {
      compatibleSchema.required = [];
    }

    return {
      ...spec,
      input_schema: compatibleSchema,
    };
  }

  /**
   * Sanitizes JSON Schema for OpenAI compatibility by removing unsupported format specifiers
   * OpenAI doesn't support formats like "uri", "date-time", etc.
   */
  private sanitizeSchemaForOpenAI(schema: JSONSchemaType): JSONSchemaType {
    if (
      typeof schema !== "object" ||
      schema === null ||
      Array.isArray(schema)
    ) {
      return schema;
    }

    const sanitized = { ...schema };

    // Remove unsupported format specifiers
    if ("format" in sanitized && sanitized.format) {
      const unsupportedFormats = [
        "uri",
        "uri-reference",
        "uri-template",
        "date-time",
        "date",
        "time",
        "email",
        "hostname",
        "ipv4",
        "ipv6",
        "uuid",
        "regex",
        "json-pointer",
      ];

      if (unsupportedFormats.includes(sanitized.format as string)) {
        delete sanitized.format;
        // Add a description hint if not already present
        if (!("description" in sanitized) || !sanitized.description) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
          switch ((schema as any).format) {
            case "uri":
            case "uri-reference":
              sanitized.description = "A valid URI string";
              break;
            case "date-time":
              sanitized.description =
                'A date-time string (e.g., "2023-12-01T10:30:00Z")';
              break;
            case "date":
              sanitized.description = 'A date string (e.g., "2023-12-01")';
              break;
            case "email":
              sanitized.description = "A valid email address";
              break;
            default:
              sanitized.description = `A string in ${JSON.stringify(schema.format)} format`;
          }
        }
      }
    }

    // Recursively sanitize nested objects
    for (const [key, value] of Object.entries(sanitized)) {
      if (key !== "format" && typeof value === "object" && value !== null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
        (sanitized as any)[key] = this.sanitizeSchemaForOpenAI(value);
      }
    }

    return sanitized;
  }

  createStreamParameters(options: {
    model: string;
    messages: Array<ProviderMessage>;
    tools: Array<ProviderToolSpec>;
    disableCaching?: boolean;
    systemPrompt?: string;
  }): OpenAI.Responses.ResponseCreateParamsStreaming {
    const { model, messages, tools, systemPrompt } = options;
    const openaiMessages: OpenAI.Responses.ResponseInputItem[] = [
      {
        role: "system",
        content: systemPrompt || DEFAULT_SYSTEM_PROMPT,
      },
    ];

    let inProgressMessage:
      | OpenAI.Responses.ResponseInputItem.Message
      | OpenAI.Responses.ResponseOutputMessage
      | undefined;

    const flushInProgressMessage = () => {
      if (inProgressMessage && inProgressMessage.content.length > 0) {
        openaiMessages.push(inProgressMessage);
      }
      inProgressMessage = undefined;
    };

    const pushUserContent = (
      content: OpenAI.Responses.ResponseInputContent,
    ) => {
      if (!inProgressMessage || inProgressMessage.role !== "user") {
        flushInProgressMessage();
        inProgressMessage = { role: "user", content: [] };
      }
      inProgressMessage.content.push(content);
    };

    const pushAssistantContent = (
      content: OpenAI.Responses.ResponseOutputText,
    ) => {
      if (!inProgressMessage || inProgressMessage.role !== "assistant") {
        flushInProgressMessage();
        inProgressMessage = {
          id: "id",
          role: "assistant",
          content: [],
          status: "completed",
          type: "message",
        };
      }
      inProgressMessage.content.push(content);
    };

    const pushMessage = (message: OpenAI.Responses.ResponseInputItem) => {
      flushInProgressMessage();
      openaiMessages.push(message);
    };

    for (const m of messages) {
      for (const content of m.content) {
        switch (content.type) {
          case "text":
            if (content.text.trim()) {
              if (m.role === "user") {
                pushUserContent({
                  type: "input_text",
                  text: content.text,
                });
              } else if (m.role === "assistant") {
                const annotations: OpenAI.Responses.ResponseOutputText.URLCitation[] =
                  (content.citations || []).map(
                    (c): OpenAI.Responses.ResponseOutputText.URLCitation => {
                      return {
                        end_index: content.text.length - 1,
                        start_index: content.text.length - 1,
                        title: c.title,
                        type: "url_citation",
                        url: c.url,
                      };
                    },
                  );

                pushAssistantContent({
                  type: "output_text",
                  text: content.text,
                  annotations,
                });
              }
            }
            break;

          case "image":
            if (m.role === "user") {
              pushUserContent({
                type: "input_image",
                image_url: `data:${content.source.media_type};base64,${content.source.data}`,
                detail: "auto",
              });
            }
            // Images are unsupported for assistant messages
            break;

          case "document":
            if (m.role === "user") {
              pushUserContent({
                type: "input_file",
                filename: content.title || "untitled pdf",
                file_data: `data:${content.source.media_type};base64,${content.source.data}`,
              });
            }
            // Documents are unsupported for assistant messages
            break;

          case "tool_use":
            pushMessage(
              content.request.status == "ok"
                ? {
                    type: "function_call",
                    call_id: content.id,
                    name: content.name,
                    arguments: JSON.stringify(content.request.value.input),
                  }
                : {
                    type: "function_call",
                    call_id: content.id,
                    name: content.name,
                    arguments: JSON.stringify(content.request.rawRequest),
                  },
            );
            break;

          case "server_tool_use":
            if (content.name == "web_search") {
              pushMessage({
                type: "web_search_call",
                id: content.id,
                status: "completed",
              });
            }
            break;

          case "web_search_tool_result":
            if (Array.isArray(content.content)) {
              const searchResults = content.content
                .map(
                  (result) =>
                    `Title: ${result.title}\nURL: ${result.url}\nContent: ${result.encrypted_content}`,
                )
                .join("\n\n");

              pushUserContent({
                type: "input_text",
                text: `Web search results:\n\n${searchResults}`,
              });
            }
            break;

          case "tool_result":
            if (content.result.status == "ok") {
              const value = content.result.value;
              for (const toolResult of value) {
                switch (toolResult.type) {
                  case "text":
                    pushMessage({
                      type: "function_call_output",
                      call_id: content.id,
                      output: toolResult.text,
                    });
                    break;
                  case "image":
                    pushMessage({
                      type: "function_call_output",
                      call_id: content.id,
                      output: "Image content follows:",
                    });
                    pushMessage({
                      role: "user",
                      content: [
                        {
                          type: "input_image",
                          image_url: `data:${toolResult.source.media_type};base64,${toolResult.source.data}`,
                          detail: "auto",
                        },
                      ],
                    });
                    break;
                  case "document":
                    pushMessage({
                      type: "function_call_output",
                      call_id: content.id,
                      output: "Document content follows:",
                    });
                    pushMessage({
                      role: "user",
                      content: [
                        {
                          type: "input_file",
                          filename: toolResult.title || "untitled.pdf",
                          file_data: `data:${toolResult.source.media_type};base64,${toolResult.source.data}`,
                        },
                      ],
                    });
                    break;
                  default:
                    assertUnreachable(toolResult);
                }
              }
            } else {
              pushMessage({
                type: "function_call_output",
                call_id: content.id,
                output: content.result.error,
              });
            }
            break;
          case "thinking":
            // Thinking content is typically internal and not sent to the model
            break;

          case "redacted_thinking":
            // Redacted thinking content is also internal and not sent to the model
            break;

          default:
            assertUnreachable(content);
        }
      }

      // Flush any remaining in-progress message for this provider message
      flushInProgressMessage();
    }

    return {
      model,
      stream: true,
      input: openaiMessages,
      // see https://platform.openai.com/docs/guides/function-calling#parallel-function-calling-and-structured-outputs
      // this recommends disabling parallel tool calls when strict adherence to schema is needed
      parallel_tool_calls: false,
      tools: [
        ...tools.map((s): OpenAI.Responses.Tool => {
          const compatibleSpec = this.makeOpenAICompatible(s);
          return {
            type: "function",
            name: compatibleSpec.name,
            description: compatibleSpec.description,
            strict: true,
            parameters:
              compatibleSpec.input_schema as OpenAI.FunctionParameters,
          };
        }),
      ],
    };
  }

  forceToolUse(options: {
    model: string;
    messages: Array<ProviderMessage>;
    spec: ProviderToolSpec;
    systemPrompt?: string;
  }): ProviderToolUseRequest {
    const { model, messages, spec, systemPrompt } = options;
    let aborted = false;
    const promise = (async (): Promise<ProviderToolUseResponse> => {
      const params = this.createStreamParameters({
        model,
        messages,
        tools: [spec],
        ...(systemPrompt && { systemPrompt }),
      });
      const response = await this.client.responses.create({
        ...params,
        tool_choice: "required",
        stream: false,
        tools: [
          {
            type: "function",
            name: spec.name,
            description: spec.description,
            strict: true,
            parameters: this.makeOpenAICompatible(spec)
              .input_schema as OpenAI.FunctionParameters,
          },
        ],
      });

      const tool = response.output[0];
      let toolRequest: Result<ToolRequest, { rawRequest: unknown }>;
      try {
        if (!(tool && tool.type == "function_call")) {
          throw new Error(
            `Failed to respond with tool call of type 'function'.`,
          );
        }
        if (tool.name !== spec.name) {
          throw new Error(`expected tool name to be '${spec.name}'`);
        }

        const input = validateInput(
          spec.name,
          JSON.parse(tool.arguments || "{}") as { [key: string]: unknown },
        );

        toolRequest =
          input.status === "ok"
            ? {
                status: "ok" as const,
                value: {
                  toolName: tool.name,
                  id: tool.call_id as unknown as ToolRequestId,
                  input: input.value,
                } as ToolRequest,
              }
            : { ...input, rawRequest: tool.arguments };
      } catch (error) {
        toolRequest = {
          status: "error",
          error: (error as Error).message,
          rawRequest: tool,
        };
      }

      const usage: Usage = response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          }
        : {
            inputTokens: 0,
            outputTokens: 0,
          };

      if (aborted) {
        throw new Error(`Aborted`);
      }

      return {
        toolRequest,
        stopReason: "tool_use" as const,
        usage,
      };
    })();

    return {
      abort: () => {
        aborted = true;
      },
      promise,
    };
  }

  sendMessage(options: {
    model: string;
    messages: Array<ProviderMessage>;
    onStreamEvent: (event: ProviderStreamEvent) => void;
    tools: Array<ProviderToolSpec>;
    systemPrompt?: string;
    thinking?: {
      enabled: boolean;
      budgetTokens?: number;
    };
  }): ProviderStreamRequest {
    const { model, messages, onStreamEvent, tools, systemPrompt } = options;
    let request: Stream<OpenAI.Responses.ResponseStreamEvent>;
    let stopReason: StopReason | undefined;
    let usage: Usage | undefined;

    const promise = (async (): Promise<{
      usage: Usage;
      stopReason: StopReason;
    }> => {
      const params = this.createStreamParameters({
        model,
        messages,
        tools,
        ...(systemPrompt && { systemPrompt }),
      });
      params.tools!.push({ type: "web_search_preview" });
      request = await this.client.responses.create(params);

      for await (const event of request) {
        switch (event.type) {
          case "response.output_item.added":
            switch (event.item.type) {
              case "message":
                onStreamEvent({
                  type: "content_block_start",
                  index: event.output_index,
                  content_block: {
                    type: "text",
                    text: "",
                    citations: null,
                  },
                });
                break;
              case "function_call":
                onStreamEvent({
                  type: "content_block_start",
                  index: event.output_index,
                  content_block: {
                    type: "tool_use",
                    id: event.item.call_id,
                    name: event.item.name,
                    input: {},
                  },
                });
                break;
              case "web_search_call":
                onStreamEvent({
                  type: "content_block_start",
                  index: event.output_index,
                  content_block: {
                    type: "server_tool_use",
                    id: event.item.id,
                    name: "web_search",
                    input: undefined,
                  },
                });
                break;
              default:
                throw new Error(
                  `output_item.added ${event.item.type} not implemented`,
                );
            }
            break;

          case "response.output_text.delta":
            onStreamEvent({
              type: "content_block_delta",
              index: event.output_index,
              delta: {
                type: "text_delta",
                text: event.delta,
              },
            });
            break;

          case "response.function_call_arguments.delta":
            onStreamEvent({
              type: "content_block_delta",
              index: event.output_index,
              delta: {
                type: "input_json_delta",
                partial_json: event.delta,
              },
            });
            break;

          case "response.output_item.done":
            if (event.item.type === "function_call") {
              stopReason = "tool_use";
            }
            onStreamEvent({
              type: "content_block_stop",
              index: event.output_index,
            });
            break;

          case "response.web_search_call.in_progress":
          case "response.web_search_call.searching":
          case "response.web_search_call.completed":
            // These events don't need to trigger any UI updates
            // The web search results will come through as tool results later
            break;

          case "response.completed":
            stopReason = "end_turn";
            usage = event.response.usage && {
              inputTokens: event.response.usage.input_tokens,
              outputTokens: event.response.usage.output_tokens,
            };
            break;
        }
      }

      return {
        stopReason: stopReason || "end_turn",
        usage: usage || {
          inputTokens: 0,
          outputTokens: 0,
        },
      };
    })();

    return {
      abort: () => {
        request?.controller.abort();
      },
      promise,
    };
  }
}
