import Anthropic from "@anthropic-ai/sdk";
import * as ToolManager from "../tools/toolManager.ts";
import { extendError, type Result } from "../utils/result.ts";
import type { Nvim } from "nvim-node";
import {
  type StopReason,
  type Provider,
  type ProviderMessage,
  type Usage,
} from "./provider.ts";
import type { ToolRequestId } from "../tools/toolManager.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream.mjs";
import { DEFAULT_SYSTEM_PROMPT } from "./constants.ts";

export type MessageParam = Omit<Anthropic.MessageParam, "content"> & {
  content: Array<Anthropic.Messages.ContentBlockParam>;
};

export type AnthropicOptions = {
  model: "claude-3-5-sonnet-20241022";
};

export class AnthropicProvider implements Provider {
  private client: Anthropic;
  private request: MessageStream | undefined;

  constructor(
    private nvim: Nvim,
    private options: AnthropicOptions,
  ) {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new Error("Anthropic API key not found in config or environment");
    }

    this.client = new Anthropic({
      apiKey,
    });
  }

  abort() {
    if (this.request) {
      this.request.abort();
      this.request = undefined;
    }
  }

  async sendMessage(
    messages: Array<ProviderMessage>,
    onText: (text: string) => void,
    onError: (error: Error) => void,
  ): Promise<{
    toolRequests: Result<ToolManager.ToolRequest, { rawRequest: unknown }>[];
    stopReason: StopReason;
    usage: Usage;
  }> {
    const buf: string[] = [];
    let flushInProgress: boolean = false;

    const flushBuffer = () => {
      if (buf.length && !flushInProgress) {
        const text = buf.join("");
        buf.splice(0);

        flushInProgress = true;

        try {
          onText(text);
        } finally {
          flushInProgress = false;
          setInterval(flushBuffer, 1);
        }
      }
    };

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
        content = m.content.map((c): Anthropic.ContentBlockParam => {
          switch (c.type) {
            case "text":
              return c;
            case "tool_use":
              return {
                id: c.request.id,
                input: c.request.input,
                name: c.request.name,
                type: "tool_use",
              };
            case "tool_result":
              return {
                tool_use_id: c.id,
                type: "tool_result",
                content:
                  c.result.status == "ok" ? c.result.value : c.result.error,
                is_error: c.result.status == "error",
              };
            default:
              assertUnreachable(c);
          }
        });
      }

      return {
        role: m.role,
        content,
      };
    });

    placeCacheBreakpoints(anthropicMessages);

    const tools: Anthropic.Tool[] = ToolManager.TOOL_SPECS.map(
      (t): Anthropic.Tool => {
        return {
          ...t,
          input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
        };
      },
    );

    try {
      this.request = this.client.messages
        .stream({
          messages: anthropicMessages,
          model: this.options.model,
          max_tokens: 4096,
          system: DEFAULT_SYSTEM_PROMPT,
          tool_choice: {
            type: "auto",
            disable_parallel_tool_use: false,
          },
          tools,
        })
        .on("text", (text: string) => {
          buf.push(text);
          flushBuffer();
        })
        .on("error", onError)
        .on("inputJson", (_delta, snapshot) => {
          this.nvim.logger?.debug(
            `anthropic stream inputJson: ${JSON.stringify(snapshot)}`,
          );
        });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const response: Anthropic.Message = await this.request.finalMessage();

      if (response.stop_reason === "max_tokens") {
        onError(new Error("Response exceeded max_tokens limit"));
      }

      const toolRequests: Result<
        ToolManager.ToolRequest,
        { rawRequest: unknown }
      >[] = response.content
        .filter((req) => req.type == "tool_use")
        .map((req) => {
          const result = ((): Result<ToolManager.ToolRequest> => {
            if (typeof req != "object" || req == null) {
              return { status: "error", error: "received a non-object" };
            }

            const name = (
              req as unknown as { [key: string]: unknown } | undefined
            )?.["name"];

            if (typeof req.name != "string") {
              return {
                status: "error",
                error: "expected req.name to be string",
              };
            }

            const req2 = req as unknown as { [key: string]: unknown };

            if (req2.type != "tool_use") {
              return {
                status: "error",
                error: "expected req.type to be tool_use",
              };
            }

            if (typeof req2.id != "string") {
              return {
                status: "error",
                error: "expected req.id to be a string",
              };
            }

            if (typeof req2.input != "object" || req2.input == null) {
              return {
                status: "error",
                error: "expected req.input to be an object",
              };
            }

            const input = ToolManager.validateToolInput(
              name,
              req2.input as { [key: string]: unknown },
            );

            if (input.status == "ok") {
              return {
                status: "ok",
                value: {
                  name: name as ToolManager.ToolRequest["name"],
                  id: req2.id as unknown as ToolRequestId,
                  input: input.value,
                },
              };
            } else {
              return input;
            }
          })();

          return extendError(result, { rawRequest: req });
        });

      const usage: Usage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
      if (response.usage.cache_read_input_tokens) {
        usage.cacheHits = response.usage.cache_read_input_tokens;
      }
      if (response.usage.cache_creation_input_tokens) {
        usage.cacheMisses = response.usage.cache_creation_input_tokens;
      }

      return {
        toolRequests,
        stopReason: response.stop_reason || "end_turn",
        usage,
      };
    } finally {
      this.request = undefined;
    }
  }
}

