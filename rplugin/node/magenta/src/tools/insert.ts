import * as Anthropic from "@anthropic-ai/sdk";
import { Buffer } from "neovim";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { Thunk, Update } from "../tea/tea.ts";
import { d, VDOMNode } from "../tea/view.ts";
import { context } from "../context.ts";

export type Model = {
  type: "insert";
  autoRespond: boolean;
  request: InsertToolUseRequest;
  state:
    | {
        state: "processing";
      }
    | {
        state: "pending-user-action";
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
      ];
    default:
      assertUnreachable(msg);
  }
};

export function initModel(request: InsertToolUseRequest): [Model, Thunk<Msg>] {
  const model: Model = {
    type: "insert",
    autoRespond: false,
    request,
    state: {
      state: "processing",
    },
  };

  return [
    model,
    async (dispatch) => {
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
    },
  ];
}

export function view({ model }: { model: Model }): VDOMNode {
  return d`Insert operation ${
    model.state.state === "done" ? "completed" : "in progress"
  }`;
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
  id: string;
  name: "insert";
  input: {
    filePath: string;
    insertAfter: string;
    content: string;
  };
};
