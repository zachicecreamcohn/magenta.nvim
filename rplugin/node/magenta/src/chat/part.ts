import Anthropic from "@anthropic-ai/sdk";
import { renderTool, ToolModel } from "../tools/toolManager.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, View } from "../tea/view.ts";

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
      toolModel: ToolModel;
    }
  | {
      type: "tool-response";
      toolModel: ToolModel;
      response: Anthropic.ToolResultBlockParam;
    };

export const view: View<{ model: Model }> = ({ model }) => {
  switch (model.type) {
    case "text":
      return d`${model.text}`;
    case "tool-request":
    case "tool-response":
      return renderTool(model.toolModel);
    default:
      assertUnreachable(model);
  }
};

export function toMessageParam(
  part: Model,
):
  | Anthropic.TextBlockParam
  | Anthropic.ToolUseBlockParam
  | Anthropic.ToolResultBlockParam {
  switch (part.type) {
    case "text":
      return part;
    case "tool-request":
      return part.toolModel.request;
    case "tool-response":
      return part.response;
    default:
      return assertUnreachable(part);
  }
}
