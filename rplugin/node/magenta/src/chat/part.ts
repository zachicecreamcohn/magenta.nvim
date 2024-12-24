import Anthropic from "@anthropic-ai/sdk";
import * as ToolManager from "../tools/toolManager.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, View } from "../tea/view.ts";
import { Dispatch, Update } from "../tea/tea.ts";

/** A line that's meant to be sent to neovim. Should not contain newlines
 */
export type Line = string & { __line: true };

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

export const update: Update<Msg, Model> = (msg, model) => {
  switch (msg.type) {
    case "tool-manager-msg":
      // do nothing - this will be handled higher up the chain
      return [model];
    default:
      assertUnreachable(msg.type);
  }
};

export const view: View<{
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
      return ToolManager.renderTool(toolModel, (msg) =>
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


export function toMessageParam(
  part: Model,
  toolManager: ToolManager.Model,
): {
  param: Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam;
  result?: Anthropic.ToolResultBlockParam;
} {
  switch (part.type) {
    case "text":
      return { param: part };

    case "tool-request": {
      const toolWrapper = toolManager.toolWrappers[part.requestId];
      return {
        param: toolWrapper.model.request,
        result: ToolManager.getToolResult(toolWrapper.model),
      };
    }

    case "malformed-tool-request": {
      return {
        param: {
          type: "text",
          text: `Malformed tool request: ${part.error}`,
        },
      };
    }

    default:
      return assertUnreachable(part);
  }
}
