import Anthropic from "@anthropic-ai/sdk";
import { ToolRequest } from "../tools/toolManager.ts";
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
      type: "tool-use";
      request: ToolRequest;
    }
  | {
      type: "tool-response";
      request: ToolRequest;
      response: Anthropic.ToolResultBlockParam;
    };

export const view: View<{ model: Model }> = ({ model }) => {
  switch (model.type) {
    case "text":
      return d`${model.text}`;
    case "tool-use":
      return d`Attempting to use tool ${model.request.type}`;
    case "tool-response":
      return d`🔧 Tool response: ${model.request.name}
${model.response.is_error ? "❌ Error" : "✅ Success"}`;
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
    case "tool-use":
      return part.request;
    case "tool-response":
      return part.response;
    default:
      return assertUnreachable(part);
  }
}
