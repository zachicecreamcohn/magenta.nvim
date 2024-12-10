import * as Anthropic from "@anthropic-ai/sdk";
import { Context } from "../types";
import { ToolResultBlockParam } from "@anthropic-ai/sdk/resources";
import { Buffer } from "neovim";
import { Line } from "../part";
import { assertUnreachable } from "../utils/assertUnreachable";

type State =
  | {
      state: "pending-user-action";
    }
  | {
      state: "done";
      result: ToolResultBlockParam;
    };

export class InsertProcess {
  public readonly autoRespond = false;
  private _state: State;
  private subscriptions: Map<string, (state: State) => void> = new Map();
  private insertLocation: number = 0;

  get state(): State {
    return this._state;
  }

  private set state(newState: State) {
    this._state = newState;
    this.notify();
  }

  constructor(
    public request: InsertToolUseRequest,
    private context: Context,
  ) {
    this._state = { state: "pending-user-action" };
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

  async displayDiff(): Promise<void> {
    this.state = { state: "pending-user-action" };

    const { nvim } = this.context;
    const filePath = this.request.input.filePath;

    await nvim.command(`vsplit ${filePath}`);
    const fileBuffer = await nvim.buffer;
    // TODO: confirm that we opened the buffer successfully
    await nvim.command("diffthis");

    const lines = await fileBuffer.getLines({
      start: 0,
      end: -1,
      strictIndexing: false,
    });

    const scratchBuffer = (await nvim.createBuffer(false, true)) as Buffer;
    await scratchBuffer.setLines(lines, {
      start: 0,
      end: -1,
      strictIndexing: false,
    });

    let lineNumber = 0;
    let currentPos = 0;
    const content = lines.join("\n");
    while (currentPos < this.insertLocation) {
      currentPos = content.indexOf("\n", currentPos);
      if (currentPos === -1 || currentPos > this.insertLocation) break;
      lineNumber++;
      currentPos++;
    }

    // Insert the new content at the correct line
    const insertLines = this.request.input.content.split("\n");
    await scratchBuffer.setLines(insertLines, {
      start: lineNumber + 1,
      end: lineNumber + 1,
      strictIndexing: true,
    });

    // Display the diff
    await nvim.command("vsplit");
    await nvim.command(`b ${scratchBuffer.id}`);
    await nvim.command("diffthis");
  }

  getLines(): Line[] {
    switch (this.state.state) {
      case "pending-user-action":
        return ["⏳ Pending approval" as Line];
      case "done":
        return ["✅ Complete" as Line];
      default:
        assertUnreachable(this.state);
    }
  }
}

export class InsertTool {
  constructor() {}

  execRequest(request: InsertToolUseRequest, context: Context): InsertProcess {
    return new InsertProcess(request, context);
  }

  spec(): Anthropic.Anthropic.Tool {
    return {
      name: "insert",
      description:
        "Insert text after a specified pattern in a file. The pattern must match exactly.",
      input_schema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Path to the file to insert text into",
          },
          insertAfter: {
            type: "string",
            description: "Pattern to insert text after",
          },
          content: {
            type: "string",
            description: "Content to insert",
          },
        },
        required: ["filePath", "insertAfter", "content"],
      },
    };
  }
}

export interface InsertToolUseRequest {
  type: "tool_use";
  id: string;
  name: "insert";
  input: {
    filePath: string;
    insertAfter: string;
    content: string;
  };
}
