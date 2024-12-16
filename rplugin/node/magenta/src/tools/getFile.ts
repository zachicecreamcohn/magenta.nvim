import * as Anthropic from "@anthropic-ai/sdk";
import { getBufferIfOpen } from "../utils/buffers.ts";
import fs from "fs";
import path from "path";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { Thunk, Update } from "../tea/tea.ts";
import { d, VDOMNode } from "../tea/view.ts";
import { context } from "../context.ts";

export type Model = {
  type: "get-file";
  autoRespond: boolean;
  request: GetFileToolUseRequest;
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

export type Msg = {
  type: "finish";
  result: ToolResultBlockParam;
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
    default:
      assertUnreachable(msg.type);
  }
};

export function initModel(request: GetFileToolUseRequest): [Model, Thunk<Msg>] {
  const model: Model = {
    type: "get-file",
    autoRespond: true,
    request,
    state: {
      state: "processing",
    },
  };
  return [
    model,
    async (dispatch) => {
      const filePath = model.request.input.filePath;
      context.logger.trace(`request: ${JSON.stringify(model.request)}`);
      const bufferContents = await getBufferIfOpen({
        relativePath: filePath,
      });

      if (bufferContents.status === "ok") {
        dispatch({
          type: "finish",
          result: {
            type: "tool_result",
            tool_use_id: model.request.id,
            content: bufferContents.result,
            is_error: false,
          },
        });
        return;
      }

      if (bufferContents.status === "error") {
        dispatch({
          type: "finish",
          result: {
            type: "tool_result",
            tool_use_id: request.id,
            content: bufferContents.error,
            is_error: true,
          },
        });
        return;
      }

      try {
        const cwd = (await context.nvim.call("getcwd")) as string;
        const absolutePath = path.resolve(cwd, filePath);

        if (!absolutePath.startsWith(cwd)) {
          dispatch({
            type: "finish",
            result: {
              type: "tool_result",
              tool_use_id: model.request.id,
              content: "The path must be inside of neovim cwd",
              is_error: true,
            },
          });
          return;
        }

        const fileContent = await fs.promises.readFile(absolutePath, "utf-8");
        dispatch({
          type: "finish",
          result: {
            type: "tool_result",
            tool_use_id: model.request.id,
            content: fileContent,
            is_error: false,
          },
        });
        return;
      } catch (error) {
        dispatch({
          type: "finish",
          result: {
            type: "tool_result",
            tool_use_id: model.request.id,
            content: `Failed to read file: ${(error as Error).message}`,
            is_error: true,
          },
        });
      }
    },
  ];
}

export function view({ model }: { model: Model }): VDOMNode {
  switch (model.state.state) {
    case "processing":
      return d`⚙️ Reading file ${model.request.input.filePath}`;
    case "pending-user-action":
      return d`⏳ Pending approval to read file ${model.request.input.filePath}`;
    case "done":
      return d`✅ Finished reading file ${model.request.input.filePath}`;
    default:
      assertUnreachable(model.state);
  }
}

export const spec: Anthropic.Anthropic.Tool = {
  name: "get_file",
  description: `Get the full contents of a file in the project directory.`,
  input_schema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description:
          "the path, relative to the project root, of the file. e.g. ./src/index.ts",
      },
    },
    required: ["path"],
  },
};

export type GetFileToolUseRequest = {
  type: "tool_use";
  id: string; //"toolu_01UJtsBsBED9bwkonjqdxji4"
  name: "get_file";
  input: {
    filePath: string; //"./src/index.ts"
  };
};
