import fs from "fs";
import path from "path";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, withInlineCode, type VDOMNode } from "../tea/view.ts";
import type { Result } from "../utils/result.ts";
import type { CompletedToolInfo } from "./types.ts";

import type { Nvim } from "../nvim/nvim-node";
import { readAllGitignoresSync, readGitignoreForPath } from "./util.ts";
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
  type HomeDir,
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
    homeDir: HomeDir;
    nvim: Nvim;
    options: MagentaOptions;
  },
  includeGitignored: boolean = false,
): Promise<string[]> {
  // Determine if we're listing inside or outside cwd
  const relToStart = relativePath(context.cwd, startPath);
  const isOutsideCwd = relToStart.startsWith("../");

  // Use appropriate gitignore: cwd's gitignore for inside, or walk up from startPath for outside
  const ig = includeGitignored
    ? null
    : isOutsideCwd
      ? readGitignoreForPath(startPath)
      : readAllGitignoresSync(context.cwd);

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

      // Check gitignore if not including gitignored files
      if (ig) {
        // For gitignore checking, use path relative to the appropriate base
        let relForIgnore: string = isOutsideCwd
          ? relativePath(startPath as NvimCwd, fullPath)
          : relativePath(context.cwd, fullPath);

        // Append trailing slash for directories (required for patterns like "build/")
        if (entry.isDirectory()) {
          relForIgnore = relForIgnore + "/";
        }

        // Check gitignore (only if not a ../ path, which can happen in edge cases)
        if (!relForIgnore.startsWith("../") && ig.ignores(relForIgnore)) {
          continue;
        }
      }

      // Check if we have read permissions for this path
      if (!(await canReadFile(fullPath, context))) {
        continue;
      }

      // For display, always show path relative to cwd
      const relFilePath = relativePath(context.cwd, fullPath);

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
      homeDir: HomeDir;
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
      const includeGitignored = this.request.input.includeGitignored ?? false;

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

      const files = await listDirectoryBFS(
        absolutePath,
        this.context,
        includeGitignored,
      );
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
  description: `List up to 100 files in a directory using breadth-first search. By default, respects .gitignore files (checks the directory and all parent directories up to the git root, just like git does). Hidden files require explicit read permissions.`,
  input_schema: {
    type: "object",
    properties: {
      dirPath: {
        type: "string",
        description: `The directory path relative to cwd. Use "." to list whole directory.`,
      },
      includeGitignored: {
        type: "boolean",
        description: `If true, include files that would normally be excluded by .gitignore. Default is false.`,
      },
    },
    required: ["dirPath"],
  },
};

export type Input = {
  dirPath?: string;
  includeGitignored?: boolean;
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

  if (
    input.includeGitignored !== undefined &&
    typeof input.includeGitignored !== "boolean"
  ) {
    return {
      status: "error",
      error: "expected req.input.includeGitignored to be a boolean if provided",
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
