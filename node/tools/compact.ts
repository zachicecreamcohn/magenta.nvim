import { d, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider-types.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type {
  GenericToolRequest,
  StaticTool,
  ToolName,
  CompletedToolInfo,
} from "./types.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { Thread } from "../chat/thread.ts";

export type Msg = {
  type: "finish";
};

export type State = {
  state: "done";
  result: ProviderToolResult;
};

export class CompactTool implements StaticTool {
  toolName = "compact" as const;
  public state: State;
  public aborted: boolean = false;

  constructor(
    public request: ToolRequest,
    public context: {
      nvim: Nvim;
      thread: Thread;
      myDispatch: Dispatch<Msg>;
    },
  ) {
    this.state = {
      state: "done",
      result: {
        type: "tool_result",
        id: this.request.id,
        result: {
          status: "ok",
          value: [],
        },
      },
    };
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

  update(msg: Msg): void {
    switch (msg.type) {
      case "finish":
        this.state = {
          state: "done",
          result: {
            type: "tool_result",
            id: this.request.id,
            result: this.aborted
              ? {
                  status: "error",
                  error: "Compact operation was aborted.",
                }
              : {
                  status: "ok",
                  value: [
                    { type: "text", text: "Thread compacted successfully." },
                  ],
                },
          },
        };
        return;
    }
  }

  getToolResult(): ProviderToolResult {
    return this.state.result;
  }

  renderSummary() {
    switch (this.state.state) {
      case "done":
        return renderCompletedSummary({
          request: this.request as CompletedToolInfo["request"],
          result: this.state.result,
        });
    }
  }
}

function isError(result: ProviderToolResult): boolean {
  return result.result.status === "error";
}

function getStatusEmoji(result: ProviderToolResult): string {
  return isError(result) ? "❌" : "✅";
}

export function renderCompletedSummary(info: CompletedToolInfo): VDOMNode {
  const status = getStatusEmoji(info.result);
  return d`📦${status} compact`;
}

export const spec: ProviderToolSpec = {
  name: "compact" as ToolName,
  description: `Compact the conversation thread by replacing message ranges with summaries.

Use this tool when:
- The thread is getting long and you want to reduce context size
- There are repetitive tool calls or content that can be summarized
- You want to preserve important information while removing verbose details

The tool will:
- Replace content between checkpoints with your summary
- Strip system reminders from user messages in the affected range
- Strip thinking blocks from assistant messages in the affected range

If you want to continue with a specific action after compaction, use the continuation parameter.`,
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "Text to replace the range with. Use empty string to delete the range.",
      },
      contextFiles: {
        type: "array",
        items: {
          type: "string",
        },
        description:
          "Optional list of file paths to provide as context to the sub-agent.",
      },
      continuation: {
        type: "string",
        description:
          "Optional message to append after compaction. The agent will continue streaming after this message is added.",
      },
    },
    required: ["summary"],
  },
};

export type Input = {
  summary: string;
  contextFiles?: string[];
  continuation?: string;
};

export type ToolRequest = GenericToolRequest<"compact", Input>;

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.summary !== "string") {
    return {
      status: "error",
      error: `expected req.input.summary to be a string but it was ${JSON.stringify(input.summary)}`,
    };
  }

  if (input.contextFiles !== undefined) {
    if (!Array.isArray(input.contextFiles)) {
      return {
        status: "error",
        error: `expected req.input.contextFiles to be an array or undefined`,
      };
    }
    for (let i = 0; i < input.contextFiles.length; i++) {
      if (typeof input.contextFiles[i] !== "string") {
        return {
          status: "error",
          error: `expected req.input.contextFiles[${i}] to be a string`,
        };
      }
    }
  }

  if (
    input.continuation !== undefined &&
    typeof input.continuation !== "string"
  ) {
    return {
      status: "error",
      error: `expected req.input.continuation to be a string or undefined`,
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
