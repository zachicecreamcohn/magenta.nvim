import Anthropic from "@anthropic-ai/sdk";
import { extendError, type Result } from "../utils/result.ts";
import type { ToolRequestId } from "../tools/toolManager.ts";
import type { Nvim } from "../nvim/nvim-node";
import {
  type Provider,
  type ProviderMessage,
  type Usage,
  type ProviderStreamRequest,
  type ProviderToolSpec,
  type ProviderToolUseRequest,
  type ProviderStreamEvent,
  type ProviderTextContent,
} from "./provider-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";
import { validateInput } from "../tools/helpers.ts";
import type { ToolRequest } from "../tools/types.ts";
import * as AnthropicAuth from "../auth/anthropic.ts";
import open from "open";

function mapProviderTextToAnthropicText(
  providerText: ProviderTextContent,
): Anthropic.Messages.TextBlockParam {
  return {
    ...providerText,
    citations: providerText.citations
      ? providerText.citations.map((providerCitation) => ({
          ...providerCitation,
          type: "web_search_result_location",
        }))
      : null,
  };
}

export type MessageParam = Omit<Anthropic.MessageParam, "content"> & {
  content: Array<Anthropic.Messages.ContentBlockParam>;
};

// Bedrock does not support the disable_parallel_tool_use flag
// Force accept undefined as the value to be able to unset it when using it
type MessageStreamParams = Omit<
  Anthropic.Messages.MessageStreamParams,
  "tool_choice"
> & {
  tool_choice: Omit<
    Anthropic.Messages.ToolChoice,
    "disable_parallel_tool_use"
  > & {
    disable_parallel_tool_use: boolean | undefined;
  };
};

export class AnthropicProvider implements Provider {
  protected client: Anthropic;
  private authType: "key" | "max";

  constructor(
    protected nvim: Nvim,
    options?: {
      baseUrl?: string | undefined;
      apiKeyEnvVar?: string | undefined;
      authType?: "key" | "max" | undefined;
      awsAPIKey?: boolean | undefined;
      promptCaching?: boolean | undefined;
      disableParallelToolUseFlag?: boolean;
    },
  ) {
    this.authType = options?.authType || "key";

    if (this.authType === "max") {
      // For max auth, we'll use a dummy API key and override fetch
      this.client = new Anthropic({
        apiKey: "dummy-key-for-oauth",
        baseURL: options?.baseUrl,
        fetch: this.createOAuthFetch(),
      });
    } else {
      const apiKeyEnvVar = options?.apiKeyEnvVar || "ANTHROPIC_API_KEY";
      const apiKey = process.env[apiKeyEnvVar];

      if (!options?.awsAPIKey && !apiKey) {
        throw new Error(
          `Anthropic API key ${apiKeyEnvVar} not found in environment`,
        );
      }

      this.client = new Anthropic({
        apiKey,
        baseURL: options?.baseUrl,
      });
    }
  }

  private promptCaching = true;
  private disableParallelToolUseFlag = true;

