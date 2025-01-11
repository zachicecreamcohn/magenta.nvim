import { getBufferIfOpen } from "../utils/buffers.ts";
import fs from "fs";
import path from "path";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { type Dispatch, type Thunk, type Update } from "../tea/tea.ts";
import { d, withBindings, type View } from "../tea/view.ts";
import { type ToolRequest } from "./toolManager.ts";
import { type Result } from "../utils/result.ts";
import { getcwd } from "../nvim/nvim.ts";
import type { Nvim } from "nvim-node";
import { readGitignore } from "./util.ts";
import type {
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";

export type Model = {
  type: "get_file";
  request: ToolRequest<"get_file">;
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
        result: ProviderToolResultContent;
      };
};

export type Msg =
  | {
      type: "finish";
      result: Result<string>;
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
            result: {
              type: "tool_result",
              id: model.request.id,
              result: msg.result,
            },
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
                  type: "tool_result",
                  id: model.request.id,
                  result: {
                    status: "error",
                    error: `The user did not allow the reading of this file.`,
                  },
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
          status: "ok",
          value: (
            await bufferContents.buffer.getLines({ start: 0, end: -1 })
          ).join("\n"),
        },
      });
      return;
    }

    if (bufferContents.status === "error") {
      dispatch({
        type: "finish",
        result: {
          status: "error",
          error: bufferContents.error,
        },
      });
      return;
    }

    try {
      const fileContent = await fs.promises.readFile(absolutePath, "utf-8");
      dispatch({
        type: "finish",
        result: {
          status: "ok",
          value: fileContent,
        },
      });
      return;
    } catch (error) {
      dispatch({
        type: "finish",
        result: {
          status: "error",
          error: `Failed to read file: ${(error as Error).message}`,
        },
      });
    }
  };

  return thunk;
}

export function initModel(
  request: ToolRequest<"get_file">,
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
      if (model.state.result.result.status == "error") {
        return d`❌ Error reading file \`${model.request.input.filePath}\`: ${model.state.result.result.error}`;
      } else {
        return d`✅ Finished reading file \`${model.request.input.filePath}\``;
      }
    default:
      assertUnreachable(model.state);
  }
};

export function getToolResult(model: Model): ProviderToolResultContent {
  switch (model.state.state) {
    case "processing":
      return {
        type: "tool_result",
        id: model.request.id,
        result: {
          status: "ok",
          value: `This tool use is being processed. Please proceed with your answer or address other parts of the question.`,
        },
      };
    case "pending-user-action":
      return {
        type: "tool_result",
        id: model.request.id,
        result: {
          status: "ok",
          value: `Waiting for user approval to finish processing this tool use.`,
        },
      };
    case "done":
      return model.state.result;
    default:
      assertUnreachable(model.state);
  }
}

export const spec: ProviderToolSpec = {
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
    additionalProperties: false,
  },
};

export type Input = {
  filePath: string;
};

export function displayInput(input: Input) {
  return `get_file: {
    filePath: ${input.filePath}
}`;
}

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.filePath != "string") {
    return {
      status: "error",
      error: "expected req.input.filePath to be a string",
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
