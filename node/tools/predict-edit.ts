import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { StaticToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResult,
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { MessageId } from "../chat/message.ts";
import type { ThreadId } from "../chat/types";
import type { StaticTool, ToolName } from "./types.ts";

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

export class PredictEditTool implements StaticTool {
  state: State;
  toolName = "predict_edit" as const;

  constructor(
    public request: Extract<StaticToolRequest, { toolName: "predict_edit" }>,
    public threadId: ThreadId,
    public messageId: MessageId,
    private context: {
      myDispatch: Dispatch<Msg>;
    },
  ) {
    this.state = { state: "processing" };

    // For now, just mark as done immediately
    setTimeout(() => {
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "ok",
          value: [{ type: "text", text: "Edit prediction completed." }],
        },
      });
    });
  }

  isDone(): boolean {
    return this.state.state === "done";
  }

  abort(): void {
    this.state = {
      state: "done",
      result: {
        type: "tool_result",
        id: this.request.id,
        result: {
          status: "error",
          error: "The user aborted this tool request.",
        },
      },
    };
  }

  update(msg: Msg): void {
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

  renderSummary(): VDOMNode {
    switch (this.state.state) {
      case "processing":
        return d`🔮⚙️ Predicting next edit...`;
      case "done":
        if (this.state.result.result.status === "error") {
          return d`🔮❌ Edit prediction failed - ${this.state.result.result.error}`;
        } else {
          return d`🔮✅ Edit prediction completed`;
        }
      default:
        assertUnreachable(this.state);
    }
  }

  renderPreview(): VDOMNode {
    return d``;
  }

  renderDetail(): VDOMNode {
    return d`Edit prediction tool executed`;
  }

  getToolResult(): ProviderToolResult {
    switch (this.state.state) {
      case "done":
        return this.state.result;
      case "processing":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: [
              { type: "text", text: `This tool use is being processed.` },
            ],
          },
        };
      default:
        assertUnreachable(this.state);
    }
  }
}

export const spec: ProviderToolSpec = {
  name: "predict_edit" as ToolName,
  description: `Predicts the user's next edit based on recent changes and current context.`,
  input_schema: {
    type: "object",
    properties: {
      find: {
        type: "string",
        description: `\`find\` identifies the text you want to replace.
This should be the complete text to replace, exactly as it appears in the provided context, including indentation.
Regular expressions are not supported.
Make sure to remove │ from this parameter, as it is a cursor indicator and not actually present in the text.
`,
      },
      replace: {
        type: "string",
        description: `This will replace the find text.
This MUST be the complete and exact replacement text. Make sure to match braces and indentation.
Make sure to remove │ from this parameter, as it is a cursor indicator and not actually present in the text.`,
      },
    },
    required: ["find", "replace"],
  },
};

export type Input = {
  find: string;
  replace: string;
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.find != "string") {
    return {
      status: "error",
      error: "expected req.input.find to be a string",
    };
  }

  if (typeof input.replace != "string") {
    return {
      status: "error",
      error: "expected req.input.replace to be a string",
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
