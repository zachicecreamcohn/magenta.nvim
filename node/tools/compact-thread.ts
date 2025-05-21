import { d } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { ToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { ToolInterface } from "./types.ts";

export type State = {
  state: "done";
  result: ProviderToolResultContent;
};

export class CompactThreadTool implements ToolInterface {
  toolName = "compact_thread" as const;
  public state: State;

  constructor(
    public request: Extract<ToolRequest, { toolName: "compact_thread" }>,
    public context: { nvim: Nvim },
  ) {
    this.state = {
      state: "done",
      result: {
        type: "tool_result",
        id: this.request.id,
        result: {
          status: "ok",
          value: "", // this should never need to be sent to the agent
        },
      },
    };
  }

  abort() {}

  update(): void {}

  getToolResult(): ProviderToolResultContent {
    return this.state.result;
  }

  view() {
    return d``; // this should never need to be rendered
  }

  displayInput() {
    return `compact_thread: {
    summary: "${this.request.input.summary}",
    contextFiles: [${this.request.input.contextFiles.map((file) => `"${file}"`).join(", ")}],
    messageIndexes: [${this.request.input.messageIndexes.join(", ")}]
}`;
  }
}

export const spec: ProviderToolSpec = {
  name: "compact_thread",
  description: `Replace the current thread with a summary that's relevant for the remainder of the conversation.
Be strategic about space, and only keep the information that is necessary for getting started on the next user request.
When files or messages are really long, try to avoid including them in full. Instead, pick out just the relevant parts
in the summary.
The next thread will start with the user's prompt in full, exactly as it appears in the last message of the current thread, so you do not have to include anything about the last user prompt in this tool request.`,
  input_schema: {
    type: "object",
    properties: {
      contextFiles: {
        type: "array",
        items: {
          type: "string",
        },
        description:
          "List of file names to include in the context of the next thread.",
      },
      messageIndexes: {
        type: "array",
        items: {
          type: "number",
        },
        description:
          "List of message indexes to include in the context of the next thread. These messages will be copied in full.",
      },
      summary: {
        type: "string",
        description: `\
Text summarizing just the relevant pieces of the thread to the user's latest query.
This should not restate anything relating to the contextFiles or messageIndexes, since those will be included in the next thread in full.`,
      },
    },
    required: ["context", "summary"],
    additionalProperties: false,
  },
};

export type Input = {
  contextFiles: string[];
  messageIndexes: number[];
  summary: string;
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.summary != "string") {
    return {
      status: "error",
      error: "expected req.input.summary to be a string",
    };
  }

  if (!Array.isArray(input.contextFiles)) {
    return {
      status: "error",
      error: "expected req.input.contextFiles to be an array",
    };
  }

  if (!input.contextFiles.every((item) => typeof item === "string")) {
    return {
      status: "error",
      error: "expected all items in req.input.contextFiles to be strings",
    };
  }

  if (!Array.isArray(input.messageIndexes)) {
    return {
      status: "error",
      error: "expected req.input.messageIndexes to be an array",
    };
  }

  if (!input.messageIndexes.every((item) => typeof item === "number")) {
    return {
      status: "error",
      error: "expected all items in req.input.messageIndexes to be numbers",
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
