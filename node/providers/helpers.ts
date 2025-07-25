import type { WebSearchResultBlock } from "@anthropic-ai/sdk/resources.mjs";
import { validateInput } from "../tools/helpers";
import type { ToolManager, ToolRequestId } from "../tools/toolManager";
import { assertUnreachable } from "../utils/assertUnreachable";
import type {
  ProviderBlockStartEvent,
  ProviderMessageContent,
  ProviderServerToolUseContent,
  ProviderStreamEvent,
  ProviderTextContent,
  ProviderImageContent,
  ProviderDocumentContent,
  ProviderMetadata,
} from "./provider-types";
import type { ToolName } from "../tools/types";

export function renderContentValue(
  value:
    | string
    | ProviderTextContent
    | ProviderImageContent
    | ProviderDocumentContent,
): string {
  if (typeof value === "string") {
    return value;
  }

  switch (value.type) {
    case "text":
      return value.text;
    case "image":
      return `📷 [Image: ${value.source.media_type}]`;
    case "document":
      return `📄 [Document: ${value.source.media_type}${value.title ? ` - ${value.title}` : ""}]`;
    default:
      assertUnreachable(value);
  }
}

export type StreamingBlock = ProviderBlockStartEvent["content_block"] & {
  streamed: string;
  providerMetadata?: ProviderMetadata | undefined;
};

type ProviderStreamDeltaEvent = Extract<
  ProviderStreamEvent,
  { type: "content_block_delta" }
>;

export function applyDelta(
  block: StreamingBlock,
  event: ProviderStreamDeltaEvent,
) {
  switch (event.delta.type) {
    case "text_delta":
      block.streamed += event.delta.text;
      break;
    case "input_json_delta":
      block.streamed += event.delta.partial_json;
      break;
    case "citations_delta": {
      if (block.type != "text") {
        throw new Error(`Unexpected citations_delta update to non-text block.`);
      }
      if (!block.citations) {
        block.citations = [];
      }
      block.citations.push(event.delta.citation);
      break;
    }
    case "thinking_delta":
      if (block.type != "thinking") {
        throw new Error(
          `Unexpected thinking_delta update to non-thinking block.`,
        );
      }
      block.thinking = (block.thinking || "") + event.delta.thinking;
      break;
    case "signature_delta":
      if (block.type != "thinking") {
        throw new Error(
          `Unexpected signature_delta update to non-thinking block.`,
        );
      }
      // TypeScript now knows block is a thinking block due to the discriminated union
      block.signature = (block.signature || "") + event.delta.signature;
      break;
    default:
      assertUnreachable(event.delta);
  }
}

export function stringifyContent(
  content: ProviderMessageContent,
  toolManager: ToolManager,
): string {
  switch (content.type) {
    case "text": {
      let textContent = content.text;

      // Include citations if they exist
      if (content.citations && content.citations.length > 0) {
        textContent += "\n\nCitations:";
        content.citations.forEach((citation) => {
          textContent += `\n- [${citation.title}](${citation.url})`;
          if (citation.cited_text) {
            textContent += `\n  "${citation.cited_text}"`;
          }
        });
      }
      return textContent;
    }

    case "tool_use":
      return `Tool use for tool ${content.name}: ${JSON.stringify(content.request.status === "ok" ? content.request.value.input : content.request.rawRequest, null, 2)}`;

    case "server_tool_use":
      switch (content.name) {
        case "web_search":
          return `Search : ${content.input.query}`;
        default:
          return assertUnreachable(content);
      }

    case "web_search_tool_result":
      if (
        "type" in content.content &&
        content.content.type === "web_search_tool_result_error"
      ) {
        return `Web search error: ${content.content.error_code}`;
      } else {
        const results = content.content as Array<WebSearchResultBlock>;
        return `Web search results:\n${results
          .map((result) => `- [${result.title || "No Title"}](${result.url})`)
          .join("\n")}`;
      }

    case "tool_result": {
      if (content.result.status == "ok") {
        const result = content.result.value;
        const tool = toolManager.getTool(content.id);

        const formatResult = (contents: typeof result): string => {
          return contents
            .map((r) => stringifyContent(r, toolManager))
            .join("\n");
        };

        if (!tool) {
          return `Tool result:\n${formatResult(result)}`;
        }

        return `Tool result for tool ${tool.toolName}:\n${formatResult(result)}`;
      } else {
        return `Tool result error: ${content.result.error}`;
      }
    }

    case "image":
      return `[Image: ${content.source.media_type}]`;

    case "document":
      return `[Document: ${content.source.media_type}${content.title ? ` - ${content.title}` : ""}]`;

    case "thinking":
      return `[Thinking]\n${content.thinking}`;

    case "redacted_thinking":
      return `[Redacted Thinking]`;

    default:
      assertUnreachable(content);
  }
}

export function finalizeStreamingBlock(
  block: StreamingBlock,
): ProviderMessageContent {
  switch (block.type) {
    case "text": {
      return {
        type: "text",
        text: block.streamed,
        citations: block.citations
          ? block.citations
              .filter((c) => c.type == "web_search_result_location")
              .map((c) => ({
                type: "web_search_citation",
                cited_text: c.cited_text,
                encrypted_index: c.encrypted_index,
                title: c.title || "[No Title]",
                url: c.url,
              }))
          : undefined,
        ...(block.providerMetadata && {
          providerMetadata: block.providerMetadata,
        }),
      };
    }
    case "tool_use": {
      let inputParseResult: ReturnType<typeof validateInput> = {
        status: "error",
        error: "",
      };

      let input: unknown;
      try {
        input = block.streamed.length ? JSON.parse(block.streamed) : {};
        if (typeof input != "object") {
          throw new Error(`Expected input to be an object`);
        }
        inputParseResult = validateInput(
          block.name,
          input as { [key: string]: unknown },
        );
      } catch (error) {
        inputParseResult = {
          status: "error",
          error:
            error instanceof Error
              ? error.message + "\n" + error.stack
              : JSON.stringify(error),
        };
      }
      return {
        type: "tool_use",
        id: block.id as ToolRequestId,
        name: block.name as ToolName,
        request:
          inputParseResult.status == "ok"
            ? {
                status: "ok",
                value: {
                  id: block.id as ToolRequestId,
                  toolName: block.name as ToolName,
                  input: inputParseResult.value,
                },
              }
            : {
                ...inputParseResult,
                rawRequest: input
                  ? input
                  : {
                      streamed_json: block.streamed,
                    },
              },
        ...(block.providerMetadata && {
          providerMetadata: block.providerMetadata,
        }),
      };
    }
    case "server_tool_use": {
      return {
        type: "server_tool_use",
        id: block.id,
        name: block.name,
        input: block.streamed.length
          ? (JSON.parse(
              block.streamed,
            ) as ProviderServerToolUseContent["input"])
          : { query: "" },
        ...(block.providerMetadata && {
          providerMetadata: block.providerMetadata,
        }),
      };
    }
    case "web_search_tool_result": {
      return {
        type: "web_search_tool_result",
        tool_use_id: block.tool_use_id,
        // it seems that all results are going to be given in the initial block_start event
        // https://docs.anthropic.com/en/docs/build-with-claude/tool-use/web-search-tool#streaming
        content: block.content,
        ...(block.providerMetadata && {
          providerMetadata: block.providerMetadata,
        }),
      };
    }
    case "thinking": {
      return block;
    }
    case "redacted_thinking": {
      return block;
    }
    default:
      assertUnreachable(block);
  }
}
