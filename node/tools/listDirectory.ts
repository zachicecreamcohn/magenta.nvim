import fs from "fs";
import path from "path";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, withInlineCode, type VDOMNode } from "../tea/view.ts";
import type { Result } from "../utils/result.ts";
import type { CompletedToolInfo } from "./types.ts";

import type { Nvim } from "../nvim/nvim-node";
import { readGitignoreSync } from "./util.ts";
import type {
  ProviderToolResult,
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { StaticTool, ToolName, GenericToolRequest } from "./types.ts";
import {
  relativePath,
  resolveFilePath,
  type AbsFilePath,
  type NvimCwd,
  type UnresolvedFilePath,
} from "../utils/files.ts";
import { canReadFile } from "./permissions.ts";
import type { MagentaOptions } from "../options.ts";

export type ToolRequest = GenericToolRequest<"list_directory", Input>;

export type State =
  | {
      state: "processing";
    }
  | {
      state: "done";
      result: ProviderToolResult;
    };

export type Msg = {
  type: "finish";
  result: Result<ProviderToolResultContent[]>;
};

async function listDirectoryBFS(
  startPath: AbsFilePath,
  context: {
    cwd: NvimCwd;
    nvim: Nvim;
    options: MagentaOptions;
  },
): Promise<string[]> {
  const ig = readGitignoreSync(context.cwd);
  const queue: string[] = [startPath];
  const results: string[] = [];
  const seen = new Set<string>();

  while (queue.length > 0 && results.length < 100) {
    const currentPath = queue.shift()!;

    const entries = await fs.promises.readdir(currentPath, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name) as AbsFilePath;
      const relFilePath = relativePath(context.cwd, fullPath);

      // Skip gitignored files (but allow hidden files if they have permissions)
      if (ig.ignores(relFilePath)) {
        continue;
      }

      // Check if we have read permissions for this path
      if (!(await canReadFile(fullPath, context))) {
        continue;
      }

      if (!seen.has(fullPath)) {
        seen.add(fullPath);

        if (entry.isDirectory()) {
          results.push(relFilePath + "/");
          queue.push(fullPath);
        } else {
          results.push(relFilePath);
        }
      }
    }
  }

  return results;
}

export class ListDirectoryTool implements StaticTool {
  state: State;
  toolName = "list_directory" as const;
  autoRespond = true;
  aborted: boolean = false;

  constructor(
    public request: ToolRequest,
    public context: {
      nvim: Nvim;
      cwd: NvimCwd;
      options: MagentaOptions;
      myDispatch: (msg: Msg) => void;
    },
  ) {
    this.state = {
      state: "processing",
    };
    this.listDirectory().catch((error) => {
      this.context.nvim.logger.error(
        `Error listing directory: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  isDone(): boolean {
    return this.state.state === "done";
  }

  isPendingUserAction(): boolean {
    return false;
  }

  abort(): ProviderToolResult {
    if (this.state.state === "done") {
      return this.getToolResult();
    }

    this.aborted = true;

    const result: ProviderToolResult = {
      type: "tool_result",
      id: this.request.id,
      result: {
        status: "error",
        error: "Request was aborted by the user.",
      },
    };

    this.state = {
      state: "done",
      result,
    };

    return result;
  }

  update(msg: Msg) {
    switch (msg.type) {
      case "finish":
        if (this.state.state == "processing") {
          this.state = {
            state: "done",
            result: {
              type: "tool_result",
              id: this.request.id,
              result: msg.result,
            },
          };
        }
        return;
      default:
        assertUnreachable(msg.type);
    }
  }

  async listDirectory() {
    try {
      const dirPath = (this.request.input.dirPath || ".") as UnresolvedFilePath;
      const absolutePath = resolveFilePath(this.context.cwd, dirPath);

      // Check if we have read permissions for the starting directory
      if (!(await canReadFile(absolutePath, this.context))) {
        if (this.aborted) return;
        this.context.myDispatch({
          type: "finish",
          result: {
            status: "error",
            error: `No read permission for directory \`${absolutePath}\``,
          },
        });
        return;
      }

      const files = await listDirectoryBFS(absolutePath, this.context);
      if (this.aborted) return;
      this.context.nvim.logger.debug(`files: ${files.join("\n")}`);
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "ok",
          value: [{ type: "text", text: files.join("\n") }],
        },
      });
    } catch (error) {
      if (this.aborted) return;
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: `Failed to list directory: ${(error as Error).message}`,
        },
      });
    }
  }

  getToolResult(): ProviderToolResult {
    switch (this.state.state) {
      case "processing":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: [
              {
                type: "text",
                text: `This tool use is being processed. Please proceed with your answer or address other parts of the question.`,
              },
            ],
          },
        };
      case "done":
        return this.state.result;
      default:
        assertUnreachable(this.state);
    }
  }

  renderSummary() {
    switch (this.state.state) {
      case "processing":
        return d`📁⚙️ list_directory ${withInlineCode(d`\`${this.request.input.dirPath || "."}\``)}`;
      case "done":
        return renderCompletedSummary({
          request: this.request as CompletedToolInfo["request"],
          result: this.state.result,
        });
      default:
        assertUnreachable(this.state);
    }
  }

  displayInput() {
    return `list_directory: {
    dirPath: ${this.request.input.dirPath || "."}
}`;
  }
}

function isError(result: CompletedToolInfo["result"]): boolean {
  return result.result.status === "error";
}

function getStatusEmoji(result: CompletedToolInfo["result"]): string {
  return isError(result) ? "❌" : "✅";
}

export function renderCompletedSummary(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const status = getStatusEmoji(info.result);
  return d`📁${status} list_directory ${withInlineCode(d`\`${input.dirPath || "."}\``)}`;
}

export const spec: ProviderToolSpec = {
  name: "list_directory" as ToolName,
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
  },
};

export type Input = {
  dirPath?: string;
};

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
