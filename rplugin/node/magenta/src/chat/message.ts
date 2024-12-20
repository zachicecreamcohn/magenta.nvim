import * as Part from "./part.ts";
import * as ToolManager from "../tools/toolManager.ts";
import { Role } from "./chat.ts";
import { Dispatch, Update } from "../tea/tea.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, View } from "../tea/view.ts";

export type Model = {
  role: Role;
  parts: Part.Model[];
};

export type Msg =
  | {
      type: "append-text";
      text: string;
    }
  | {
      type: "add-part";
      part: Part.Model;
    }
  | {
      type: "tool-manager-msg";
      msg: ToolManager.Msg;
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

    case "add-part":
      model.parts.push(msg.part);
      break;

    case "tool-manager-msg": {
      // do nothing. This will be handled by the tool manager
      return [model];
    }

    default:
      assertUnreachable(msg);
  }
  return [model];
};

export const view: View<{
  model: Model;
  toolManager: ToolManager.Model;
  dispatch: Dispatch<Msg>;
}> = ({ model, toolManager, dispatch }) =>
  d`### ${model.role}:\n${model.parts.map(
    (part) =>
      d`${Part.view({ model: part, toolManager, dispatch: (msg) => dispatch({ type: "tool-manager-msg", msg }) })}\n`,
  )}`;
