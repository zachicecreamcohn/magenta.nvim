import * as ToolManager from "../tools/toolManager.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, type View } from "../tea/view.ts";
import { type Dispatch, type Update } from "../tea/tea.ts";
import type { Lsp } from "../lsp.ts";
import type { Nvim } from "bunvim";
import type {
  ProviderMessageContent,
  ProviderToolResultContent,
} from "../providers/provider.ts";

export type Model =
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
    };

export type Msg = {
  type: "tool-manager-msg";
  msg: ToolManager.Msg;
};

export function init({ nvim, lsp }: { nvim: Nvim; lsp: Lsp }) {
  const toolManagerModel = ToolManager.init({ nvim, lsp });

  const update: Update<Msg, Model> = (msg, model) => {
    switch (msg.type) {
      case "tool-manager-msg":
        // do nothing - this will be handled higher up the chain
        return [model];
      default:
        assertUnreachable(msg.type);
    }
  };

  const view: View<{
    model: Model;
    toolManager: ToolManager.Model;
    dispatch: Dispatch<Msg>;
  }> = ({ model, dispatch, toolManager }) => {
    switch (model.type) {
      case "text":
        return d`${model.text}`;

      case "malformed-tool-request":
        return d`Malformed Tool request: ${model.error}
${JSON.stringify(model.rawRequest, null, 2)}`;

      case "tool-request": {
        const toolModel = toolManager.toolWrappers[model.requestId];
        if (!toolModel) {
          throw new Error(
            `Unable to find model with requestId ${model.requestId}`,
          );
        }
        return toolManagerModel.renderTool(toolModel, (msg) =>
          dispatch({
            type: "tool-manager-msg",
            msg,
          }),
        );
      }
      default:
        assertUnreachable(model);
    }
  };

  function toMessageContent(
    part: Model,
    toolManager: ToolManager.Model,
  ): {
    content: ProviderMessageContent;
    result?: ProviderToolResultContent;
  } {
    switch (part.type) {
      case "text":
        return { content: part };

      case "tool-request": {
        const toolWrapper = toolManager.toolWrappers[part.requestId];
        return {
          content: {
            type: "tool_use",
            request: toolWrapper.model.request,
          },
          result: toolManagerModel.getToolResult(toolWrapper.model),
        };
      }

      case "malformed-tool-request": {
        return {
          content: {
            type: "text",
            text: `Malformed tool request: ${part.error}`,
          },
        };
      }

      default:
        return assertUnreachable(part);
    }
  }
  return {
    update,
    view,
    toMessageParam: toMessageContent,
  };
}
