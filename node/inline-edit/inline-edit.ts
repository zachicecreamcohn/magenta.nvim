import { assertUnreachable } from "../utils/assertUnreachable";
import type { Dispatch, Update } from "../tea/tea";
import type { InlineEditToolRequest } from "./inline-edit-tool";
import type { Result } from "../utils/result";
import type { StopReason, Usage } from "../providers/provider";
import { d, type View } from "../tea/view";
import type { ReplaceSelectionToolRequest } from "./replace-selection-tool";

export type Model =
  | {
      state: "error";
      error: string;
    }
  | {
      state: "awaiting-prompt";
    }
  | {
      state: "response-pending";
    }
  | {
      state: "tool-use";
      edit: Result<
        InlineEditToolRequest | ReplaceSelectionToolRequest,
        { rawRequest: unknown }
      >;
      stopReason: StopReason;
      usage: Usage;
    };

export type Msg = {
  type: "update-model";
  next: Model;
};

export function initModel(): Model {
  return {
    state: "awaiting-prompt",
  };
}

export const update: Update<Msg, Model> = (msg, _model) => {
  switch (msg.type) {
    case "update-model":
      return [msg.next];
    default:
      assertUnreachable(msg.type);
  }
};

export const view: View<{ model: Model; dispatch: Dispatch<Msg> }> = ({
  model,
}) => {
  switch (model.state) {
    case "error":
      return d`Error: ${model.error}`;
    case "awaiting-prompt":
      return d``; // should never be shown...
    case "response-pending":
      return d`Input sent, awaiting response...`; // should never be shown...
    case "tool-use":
      switch (model.edit.status) {
        case "error":
          return d`Error: ${model.edit.error}, rawRequest: ${JSON.stringify(model.edit.rawRequest, null, 2) || "undefined"}`;
        case "ok":
          return d`Got tool use: ${JSON.stringify(model.edit.value, null, 2)}`;
        default:
          return assertUnreachable(model.edit);
      }
    default:
      return assertUnreachable(model);
  }
};
