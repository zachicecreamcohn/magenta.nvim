import Anthropic from "@anthropic-ai/sdk";
import * as ToolManager from "../tools/toolManager.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, View, withBindings } from "../tea/view.ts";
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
      displayRequest: boolean;
      displayResult: boolean;
    }
  | {
      type: "malformed-tool-request";
      error: string;
      rawRequest: unknown;
    };

export type Msg =
  | {
      type: "toggle-display";
      displayRequest: boolean;
      displayResult: boolean;
    }
  | {
      type: "tool-manager-msg";
      msg: ToolManager.Msg;
    };

export const update: Update<Msg, Model> = (msg, model) => {
  switch (msg.type) {
    case "toggle-display":
      if (model.type == "tool-request") {
        model.displayRequest = msg.displayRequest;
        model.displayResult = msg.displayResult;
      }
      return [model];
    case "tool-manager-msg":
      // do nothing - this will be handled higher up the chain
      return [model];
    default:
      assertUnreachable(msg);
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
      const toolModel = toolManager.toolModels[model.requestId];
      return withBindings(
        d`${ToolManager.renderTool(toolModel, (msg) =>
          dispatch({
            type: "tool-manager-msg",
            msg,
          }),
        )}${
          model.displayRequest
            ? d`\n${JSON.stringify(toolModel.request, null, 2)}`
            : ""
        }${
          model.displayResult && toolModel.state.state == "done"
            ? d`\n${JSON.stringify(toolModel.state.result, null, 2)}`
            : ""
        }`,
        {
          Enter: () =>
            dispatch({
              type: "toggle-display",
              displayRequest: !model.displayRequest,
              displayResult: !model.displayResult,
            }),
        },
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
      const toolModel = toolManager.toolModels[part.requestId];
      return {
        param: toolModel.request,
        result: ToolManager.getToolResult(toolModel),
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
