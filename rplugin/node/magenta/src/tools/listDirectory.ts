import * as Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { Thunk, Update } from "../tea/tea.ts";
import { d, VDOMNode } from "../tea/view.ts";
import { context } from "../context.ts";
import { ToolRequestId } from "./toolManager.ts";
import { Result } from "../utils/result.ts";
import ignore from "ignore";
import { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";

export type Model = {
  type: "list_directory";
  autoRespond: boolean;
  request: ListDirectoryToolUseRequest;
  state:
    | {
        state: "processing";
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

async function readGitignore(cwd: string): Promise<ignore.Ignore> {
  const ig = ignore.default();
  try {
    const gitignorePath = path.join(cwd, ".gitignore");
    const gitignoreContent = await fs.promises.readFile(gitignorePath, "utf8");
    ig.add(gitignoreContent);
  } catch {
    // If .gitignore doesn't exist, just return empty ignore rules
  }
  return ig;
}

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

    try {
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
    } catch (error) {
      console.error(`Error reading directory ${currentPath}:`, error);
    }
  }

  return results;
}

export function initModel(
  request: ListDirectoryToolUseRequest,
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
        const cwd = (await context.nvim.call("getcwd")) as string;
        const dirPath = request.input.dirPath || ".";
        const absolutePath = path.resolve(cwd, dirPath);

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

        const files = await listDirectoryBFS(absolutePath, cwd);
        dispatch({
          type: "finish",
          result: {
            type: "tool_result",
            tool_use_id: model.request.id,
            content: files.join("\n"),
            is_error: false,
          },
        });
      } catch (error) {
        dispatch({
          type: "finish",
          result: {
            type: "tool_result",
            tool_use_id: model.request.id,
            content: `Failed to list directory: ${(error as Error).message}`,
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
      return d`⚙️ Listing directory ${model.request.input.dirPath || "."}`;
    case "done":
      return d`✅ Finished listing directory ${model.request.input.dirPath || "."}`;
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
    case "done":
      return model.state.result;
    default:
      assertUnreachable(model.state);
  }
}

export const spec: Anthropic.Anthropic.Tool = {
  name: "list_directory",
  description: `List up to 100 files in a directory using breadth-first search, respecting .gitignore and hidden files`,
  input_schema: {
    type: "object",
    properties: {
      dirPath: {
        type: "string",
        description:
          "The directory path relative to cwd to list (defaults to '.')",
      },
    },
    required: [],
  },
};

export type ListDirectoryToolUseRequest = {
  type: "tool_use";
  id: ToolRequestId;
  name: "list_directory";
  input: {
    dirPath?: string;
  };
};

export function displayRequest(request: ListDirectoryToolUseRequest) {
  return `list_directory: {
    dirPath: ${request.input.dirPath || "."}
}`;
}

export function validateToolRequest(
  req: unknown,
): Result<ListDirectoryToolUseRequest> {
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

  if (req2.name != "list_directory") {
    return { status: "error", error: "expected req.name to be list_directory" };
  }

  if (typeof req2.input != "object" || req2.input == null) {
    return { status: "error", error: "expected req.input to be an object" };
  }

  const input = req2.input as { [key: string]: unknown };

  if (input.dirPath !== undefined && typeof input.dirPath !== "string") {
    return {
      status: "error",
      error: "expected req.input.dirPath to be a string if provided",
    };
  }

  return {
    status: "ok",
    value: req as ListDirectoryToolUseRequest,
  };
}
