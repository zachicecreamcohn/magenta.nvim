import { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { Model as Part, view as partView } from "./part.ts";
import { ToolModel } from "../tools/toolManager.ts";
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
      toolModel: ToolModel;
    }
  | {
      type: "add-tool-response";
      toolModel: ToolModel;
      response: ToolResultBlockParam;
    }
  | {
      type: "tool-model-update";
      toolModel: ToolModel;
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
        type: "tool-request",
        toolModel: msg.toolModel,
      });
      break;

    case "add-tool-response":
      model.parts.push({
        type: "tool-response",
        toolModel: msg.toolModel,
        response: msg.response,
      });
      break;

    case "tool-model-update": {
      for (const part of model.parts) {
        if (
          (part.type == "tool-request" || part.type == "tool-response") &&
          part.toolModel.request.id == msg.toolModel.request.id
        ) {
          part.toolModel = msg.toolModel;
        }
      }
      return [model];
    }

    default:
      assertUnreachable(msg);
  }
  return [model];
};

export const view: View<{ model: Model; dispatch: Dispatch<Msg> }> = ({
  model,
}) =>
  d`### ${model.role}:\n${model.parts.map(
    (part) => d`${partView({ model: part })}\n`,
  )}`;
