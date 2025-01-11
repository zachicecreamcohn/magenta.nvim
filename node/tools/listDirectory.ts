import fs from "fs";
import path from "path";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Thunk, Update } from "../tea/tea.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import type { Result } from "../utils/result.ts";
import { getcwd } from "../nvim/nvim.ts";
import type { Nvim } from "nvim-node";
import { readGitignore } from "./util.ts";
import type { ToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";

export type Model = {
  type: "list_directory";
  autoRespond: boolean;
  request: ToolRequest<"list_directory">;
  state:
    | {
        state: "processing";
      }
    | {
        state: "done";
        result: ProviderToolResultContent;
      };
};

export type Msg = {
  type: "finish";
  result: Result<string>;
};

export const update: Update<Msg, Model> = (msg, model) => {
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
    default:
      assertUnreachable(msg.type);
  }
};

async function listDirectoryBFS(
  startPath: string,
  cwd: string,
): Promise<string[]> {
  const ig = await readGitignore(cwd);
  const queue: string[] = [startPath];
  const results: string[] = [];
  const seen = new Set<string>();

  while (queue.length > 0 && results.length < 100) {
    const currentPath = queue.shift()!;

    const entries = await fs.promises.readdir(currentPath, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(cwd, fullPath);

      // Skip hidden files and respected gitignored files
      if (entry.name.startsWith(".") || ig.ignores(relativePath)) {
        continue;
      }

      if (!fullPath.startsWith(cwd)) {
        continue;
      }

      if (!seen.has(fullPath)) {
        seen.add(fullPath);
        results.push(relativePath);

        if (entry.isDirectory()) {
          queue.push(fullPath);
        }
      }
    }
  }

  return results;
}

export function initModel(
  request: ToolRequest<"list_directory">,
  context: { nvim: Nvim },
): [Model, Thunk<Msg>] {
  const model: Model = {
    type: "list_directory",
    autoRespond: true,
    request,
    state: {
      state: "processing",
    },
  };

  return [
    model,
    async (dispatch) => {
      try {
        const cwd = await getcwd(context.nvim);
        const dirPath = request.input.dirPath || ".";
        const absolutePath = path.resolve(cwd, dirPath);

        if (!absolutePath.startsWith(cwd)) {
          dispatch({
            type: "finish",
            result: {
              status: "error",
              error: "The path must be inside of neovim cwd",
            },
          });
          return;
        }

        const files = await listDirectoryBFS(absolutePath, cwd);
        context.nvim.logger?.debug(`files: ${files.join("\n")}`);
        dispatch({
          type: "finish",
          result: {
            status: "ok",
            value: files.join("\n"),
          },
        });
      } catch (error) {
        dispatch({
          type: "finish",
          result: {
            status: "error",
            error: `Failed to list directory: ${(error as Error).message}`,
          },
        });
      }
    },
  ];
}

export function view({ model }: { model: Model }): VDOMNode {
  switch (model.state.state) {
    case "processing":
      return d`⚙️ Listing directory ${model.request.input.dirPath || "."}`;
    case "done":
      return d`✅ Finished listing directory ${model.request.input.dirPath || "."}`;
    default:
      assertUnreachable(model.state);
  }
}

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
    case "done":
      return model.state.result;
    default:
      assertUnreachable(model.state);
  }
}

export const spec: ProviderToolSpec = {
  name: "list_directory",
  description: `List up to 100 files in a directory using breadth-first search, respecting .gitignore and hidden files.`,
  input_schema: {
    type: "object",
    properties: {
      dirPath: {
        type: "string",
        description: `The directory path relative to cwd. Use "." to list whole directory.`,
      },
    },
    required: ["dirPath"],
    additionalProperties: false,
  },
};

export type Input = {
  dirPath?: string;
};

export function displayInput(input: Input) {
  return `list_directory: {
    dirPath: ${input.dirPath || "."}
}`;
}

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (input.dirPath !== undefined && typeof input.dirPath !== "string") {
    return {
      status: "error",
      error: "expected req.input.dirPath to be a string if provided",
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
