import * as Anthropic from "@anthropic-ai/sdk";
import { getBufferIfOpen } from "../utils/buffers.ts";
import fs from "fs";
import path from "path";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { Thunk, Update } from "../tea/tea.ts";
import { d, VDOMNode } from "../tea/view.ts";
import { context } from "../context.ts";
import { ToolRequestId } from "./toolManager.ts";
import { Result } from "../utils/result.ts";

export type Model = {
  type: "get_file";
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
    type: "get_file",
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

export function getToolResult(model: Model): ToolResultBlockParam {
  switch (model.state.state) {
    case "processing":
      return {
        type: "tool_result",
        tool_use_id: model.request.id,
        content: `This tool use is being processed. Please proceed with your answer or address other parts of the question.`,
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
    required: ["filePath"],
  },
};

export type GetFileToolUseRequest = {
  type: "tool_use";
  id: ToolRequestId; //"toolu_01UJtsBsBED9bwkonjqdxji4"
  name: "get_file";
  input: {
    filePath: string; //"./src/index.ts"
  };
};

export function displayRequest(request: GetFileToolUseRequest) {
  return `get_file: {
    filePath: ${request.input.filePath}
}`;
}

export function validateToolRequest(
  req: unknown,
): Result<GetFileToolUseRequest> {
  if (typeof req != "object" || req == null) {
    return { status: "error", error: "received a non-object" };
  }

  const req2 = req as { [key: string]: unknown };

  if (req2.type != "tool_use") {
    return { status: "error", error: "expected req.type to be tool_use" };
  }

  if (typeof req2.id != "string") {
    return { status: "error", error: "expected req.id to be a string" };
  }

  if (req2.name != "get_file") {
    return { status: "error", error: "expected req.name to be insert" };
  }

  if (typeof req2.input != "object" || req2.input == null) {
    return { status: "error", error: "expected req.input to be an object" };
  }

  const input = req2.input as { [key: string]: unknown };

  if (typeof input.filePath != "string") {
    return {
      status: "error",
      error: "expected req.input.filePath to be a string",
    };
  }

  return {
    status: "ok",
    value: req as GetFileToolUseRequest,
  };
}
