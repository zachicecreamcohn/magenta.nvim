import { validateInput } from "../tools/helpers";
import type {
  ToolName,
  ToolRequest,
  ToolRequestId,
} from "../tools/toolManager";
import { assertUnreachable } from "../utils/assertUnreachable";
import type {
  ProviderBlockStartEvent,
  ProviderMessageContent,
  ProviderServerToolUseContent,
  ProviderStreamEvent,
} from "./provider";

export type StreamingBlock = ProviderBlockStartEvent["content_block"] & {
  streamed: string;
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
      throw new Error("NOT IMPLEMENTED");
    case "signature_delta":
      throw new Error("NOT IMPLEMENTED");
    default:
      assertUnreachable(event.delta);
  }
}

export function finalizeStreamingBLock(
  block: StreamingBlock,
): ProviderMessageContent {
  switch (block.type) {
    case "text": {
      return {
        type: "text",
        text: block.streamed,
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
        name: block.name,
        request:
          inputParseResult.status == "ok"
            ? {
                status: "ok",
                value: {
                  id: block.id as ToolRequestId,
                  toolName: block.name as ToolName,
                  input: inputParseResult.value,
                } as ToolRequest,
              }
            : {
                ...inputParseResult,
                rawRequest: input
                  ? input
                  : {
                      streamed_json: block.streamed,
                    },
              },
      };
    }
    case "server_tool_use": {
      return {
        type: "server_tool_use",
        id: block.id,
        name: block.name,
        input: JSON.parse(
          block.streamed,
        ) as ProviderServerToolUseContent["input"],
      };
    }
    case "web_search_tool_result": {
      return {
        type: "web_search_tool_result",
        tool_use_id: block.tool_use_id,
        // it seems that all results are going to be given in the initial block_start event
        // https://docs.anthropic.com/en/docs/build-with-claude/tool-use/web-search-tool#streaming
        content: block.content,
      };
    }
    case "thinking":
    case "redacted_thinking":
      // Based on current implementation these are not yet handled
      // and we're throwing errors for thinking_delta in applyDelta
      throw new Error(`Unsupported content block type: ${block.type}`);
    default:
      assertUnreachable(block);
  }
}
