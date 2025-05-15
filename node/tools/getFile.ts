import { getBufferIfOpen } from "../utils/buffers.ts";
import fs from "fs";
import path from "path";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, withBindings } from "../tea/view.ts";
import { type ToolRequest } from "./toolManager.ts";
import { type Result } from "../utils/result.ts";
import { getcwd } from "../nvim/nvim.ts";
import type { Nvim } from "../nvim/nvim-node";
import { readGitignore } from "./util.ts";
import type {
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { Dispatch, Thunk } from "../tea/tea.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { ToolInterface } from "./types.ts";

export type State =
  | {
      state: "pending";
    }
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

export type Msg =
  | {
      type: "finish";
      result: Result<string>;
    }
  | {
      type: "automatic-approval";
    }
  | {
      type: "request-user-approval";
    }
  | {
      type: "user-approval";
      approved: boolean;
    };

export class GetFileTool implements ToolInterface {
  state: State;
  toolName = "get_file" as const;

  constructor(
    public request: Extract<ToolRequest, { toolName: "get_file" }>,
    public context: { nvim: Nvim; myDispatch: Dispatch<Msg> },
  ) {
    this.state = {
      state: "pending",
    };

    // wrap in setTimeout to force new eventloop frame, to avoid dispatch-in-dispatch
    setTimeout(() => {
      this.initReadFile().catch((error: Error) =>
        this.context.myDispatch({
          type: "finish",
          result: {
            status: "error",
            error: error.message + "\n" + error.stack,
          },
        }),
      );
    });
  }

  /** this is expected to be invoked as part of a dispatch, so we don't need to dispatch here to update the view
   */
  abort() {
    this.state = {
      state: "done",
      result: {
        type: "tool_result",
        id: this.request.id,
        result: { status: "error", error: `The user aborted this request.` },
      },
    };
  }

  update(msg: Msg): Thunk<Msg> | undefined {
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
      case "request-user-approval":
        if (this.state.state == "pending") {
          this.state = {
            state: "pending-user-action",
          };
        }
        return;
      case "user-approval": {
        if (this.state.state === "pending-user-action") {
          if (msg.approved) {
            this.state = {
              state: "processing",
              approved: true,
            };

            // wrap in setTimeout to force a new eventloop frame, to avoid dispatch-in-dispatch
            setTimeout(() => {
              this.readFile().catch((error: Error) =>
                this.context.myDispatch({
                  type: "finish",
                  result: {
                    status: "error",
                    error: error.message + "\n" + error.stack,
                  },
                }),
              );
            });
            return;
          } else {
            this.state = {
              state: "done",
              result: {
                type: "tool_result",
                id: this.request.id,
                result: {
                  status: "error",
                  error: `The user did not allow the reading of this file.`,
                },
              },
            };
            return;
          }
        }
        return;
      }

      case "automatic-approval": {
        if (this.state.state == "pending") {
          this.state = {
            state: "processing",
            approved: true,
          };

          // wrap in setTimeout to force a new eventloop frame, to avoid dispatch-in-dispatch
          setTimeout(() => {
            this.readFile().catch((error: Error) =>
              this.context.myDispatch({
                type: "finish",
                result: {
                  status: "error",
                  error: error.message + "\n" + error.stack,
                },
              }),
            );
          });
        }
        return;
      }
      default:
        assertUnreachable(msg);
    }
  }

  async initReadFile(): Promise<void> {
    const filePath = this.request.input.filePath;
    const cwd = await getcwd(this.context.nvim);
    const absolutePath = path.resolve(cwd, filePath);
    const relativePath = path.relative(cwd, absolutePath);

    if (this.state.state === "pending") {
      if (!absolutePath.startsWith(cwd)) {
        this.context.myDispatch({ type: "request-user-approval" });
        return;
      }

      if (relativePath.split(path.sep).some((part) => part.startsWith("."))) {
        this.context.myDispatch({ type: "request-user-approval" });
        return;
      }

      const ig = await readGitignore(cwd);
      if (ig.ignores(relativePath)) {
        this.context.myDispatch({ type: "request-user-approval" });
        return;
      }
    }

    this.context.myDispatch({
      type: "automatic-approval",
    });
  }

  async readFile() {
    const filePath = this.request.input.filePath;
    const bufferContents = await getBufferIfOpen({
      unresolvedPath: filePath,
      context: this.context,
    });

    if (bufferContents.status === "ok") {
      this.context.myDispatch({
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
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: bufferContents.error,
        },
      });
      return;
    }

    const cwd = await getcwd(this.context.nvim);
    const absolutePath = path.resolve(cwd, filePath);
    const fileContent = await fs.promises.readFile(absolutePath, "utf-8");
    this.context.myDispatch({
      type: "finish",
      result: {
        status: "ok",
        value: fileContent,
      },
    });
    return;
  }

  getToolResult(): ProviderToolResultContent {
    switch (this.state.state) {
      case "pending":
      case "processing":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: `This tool use is being processed. Please proceed with your answer or address other parts of the question.`,
          },
        };
      case "pending-user-action":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: `Waiting for user approval to finish processing this tool use.`,
          },
        };
      case "done":
        return this.state.result;
      default:
        assertUnreachable(this.state);
    }
  }

  view(dispatch: Dispatch<Msg>) {
    switch (this.state.state) {
      case "pending":
      case "processing":
        return d`⚙️ Reading file ${this.request.input.filePath}`;
      case "pending-user-action":
        return d`⏳ May I read file \`${this.request.input.filePath}\`? ${withBindings(
          d`**[ NO ]**`,
          {
            "<CR>": () => dispatch({ type: "user-approval", approved: false }),
          },
        )} ${withBindings(d`**[ OK ]**`, {
          "<CR>": () => dispatch({ type: "user-approval", approved: true }),
        })}`;
      case "done":
        if (this.state.result.result.status == "error") {
          return d`❌ Error reading file \`${this.request.input.filePath}\`: ${this.state.result.result.error}`;
        } else {
          return d`✅ Finished reading file \`${this.request.input.filePath}\``;
        }
      default:
        assertUnreachable(this.state);
    }
  }

  displayInput() {
    return `get_file: {
    filePath: ${this.request.input.filePath}
}`;
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
  filePath: UnresolvedFilePath;
};

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
