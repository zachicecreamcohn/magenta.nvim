import * as Anthropic from "@anthropic-ai/sdk";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { Dispatch, Update } from "../tea/tea.ts";
import { d, VDOMNode, withBindings } from "../tea/view.ts";
import { ToolRequestId } from "./toolManager.ts";
import { displayDiffs } from "./diff.ts";
import { context } from "../context.ts";

export type Model = {
  type: "replace";
  autoRespond: boolean;
  request: ReplaceToolRequest;
  state:
    | {
        state: "pending-user-action";
      }
    | {
        state: "editing-diff";
      }
    | {
        state: "done";
        result: ToolResultBlockParam;
      };
};

export type Msg =
  | {
      type: "finish";
      result: ToolResultBlockParam;
    }
  | {
      type: "display-diff";
    };

export const update: Update<Msg, Model> = (msg, model) => {
  switch (msg.type) {
    case "finish":
      return [
        {
          ...model,
          state: {
            state: "done",
            result: msg.result,
          },
        },
      ];
    case "display-diff":
      return [
        {
          ...model,
          state: {
            state: "pending-user-action",
          },
        },
        insertThunk(model),
      ];
    default:
      assertUnreachable(msg);
  }
};

export function initModel(request: ReplaceToolRequest): [Model] {
  const model: Model = {
    type: "replace",
    autoRespond: false,
    request,
    state: {
      state: "pending-user-action",
    },
  };

  return [model];
}

export function insertThunk(model: Model) {
  const request = model.request;
  return async (dispatch: Dispatch<Msg>) => {
    try {
      await displayDiffs(
        request.input.filePath,
        [
          {
            type: "replace",
            start: request.input.start,
            end: request.input.end,
            content: request.input.content,
          },
        ],
        (msg) =>
          dispatch({
            type: "finish",
            result: {
              type: "tool_result",
              tool_use_id: model.request.id,
              content: msg.error,
              is_error: true,
            },
          }),
      );
    } catch (error) {
      context.logger.error(error as Error);
      dispatch({
        type: "finish",
        result: {
          type: "tool_result",
          tool_use_id: request.id,
          content: `Error: ${(error as Error).message}`,
          is_error: true,
        },
      });
    }
  };
}

export function view({
  model,
  dispatch,
}: {
  model: Model;
  dispatch: Dispatch<Msg>;
}): VDOMNode {
  return d`Insert ${(
    model.request.input.content.match(/\n/g) || []
  ).length.toString()} into file ${model.request.input.filePath}
${toolStatusView({ model, dispatch })}`;
}

function toolStatusView({
  model,
  dispatch,
}: {
  model: Model;
  dispatch: Dispatch<Msg>;
}): VDOMNode {
  switch (model.state.state) {
    case "pending-user-action":
      return withBindings(d`[review diff]`, {
        Enter: () =>
          dispatch({
            type: "display-diff",
          }),
      });
    case "editing-diff":
      return d`Editing diff`;
    case "done":
      if (model.state.result.is_error) {
        return d`Error: ${JSON.stringify(model.state.result.content, null, 2)}`;
      } else {
        return d`Done`;
      }
  }
}

export function getToolResult(model: Model): ToolResultBlockParam {
  switch (model.state.state) {
    case "editing-diff":
      return {
        type: "tool_result",
        tool_use_id: model.request.id,
        content: `The user is reviewing the change. Please proceed with your answer or address other parts of the question.`,
      };
    case "pending-user-action":
      return {
        type: "tool_result",
        tool_use_id: model.request.id,
        content: `Waiting for a user action to finish processing this tool use. Please proceed with your answer or address other parts of the question.`,
      };
    case "done":
      return model.state.result;
    default:
      assertUnreachable(model.state);
  }
}

export const spec: Anthropic.Anthropic.Tool = {
  name: "replace",
  description: "Replace text between two strings in a file.",
  input_schema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path of the file to modify.",
      },
      start: {
        type: "string",
        description:
          "Replace content starting with this text. This should be the literal text of the file - regular expressions are not supported. This text is included in what will be replaced. Please provide just enough text to uniquely identify a location in the file.",
      },
      end: {
        type: "string",
        description:
          "Replace content until we encounter this text. This should be the literal text of the file - regular expressions are not supported. This text is included in what will be replaced. Please provide just enough text to uniquely identify a location in the file.",
      },
      content: {
        type: "string",
        description: "New content that will replace the existing text.",
      },
    },
    required: ["filePath", "start", "end", "content"],
  },
};

export type ReplaceToolRequest = {
  type: "tool_use";
  id: ToolRequestId;
  name: "replace";
  input: {
    filePath: string;
    start: string;
    end: string;
    content: string;
  };
};
