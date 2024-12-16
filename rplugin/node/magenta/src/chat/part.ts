import Anthropic from "@anthropic-ai/sdk";
import * as ToolManager from "../tools/toolManager.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, View } from "../tea/view.ts";
import { Dispatch } from "../tea/tea.ts";

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
      type: "tool-response";
      requestId: ToolManager.ToolRequestId;
      response: Anthropic.ToolResultBlockParam;
    };

export const view: View<{
  model: Model;
  toolManager: ToolManager.Model;
  dispatch: Dispatch<ToolManager.Msg>;
}> = ({ model, dispatch, toolManager }) => {
  switch (model.type) {
    case "text":
      return d`${model.text}`;
    case "tool-request":
    case "tool-response": {
      const toolModel = toolManager.toolModels[model.requestId];
      return ToolManager.renderTool(toolModel, dispatch);
    }
    default:
      assertUnreachable(model);
  }
};

export function toMessageParam(
  part: Model,
  toolManager: ToolManager.Model,
):
  | Anthropic.TextBlockParam
  | Anthropic.ToolUseBlockParam
  | Anthropic.ToolResultBlockParam {
  switch (part.type) {
    case "text":
      return part;
    case "tool-request": {
      const toolModel = toolManager.toolModels[part.requestId];
      return toolModel.request;
    }
    case "tool-response":
      return part.response;
    default:
      return assertUnreachable(part);
  }
}
