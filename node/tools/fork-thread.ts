import { d } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { StaticToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { StaticTool, ToolName } from "./types.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";

export type State = {
  state: "done";
  result: ProviderToolResult;
};

export class ForkThreadTool implements StaticTool {
  toolName = "fork_thread" as const;
  public state: State;

  constructor(
    public request: Extract<StaticToolRequest, { toolName: "fork_thread" }>,
    public context: { nvim: Nvim },
  ) {
    this.state = {
      state: "done",
      result: {
        type: "tool_result",
        id: this.request.id,
        result: {
          status: "ok",
          value: [{ type: "text", text: "" }], // this should never need to be sent to the agent
        },
      },
    };
  }

  isDone(): boolean {
    return this.state.state === "done";
  }

  abort() {}

  update(): void {}

  getToolResult(): ProviderToolResult {
    return this.state.result;
  }

  renderSummary() {
    return d``; // this should never need to be rendered
  }
}

export const spec: ProviderToolSpec = {
  name: "fork_thread" as ToolName,
  description: `\
This tool extracts specific portions of the conversation history that are directly relevant to the user's next prompt.

- Carefully examine what the user is asking for in their next prompt
- Identify key technical concepts and files they're focusing on
- Summarize ONLY information that directly supports addressing the next prompt
- Include files immediately relevant to the task in the context
- Mention other files that may be useful in the summary, but leave them out of the context. Make sure to mention all of
the files that were examined in the current conversation that may be relevant.`,
  input_schema: {
    type: "object",
    properties: {
      contextFiles: {
        type: "array",
        items: {
          type: "string",
        },
        description:
          "List of file names directly relevant to addressing the user's next prompt.",
      },
      summary: {
        type: "string",
        description: `\
Extract ONLY the specific parts of the thread that are directly relevant to the user's next prompt.
Focus on technical details, code patterns, and decisions that specifically help with the next task.
Do not include anything that isn't directly applicable to the next prompt's focus.
This should not restate anything relating to contextFiles, since those will be retained in full.`,
      },
    },
    required: ["contextFiles", "summary"],
  },
};

export type Input = {
  contextFiles: UnresolvedFilePath[];
  summary: string;
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.summary != "string") {
    return {
      status: "error",
      error: `expected req.input.summary to be a string but it was ${JSON.stringify(input.summary)}`,
    };
  }

  if (!Array.isArray(input.contextFiles)) {
    return {
      status: "error",
      error: `expected req.input.contextFiles to be an array but it was ${JSON.stringify(input.contextFiles)}`,
    };
  }

  if (!input.contextFiles.every((item) => typeof item === "string")) {
    return {
      status: "error",
      error: `expected all items in req.input.contextFiles to be strings but they were ${JSON.stringify(input.contextFiles)}`,
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
