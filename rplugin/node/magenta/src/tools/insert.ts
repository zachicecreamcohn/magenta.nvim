import * as Anthropic from "@anthropic-ai/sdk";
import { Buffer } from "neovim";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { Dispatch, Update } from "../tea/tea.ts";
import { d, VDOMNode, withBindings } from "../tea/view.ts";
import { context } from "../context.ts";
import { ToolRequestId } from "./toolManager.ts";

export type Model = {
  type: "insert";
  autoRespond: boolean;
  request: InsertToolUseRequest;
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

export function initModel(request: InsertToolUseRequest): [Model] {
  const model: Model = {
    type: "insert",
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
    const { nvim } = context;
    const filePath = request.input.filePath;

    try {
      await nvim.command(`vsplit ${filePath}`);
      const fileBuffer = await nvim.buffer;
      await nvim.command("diffthis");

      const lines = await fileBuffer.getLines({
        start: 0,
        end: -1,
        strictIndexing: false,
      });

      const scratchBuffer = (await nvim.createBuffer(false, true)) as Buffer;
      await scratchBuffer.setLines(lines, {
        start: 0,
        end: -1,
        strictIndexing: false,
      });

      let lineNumber = 0;
      let currentPos = 0;
      const content = lines.join("\n");
      const insertLocation =
        content.indexOf(request.input.insertAfter) +
        request.input.insertAfter.length;

      while (currentPos < insertLocation) {
        currentPos = content.indexOf("\n", currentPos);
        if (currentPos === -1 || currentPos > insertLocation) break;
        lineNumber++;
        currentPos++;
      }

      const insertLines = request.input.content.split("\n");
      await scratchBuffer.setLines(insertLines, {
        start: lineNumber + 1,
        end: lineNumber + 1,
        strictIndexing: true,
      });

      await nvim.command("vsplit");
      await nvim.command(`b ${scratchBuffer.id}`);
      await nvim.command("diffthis");

      dispatch({ type: "display-diff" });
    } catch (error) {
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
      return d`Done`;
  }
}

export const spec: Anthropic.Anthropic.Tool = {
  name: "insert",
  description: "Insert content after a specified string in a file",
  input_schema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path to the file to modify",
      },
      insertAfter: {
        type: "string",
        description: "String after which to insert the content",
      },
      content: {
        type: "string",
        description: "Content to insert",
      },
    },
    required: ["filePath", "insertAfter", "content"],
  },
};

export type InsertToolUseRequest = {
  type: "tool_use";
  id: ToolRequestId;
  name: "insert";
  input: {
    filePath: string;
    insertAfter: string;
    content: string;
  };
};