export function placeCacheBreakpoints(messages: MessageParam[]) {
  // when we scan the messages, keep track of where each part ends.
  const blocks: { block: Anthropic.Messages.ContentBlockParam; acc: number }[] =
    [];

  let lengthAcc = 0;
  for (const message of messages) {
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          lengthAcc += block.text.length;
          break;
        case "image":
          lengthAcc += block.source.data.length;
          break;
        case "tool_use":
          lengthAcc += JSON.stringify(block.input).length;
          break;
        case "tool_result":
          if (block.content) {
            if (typeof block.content == "string") {
              lengthAcc += block.content.length;
            } else {
              let blockLength = 0;
              for (const blockContent of block.content) {
                switch (blockContent.type) {
                  case "text":
                    blockLength += blockContent.text.length;
                    break;
                  case "image":
                    blockLength += blockContent.source.data.length;
                    break;
                }
              }

              lengthAcc += blockLength;
            }
          }
          break;
        case "document":
          lengthAcc += block.source.data.length;
      }

      blocks.push({ block, acc: lengthAcc });
    }
  }

  // estimating 4 characters per token.
  const tokens = Math.floor(lengthAcc / STR_CHARS_PER_TOKEN);

  // Anthropic allows for placing up to 4 cache control markers.
  // It will not cache anythign less than 1024 tokens for sonnet 3.5
  // https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
  // this is pretty rough estimate, due to the conversion between string length and tokens.
  // however, since we are not accounting for tools or the system prompt, and generally code and technical writing
  // tend to have a lower coefficient of string length to tokens (about 3.5 average sting length per token), this means
  // that the first cache control should be past the 1024 mark and should be cached.
  const powers = highestPowersOfTwo(tokens, 4).filter((n) => n >= 1024);
  if (powers.length) {
    for (const power of powers) {
      const targetLength = power * STR_CHARS_PER_TOKEN; // power is in tokens, but we want string chars instead
      // find the first block where we are past the target power
      const blockEntry = blocks.find((b) => b.acc > targetLength);
      if (blockEntry) {
        blockEntry.block.cache_control = { type: "ephemeral" };
      }
    }
  }
}

const STR_CHARS_PER_TOKEN = 4;

export function highestPowersOfTwo(n: number, len: number): number[] {
  const result: number[] = [];
  let currentPower = Math.floor(Math.log2(n));

  while (result.length < len && currentPower >= 0) {
    const value = Math.pow(2, currentPower);
    if (value <= n) {
      result.push(value);
    }
    currentPower--;
  }
  return result;
}
