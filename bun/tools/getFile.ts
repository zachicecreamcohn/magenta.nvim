import * as Anthropic from "@anthropic-ai/sdk";
import { getBufferIfOpen } from "../utils/buffers.ts";
import fs from "fs";
import path from "path";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { type Dispatch, type Thunk, type Update } from "../tea/tea.ts";
import { d, withBindings, type View } from "../tea/view.ts";
import { type ToolRequestId } from "./toolManager.ts";
import { type Result } from "../utils/result.ts";
import { getcwd } from "../nvim/nvim.ts";
import type { Nvim } from "bunvim";
import { readGitignore } from "./util.ts";

export type Model = {
  type: "get_file";
  request: GetFileToolUseRequest;
  state:
    | {
        state: "processing";
        approved: boolean;
      }
    | {
        state: "pending-user-action";
      }
    | {
        state: "done";
        result: Anthropic.Anthropic.ToolResultBlockParam;
      };
};

export type Msg =
  | {
      type: "finish";
      result: Anthropic.Anthropic.ToolResultBlockParam;
    }
  | {
      type: "request-user-approval";
    }
  | {
      type: "user-approval";
      approved: boolean;
    };

export const update: Update<Msg, Model, { nvim: Nvim }> = (
  msg,
  model,
  context: { nvim: Nvim },
) => {
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
    case "request-user-approval":
      return [
        {
          ...model,
          state: {
            state: "pending-user-action",
          },
        },
      ];
    case "user-approval": {
      if (model.state.state == "pending-user-action") {
        if (msg.approved) {
          const nextModel: Model = {
            ...model,
            state: { state: "processing", approved: true },
          };
          return [nextModel, readFileThunk(nextModel, context)];
        } else {
          return [
            {
              ...model,
              state: {
                state: "done",
                result: {
                  tool_use_id: model.request.id,
                  type: "tool_result",
                  content: `The user did not allow the reading of this file.`,
                  is_error: true,
                },
              },
            },
          ];
        }
      } else {
        throw new Error(
          `Unexpected message ${msg.type} when model state is ${model.state.state}`,
        );
      }
    }
    default:
      assertUnreachable(msg);
  }
};

function readFileThunk(model: Model, context: { nvim: Nvim }) {
  const thunk: Thunk<Msg> = async (dispatch: Dispatch<Msg>) => {
    const filePath = model.request.input.filePath;
    const cwd = await getcwd(context.nvim);
    const absolutePath = path.resolve(cwd, filePath);
    const relativePath = path.relative(cwd, absolutePath);

    if (!(model.state.state === "processing" && model.state.approved)) {
      if (!absolutePath.startsWith(cwd)) {
        dispatch({ type: "request-user-approval" });
        return;
      }

      if (relativePath.split(path.sep).some((part) => part.startsWith("."))) {
        dispatch({ type: "request-user-approval" });
        return;
      }

      const ig = await readGitignore(cwd);
      if (ig.ignores(relativePath)) {
        dispatch({ type: "request-user-approval" });
        return;
      }
    }

    const bufferContents = await getBufferIfOpen({
      relativePath: filePath,
      context,
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
          tool_use_id: model.request.id,
          content: bufferContents.error,
          is_error: true,
        },
      });
      return;
    }

    try {
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
  };

  return thunk;
}

export function initModel(
  request: GetFileToolUseRequest,
  context: { nvim: Nvim },
): [Model, Thunk<Msg>] {
  const model: Model = {
    type: "get_file",
    request,
    state: {
      state: "processing",
      approved: false,
    },
  };

  return [model, readFileThunk(model, context)];
}

export const view: View<{ model: Model; dispatch: Dispatch<Msg> }> = ({
  model,
  dispatch,
}) => {
  switch (model.state.state) {
    case "processing":
      return d`⚙️ Reading file ${model.request.input.filePath}`;
    case "pending-user-action":
      return d`⏳ May I read file \`${model.request.input.filePath}\`? ${withBindings(
        d`**[ NO ]**`,
        {
          "<CR>": () => dispatch({ type: "user-approval", approved: false }),
        },
      )} ${withBindings(d`**[ OK ]**`, {
        "<CR>": () => dispatch({ type: "user-approval", approved: true }),
      })}`;
    case "done":
      if (model.state.result.is_error) {
        return d`❌ Error reading file \`${model.request.input.filePath}\`: ${model.state.result.content as string}`;
      } else {
        return d`✅ Finished reading file \`${model.request.input.filePath}\``;
      }
    default:
      assertUnreachable(model.state);
  }
};

export function getToolResult(
  model: Model,
): Anthropic.Anthropic.ToolResultBlockParam {
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
        content: `Waiting for user approval to finish processing this tool use.`,
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
