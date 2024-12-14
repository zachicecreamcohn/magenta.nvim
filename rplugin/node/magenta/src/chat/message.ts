import { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { Model as Part, view as partView } from "./part.ts";
import { ToolProcess } from "../tools/types.ts";
import { ToolRequest } from "../tools/index.ts";
import { Role } from "./chat.ts";
import { Dispatch, Update } from "../tea/tea.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, View } from "../tea/view.ts";

export type Model = {
  role: Role;
  parts: Part[];
};

export type Msg =
  | {
      type: "append-text";
      text: string;
    }
  | {
      type: "add-tool-use";
      request: ToolRequest;
      process: ToolProcess;
    }
  | {
      type: "add-tool-response";
      request: ToolRequest;
      response: ToolResultBlockParam;
    };

export const update: Update<Msg, Model> = (msg, model) => {
  switch (msg.type) {
    case "append-text": {
      const lastPart = model.parts[model.parts.length - 1];
      if (lastPart && lastPart.type == "text") {
        lastPart.text += msg.text;
      } else {
        model.parts.push({
          type: "text",
          text: msg.text,
        });
      }
      break;
    }

    case "add-tool-use":
      model.parts.push({
        type: "tool-use",
        request: msg.request,
        process: msg.process,
      });
      break;

    case "add-tool-response":
      model.parts.push({
        type: "tool-response",
        request: msg.request,
        response: msg.response,
      });
      break;

    default:
      assertUnreachable(msg);
  }
  return [model];
};

export const view: View<{ model: Model; dispatch: Dispatch<Msg> }> = ({
  model,
}) => d`\
### ${model.role}:

${model.parts.map((part) => partView({ model: part }))}`;
