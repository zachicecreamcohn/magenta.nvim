import * as Anthropic from "@anthropic-ai/sdk";
import { Context } from "../types.js";
import { getBufferIfOpen } from "../utils/buffers.js";
import fs from "fs";
import path from "path";
import { Line } from "../part.js";
import { assertUnreachable } from "../utils/assertUnreachable.js";
import { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";

type State =
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

export class FileToolProcess {
  public readonly autoRespond = true;
  private _state: State;
  private subscriptions: Map<string, (state: State) => void> = new Map();

  get state(): State {
    return this._state;
  }

  private set state(newState: State) {
    this._state = newState;
    this.notify();
  }

  constructor(
    public request: GetFileToolUseRequest,
    private context: Context,
  ) {
    this._state = { state: "processing" };

    this.process().catch((err) => this.context.logger.error(err as Error));
  }

  async process() {
    const { nvim } = this.context;
    const filePath = this.request.input.filePath;
    this.context.logger.trace(`request: ${JSON.stringify(this.request)}`);
    const bufferContents = await getBufferIfOpen({
      context: this.context,
      relativePath: filePath,
    });

    if (bufferContents.status === "ok") {
      this.state = {
        state: "done",
        result: {
          type: "tool_result",
          tool_use_id: this.request.id,
          content: bufferContents.result,
          is_error: false,
        },
      };
      return;
    }

    if (bufferContents.status === "error") {
      this.state = {
        state: "done",
        result: {
          type: "tool_result",
          tool_use_id: this.request.id,
          content: bufferContents.error,
          is_error: true,
        },
      };
      return;
    }

    try {
      const cwd = (await nvim.call("getcwd")) as string;
      const absolutePath = path.resolve(cwd, filePath);

      if (!absolutePath.startsWith(cwd)) {
        this.state = {
          state: "done",
          result: {
            type: "tool_result",
            tool_use_id: this.request.id,
            content: "The path must be inside of neovim cwd",
            is_error: true,
          },
        };
        return;
      }

      const fileContent = await fs.promises.readFile(absolutePath, "utf-8");
      this.state = {
        state: "done",
        result: {
          type: "tool_result",
          tool_use_id: this.request.id,
          content: fileContent,
          is_error: false,
        },
      };
      return;
    } catch (error) {
      this.state = {
        state: "done",
        result: {
          type: "tool_result",
          tool_use_id: this.request.id,
          content: `Failed to read file: ${(error as Error).message}`,
          is_error: true,
        },
      };
    }
  }

  subscribe(callback: (state: State) => void): () => void {
    const token = Math.random().toString(36).substring(2);
    this.subscriptions.set(token, callback);

    return () => {
      this.subscriptions.delete(token);
    };
  }

  private notify(): void {
    this.subscriptions.forEach((callback) => callback(this.state));
  }

  getLines(): Line[] {
    switch (this.state.state) {
      case "processing":
        return ["⚙️ Processing" as Line];
      case "pending-user-action":
        return ["⏳ Pending approval" as Line];
      case "done":
        return ["✅ Complete" as Line];
      default:
        assertUnreachable(this.state);
    }
  }
}

export class FileTool {
  constructor() {}

  execRequest(request: GetFileToolUseRequest, context: Context) {
    return new FileToolProcess(request, context);
  }

  spec(): Anthropic.Anthropic.Tool {
    return {
      name: "get_file",
      description: `Get the full contents of a file in the project directory.`,
      input_schema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description:
              "the path, relative to the project root, of the file. e.g. ./src/index.js",
          },
        },
        required: ["path"],
      },
    };
  }
}

export type GetFileToolUseRequest = {
  type: "tool_use";
  id: string; //"toolu_01UJtsBsBED9bwkonjqdxji4"
  name: "get_file";
  input: {
    filePath: string; //"./src/index.js"
  };
};
