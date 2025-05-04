import { ToolManager, type ToolRequestId } from "../tools/toolManager.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, type View } from "../tea/view.ts";
import type {
  ProviderMessageContent,
  ProviderToolResultContent,
  StopReason,
  Usage,
} from "../providers/provider.ts";

type State =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "tool-request";
      requestId: ToolRequestId;
    }
  | {
      type: "malformed-tool-request";
      error: string;
      rawRequest: unknown;
    }
  | {
      type: "stop-msg";
      stopReason: StopReason;
      usage: Usage;
    };

export class Part {
  toolManager: ToolManager;
  state: State;

  constructor({
    state,
    toolManager,
  }: {
    state: State;
    toolManager: ToolManager;
  }) {
    this.state = state;
    this.toolManager = toolManager;
  }

  toMessageContent(): {
    content?: ProviderMessageContent;
    result?: ProviderToolResultContent;
  } {
    switch (this.state.type) {
      case "text":
        return { content: this.state };

      case "tool-request": {
        const toolWrapper =
          this.toolManager.state.toolWrappers[this.state.requestId];
        return {
          content: {
            type: "tool_use",
            request: toolWrapper.tool.request,
          },
          result: toolWrapper.tool.getToolResult(),
        };
      }

      case "malformed-tool-request": {
        return {
          content: {
            type: "text",
            text: `Malformed tool request: ${this.state.error}`,
          },
        };
      }

      case "stop-msg": {
        return {};
      }

      default:
        return assertUnreachable(this.state);
    }
  }

  toString(): string {
    switch (this.state.type) {
      case "text": {
        // For text, show the first 30 chars (or fewer if shorter)
        const truncatedText =
          this.state.text.length > 30
            ? this.state.text.substring(0, 27) + "..."
            : this.state.text;
        return `Part(text: "${truncatedText.replace(/\n/g, "\\n")}")`;
      }

      case "tool-request": {
        const toolWrapper =
          this.toolManager.state.toolWrappers[this.state.requestId];
        if (!toolWrapper) {
          return `Part(tool-request: ID ${this.state.requestId} - NOT FOUND)`;
        }
        const toolName = toolWrapper.tool.toolName;
        const status = toolWrapper.tool.getToolResult()
          ? "completed"
          : "pending";
        return `Part(tool-request: ${toolName}, ID: ${this.state.requestId}, status: ${status})`;
      }

      case "malformed-tool-request": {
        return `Part(malformed-tool-request: "${this.state.error}")`;
      }

      case "stop-msg": {
        return `Part(stop-msg: reason=${this.state.stopReason}, tokens=${this.state.usage.inputTokens}/${this.state.usage.outputTokens})`;
      }

      default:
        return assertUnreachable(this.state);
    }
  }
}

export const view: View<{
  part: Part;
}> = ({ part }) => {
  switch (part.state.type) {
    case "text":
      return d`${part.state.text}`;

    case "malformed-tool-request":
      return d`Malformed tool request: ${part.state.error}
${JSON.stringify(part.state.rawRequest, null, 2) || "undefined"}`;

    case "tool-request": {
      const toolWrapper =
        part.toolManager.state.toolWrappers[part.state.requestId];
      if (!toolWrapper) {
        throw new Error(
          `Unable to find model with requestId ${part.state.requestId}`,
        );
      }
      return part.toolManager.renderTool(toolWrapper);
    }

    case "stop-msg": {
      return d`Stopped (${part.state.stopReason}) [input: ${part.state.usage.inputTokens.toString()}, output: ${part.state.usage.outputTokens.toString()}${
        part.state.usage.cacheHits !== undefined
          ? d`, cache hits: ${part.state.usage.cacheHits.toString()}`
          : ""
      }${
        part.state.usage.cacheMisses !== undefined
          ? d`, cache misses: ${part.state.usage.cacheMisses.toString()}`
          : ""
      }]`;
    }

    default:
      assertUnreachable(part.state);
  }
};
