import * as ToolManager from "../tools/toolManager.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, type View } from "../tea/view.ts";
import { type Dispatch } from "../tea/tea.ts";
import type { Lsp } from "../lsp.ts";
import type { Nvim } from "nvim-node";
import type {
  ProviderMessageContent,
  ProviderToolResultContent,
  StopReason,
  Usage,
} from "../providers/provider.ts";
import type { MagentaOptions } from "../options.ts";

type State =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "tool-request";
      requestId: ToolManager.ToolRequestId;
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

export type Msg = {
  type: "tool-manager-msg";
  msg: ToolManager.Msg;
};

export class Part {
  toolManagerModel: ReturnType<typeof ToolManager.init>;
  toolManager: ToolManager.Model;
  state: State;

  constructor({
    nvim,
    lsp,
    options,
    state,
    toolManager,
  }: {
    nvim: Nvim;
    lsp: Lsp;
    options: MagentaOptions;
    state: State;
    toolManager: ToolManager.Model;
  }) {
    this.state = state;
    this.toolManager = toolManager;
    this.toolManagerModel = ToolManager.init({ nvim, lsp, options });
  }

  update(msg: Msg) {
    switch (msg.type) {
      case "tool-manager-msg":
        // do nothing - this will be handled higher up the chain
        return undefined;
      default:
        assertUnreachable(msg.type);
    }
  }

  toMessageContent(): {
    content?: ProviderMessageContent;
    result?: ProviderToolResultContent;
  } {
    switch (this.state.type) {
      case "text":
        return { content: this.state };

      case "tool-request": {
        const toolWrapper = this.toolManager.toolWrappers[this.state.requestId];
        return {
          content: {
            type: "tool_use",
            request: toolWrapper.model.request,
          },
          result: this.toolManagerModel.getToolResult(toolWrapper.model),
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
}

export const view: View<{
  part: Part;
  dispatch: Dispatch<Msg>;
}> = ({ part, dispatch }) => {
  switch (part.state.type) {
    case "text":
      return d`${part.state.text}`;

    case "malformed-tool-request":
      return d`Malformed tool request: ${part.state.error}
${JSON.stringify(part.state.rawRequest, null, 2) || "undefined"}`;

    case "tool-request": {
      const toolModel = part.toolManager.toolWrappers[part.state.requestId];
      if (!toolModel) {
        throw new Error(
          `Unable to find model with requestId ${part.state.requestId}`,
        );
      }
      return part.toolManagerModel.renderTool(toolModel, (msg) =>
        dispatch({
          type: "tool-manager-msg",
          msg,
        }),
      );
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