  private createOAuthFetch() {
    return async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      await this.ensureValidToken();

      const accessToken = await AnthropicAuth.getAccessToken();
      if (!accessToken) {
        throw new Error("Failed to get valid OAuth access token");
      }

      const headers = {
        ...init?.headers,
        authorization: `Bearer ${accessToken}`,
        "anthropic-beta":
          "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
      };

      // Remove x-api-key header if present
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      delete (headers as any)["x-api-key"];

      return fetch(input, {
        ...init,
        headers,
      });
    };
  }

  private async ensureValidToken(): Promise<void> {
    const isAuthenticated = await AnthropicAuth.isAuthenticated();
    if (!isAuthenticated) {
      await this.triggerOAuthFlow();
    }
  }

  private async triggerOAuthFlow(): Promise<void> {
    try {
      const { url, verifier } = await AnthropicAuth.authorize();

      // Show OAuth flow instructions in a floating window and get the auth code
      const code = await this.showOAuthFlow(url);

      // Exchange code for tokens
      const tokens = await AnthropicAuth.exchange(code, verifier);
      await AnthropicAuth.storeTokens(tokens);

      this.nvim.logger.info("OAuth authentication successful");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.nvim.logger.error(`OAuth authentication failed: ${message}`);
      throw new Error(`OAuth authentication failed: ${message}`);
    }
  }

  private async showOAuthFlow(authUrl: string): Promise<string> {
    try {
      await open(authUrl);
    } catch {
      this.nvim.logger.warn(
        "Could not automatically open browser, please open URL manually",
      );
    }

    // Use nvim_exec_lua to show notification and get input
    const luaScript = `
      vim.notify(
        "Claude Max Authentication Required\\n\\nThe browser should open automatically. If not, open this URL:\\n${authUrl}\\n\\nAfter completing the authorization process, copy the authorization code and paste it below.",
        vim.log.levels.INFO
      )
      return vim.fn.input("Enter authorization code: ")
    `;

    const code = await this.nvim.call("nvim_exec_lua", [luaScript, []]);

    if (!code || typeof code !== "string" || code.trim() === "") {
      throw new Error("No authorization code provided");
    }

    return code.trim();
  }

  private getMaxTokensForModel(model: string): number {
    // Claude 4 models - use high limits
    if (model.match(/^claude-(opus-4|sonnet-4|4-opus|4-sonnet)/)) {
      return 32000;
    }

    // Claude 3.7 Sonnet - supports up to 128k with beta header
    if (model.match(/^claude-3-7-sonnet/)) {
      return 32000; // Conservative default, can be increased to 128k with beta header
    }

    // Claude 3.5 Sonnet - 8k limit
    if (model.match(/^claude-3-5-sonnet/)) {
      return 8192;
    }

    // Claude 3.5 Haiku - 8k limit (same as Sonnet)
    if (model.match(/^claude-3-5-haiku/)) {
      return 8192;
    }

    // Legacy Claude 3 models (Opus, Sonnet, Haiku) - 4k limit
    if (model.match(/^claude-3-(opus|sonnet|haiku)/)) {
      return 4096;
    }

    // Legacy Claude 2.x models - 4k limit
    if (model.match(/^claude-2\./)) {
      return 4096;
    }

    // Default for unknown models - conservative 4k limit
    return 4096;
  }

  createStreamParameters({
    model,
    messages,
    tools,
    disableCaching,
    systemPrompt,
    thinking,
  }: {
    model: string;
    messages: ProviderMessage[];
    tools: Array<ProviderToolSpec>;
    disableCaching?: boolean | undefined;
    systemPrompt?: string | undefined;
    thinking?: {
      enabled: boolean;
      budgetTokens?: number;
    };
  }): MessageStreamParams {
    const anthropicMessages = messages.map((m): MessageParam => {
      let content: Anthropic.Messages.ContentBlockParam[];
      if (typeof m.content == "string") {
        content = [
          {
            type: "text",
            text: m.content,
          },
        ];
      } else {
        content = [];
        for (const c of m.content) {
          switch (c.type) {
            case "text":
              // important to create a new object here so when we attach ephemeral
              // cache_control markers we won't mutate the content.
              content.push(mapProviderTextToAnthropicText(c));
              break;

            case "web_search_tool_result":
              content.push({
                ...c,
              });
              break;

            case "tool_use":
              content.push(
                c.request.status == "ok"
                  ? {
                      id: c.id,
                      input: c.request.value.input,
                      name: c.request.value.toolName,
                      type: "tool_use",
                    }
                  : {
                      id: c.id,
                      input: c.request.rawRequest,
                      name: c.name,
                      type: "tool_use",
                    },
              );
              break;

            case "server_tool_use":
              content.push({
                type: "server_tool_use",
                id: c.id,
                name: c.name,
                input: c.input,
              });
              break;

            case "tool_result":
              if (c.result.status == "ok") {
                // Collect all contents into one array
                const allContents: Array<
                  | Anthropic.Messages.TextBlockParam
                  | Anthropic.Messages.ImageBlockParam
                > = [];
                let hasDocument = false;

                for (const resultContent of c.result.value) {
                  switch (resultContent.type) {
                    case "text":
                      allContents.push(
                        mapProviderTextToAnthropicText(resultContent),
                      );
                      break;
                    case "image":
                      allContents.push(resultContent);
                      break;
                    case "document":
                      hasDocument = true;
                      // Documents need special handling, so don't add them to the array yet
                      break;
                    default:
                      assertUnreachable(resultContent);
                  }
                }

                // If no documents are included, create a single tool_result block
                if (!hasDocument) {
                  content.push({
                    tool_use_id: c.id,
                    type: "tool_result",
                    content: allContents,
                    is_error: false,
                  });
                } else {
                  // If documents are included, maintain the special processing for them
                  // Documents require special handling
                  for (const resultContent of c.result.value) {
                    if (resultContent.type === "document") {
                      content.push({
                        tool_use_id: c.id,
                        type: "tool_result",
                        content: "Document content follows:",
                        is_error: false,
                      });
                      content.push({
                        type: "document",
                        source: resultContent.source,
                        title: resultContent.title || null,
                      });
                    }
                  }

                  // If there are text and images, put them in a separate tool_result block
                  if (allContents.length > 0) {
                    content.push({
                      tool_use_id: c.id,
                      type: "tool_result",
                      content: allContents,
                      is_error: false,
                    });
                  }
                }
              } else {
                content.push({
                  tool_use_id: c.id,
                  type: "tool_result",
                  content: c.result.error,
                  is_error: true,
                });
              }
              break;

            case "image":
              content.push({
                type: "image",
                source: c.source,
              });
              break;

            case "document":
              content.push({
                type: "document",
                source: c.source,
                title: c.title || null,
              });
              break;

            case "thinking":
              content.push({
                type: "thinking",
                thinking: c.thinking,
                signature: c.signature,
              });
              break;

            case "redacted_thinking":
              content.push({
                type: "redacted_thinking",
                data: c.data,
              });
              break;

            default:
              assertUnreachable(c);
          }
        }
      }

      return {
        role: m.role,
        content,
      };
    });

    // Use the promptCaching class property but allow it to be overridden by options parameter
    const useCaching = disableCaching !== true && this.promptCaching;

    if (useCaching) {
      placeCacheBreakpoints(anthropicMessages);
    }

    const anthropicTools: Anthropic.Tool[] = tools.map((t): Anthropic.Tool => {
      return {
        ...t,
        input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
      };
    });

    const params: MessageStreamParams = {
      messages: anthropicMessages,
      model: model,
      max_tokens: this.getMaxTokensForModel(model),
      system: [
        {
          type: "text",
          text: systemPrompt ? systemPrompt : DEFAULT_SYSTEM_PROMPT,
          // the prompt appears in the following order:
          // tools
          // system
          // messages
          // This ensures the tools + system prompt (which is approx 1400 tokens) is cached.
          cache_control: useCaching ? { type: "ephemeral" } : null,
        },
      ],
      tool_choice: {
        type: "auto",
        disable_parallel_tool_use: this.disableParallelToolUseFlag || undefined,
      },
      tools: [
        ...anthropicTools,
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 5,
        } as unknown as Anthropic.Messages.Tool,
      ],
    };

    // Add thinking configuration if enabled
    if (thinking?.enabled) {
      params.thinking = {
        type: "enabled",
        budget_tokens: thinking.budgetTokens || 1024,
      };
    }

    return params;
  }

  forceToolUse(options: {
    model: string;
    messages: Array<ProviderMessage>;
    spec: ProviderToolSpec;
    systemPrompt?: string;
    disableCaching?: boolean;
  }): ProviderToolUseRequest {
    const { model, messages, spec, systemPrompt, disableCaching } = options;
    let aborted = false;

    const request = this.client.messages.stream({
      ...this.createStreamParameters({
        model,
        messages,
        tools: [],
        disableCaching,
        systemPrompt,
      }),
      tools: [
        {
          ...spec,
          input_schema:
            spec.input_schema as Anthropic.Messages.Tool.InputSchema,
        },
      ],
      tool_choice: {
        type: "tool",
        name: spec.name,
        disable_parallel_tool_use: this.disableParallelToolUseFlag,
      },
    });

    const promise = (async () => {
      const response: Anthropic.Message = await request.finalMessage();

      if (response.stop_reason === "max_tokens") {
        throw new Error("Response exceeded max_tokens limit");
      }

      if (response.content.length != 1) {
        throw new Error(
          `Expected a single response but got ${response.content.length}`,
        );
      }

      const contentBlock = response.content[0];

      const toolRequest = extendError(
        ((): Result<ToolRequest> => {
          if (contentBlock.type != "tool_use") {
            throw new Error(
              `Expected a tool_use response but got ${response.type}`,
            );
          }

          if (typeof contentBlock != "object" || contentBlock == null) {
            return { status: "error", error: "received a non-object" };
          }

          const name = (
            contentBlock as unknown as { [key: string]: unknown } | undefined
          )?.["name"];

          if (name != spec.name) {
            return {
              status: "error",
              error: `expected contentBlock.name to be '${spec.name}'`,
            };
          }

          const req2 = contentBlock as unknown as { [key: string]: unknown };

          if (req2.type != "tool_use") {
            return {
              status: "error",
              error: "expected contentBlock.type to be tool_use",
            };
          }

          if (typeof req2.id != "string") {
            return {
              status: "error",
              error: "expected contentBlock.id to be a string",
            };
          }

          if (typeof req2.input != "object" || req2.input == null) {
            return {
              status: "error",
              error: "expected contentBlock.input to be an object",
            };
          }

          const input = validateInput(
            spec.name,
            req2.input as { [key: string]: unknown },
          );

          if (input.status == "ok") {
            return {
              status: "ok",
              value: {
                toolName: spec.name,
                id: req2.id as unknown as ToolRequestId,
                input: input.value,
              } as ToolRequest,
            };
          } else {
            return input;
          }
        })(),
        { rawRequest: contentBlock },
      );

      const usage: Usage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
      if (response.usage.cache_read_input_tokens != undefined) {
        usage.cacheHits = response.usage.cache_read_input_tokens;
      }
      if (response.usage.cache_creation_input_tokens != undefined) {
        usage.cacheMisses = response.usage.cache_creation_input_tokens;
      }

      return {
        toolRequest,
        stopReason: response.stop_reason || "end_turn",
        usage,
      };
    })();

    return {
      promise,
      aborted,
      abort: () => {
        aborted = true;
        request.abort();
      },
    };
  }

  /**
   * Example of stream events from anthropic https://docs.anthropic.com/en/api/messages-streaming
   */
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
    const { model, messages, onStreamEvent, tools, systemPrompt, thinking } =
      options;
    let aborted = false;

    const request = this.client.messages
      .stream(
        this.createStreamParameters({
          model,
          messages,
          tools,
          systemPrompt,
          ...(thinking && { thinking }),
        }) as Anthropic.Messages.MessageStreamParams,
      )
      .on("streamEvent", (e) => {
        if (
          e.type == "content_block_start" ||
          e.type == "content_block_delta" ||
          e.type == "content_block_stop"
        ) {
          onStreamEvent(e);
        }
      });

    const promise = (async () => {
      const response: Anthropic.Message = await request.finalMessage();

      if (response.stop_reason === "max_tokens") {
        throw new Error("Response exceeded max_tokens limit");
      }

      const usage: Usage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
      if (response.usage.cache_read_input_tokens != undefined) {
        usage.cacheHits = response.usage.cache_read_input_tokens;
      }
      if (response.usage.cache_creation_input_tokens != undefined) {
        usage.cacheMisses = response.usage.cache_creation_input_tokens;
      }

      return {
        stopReason: response.stop_reason || "end_turn",
        usage,
      };
    })();

    return {
      abort: () => {
        aborted = true;
        request.abort();
      },
      aborted,
      promise,
    };
  }
}

/** We only ever need to place a cache header on the last block, since anthropic now can compute the longest reusable
 * prefix.
 * https://www.anthropic.com/news/token-saving-updates
 */
export function placeCacheBreakpoints(messages: MessageParam[]): void {
  if (messages.length === 0) {
    return;
  }

  // Find the last eligible block by searching backwards through messages
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex--
  ) {
    const message = messages[messageIndex];

    for (
      let blockIndex = message.content.length - 1;
      blockIndex >= 0;
      blockIndex--
    ) {
      const block = message.content[blockIndex];

      // Check if this block is eligible for caching
      if (
        block &&
        block.type !== "thinking" &&
        block.type !== "redacted_thinking"
      ) {
        block.cache_control = { type: "ephemeral" };
        return;
      }
    }
  }
}
