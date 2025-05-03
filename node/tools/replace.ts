import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { ToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { Nvim } from "nvim-node";
import { applyEdit } from "./diff.ts";

export type State =
  | {
      state: "processing";
    }
  | {
      state: "done";
      result: ProviderToolResultContent;
    };

export type Msg = {
  type: "finish";
  result: Result<string>;
};

export class ReplaceTool {
  state: State;
  toolName = "replace" as const;

  constructor(
    public request: Extract<ToolRequest, { toolName: "replace" }>,
    private context: {
      dispatch: Dispatch<Msg>;
      nvim: Nvim;
    },
  ) {
    this.state = { state: "processing" };
    applyEdit(this.request, this.context).catch((err: Error) =>
      this.context.dispatch({
        type: "finish",
        result: {
          status: "error",
          error: err.message,
        },
      }),
    );
  }

  update(msg: Msg): void {
    switch (msg.type) {
      case "finish":
        this.state = {
          state: "done",
          result: {
            type: "tool_result",
            id: this.request.id,
            result: msg.result,
          },
        };
        return;
      default:
        assertUnreachable(msg.type);
    }
  }

  view(): VDOMNode {
    return d`Replace [[ -${this.countLines(this.request.input.find).toString()} / +${this.countLines(
      this.request.input.replace,
    ).toString()} ]] in \`${this.request.input.filePath}\` ${this.toolStatusView()}`;
  }

  countLines(str: string) {
    return (str.match(/\n/g) || []).length + 1;
  }

  toolStatusView(): VDOMNode {
    switch (this.state.state) {
      case "processing":
        return d`⏳ Processing replace in file \`${this.request.input.filePath}\`.`;
      case "done":
        if (this.state.result.result.status == "error") {
          return d`⚠️ Error: ${JSON.stringify(this.state.result.result.error, null, 2)}`;
        } else {
          return d`✏️ Success: ${this.state.result.result.value}`;
        }
    }
  }

  getToolResult(): ProviderToolResultContent {
    switch (this.state.state) {
      case "done":
        return this.state.result;
      case "processing":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: `This tool use is being processed.`,
          },
        };
      default:
        assertUnreachable(this.state);
    }
  }

  displayInput() {
    return `replace: {
    filePath: ${this.request.input.filePath}
    match:
\`\`\`
${this.request.input.find}
\`\`\`
    replace:
\`\`\`
${this.request.input.replace}
\`\`\`
}`;
  }
}

export const spec: ProviderToolSpec = {
  name: "replace",
  description: `This is a tool for replacing text in a file.

Break up replace opertations into multiple, smaller tool invocations to avoid repeating large sections of the existing code.`,
  input_schema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path of the file to modify.",
      },
      find: {
        type: "string",
        description: `The text to replace.

\`find\` MUST uniquely identify the text you want to replace. Provide sufficient context lines above and below the edit to ensure that only one location in the file matches this text.

This should be the complete text to replace, exactly as it appears in the file, including indentation. Regular expressions are not supported.

If the text appears multiple times, only the first match will be replaced. If you would like to replace multiple instances of the same text, use multiple tool calls to change each instance.`,
      },
      replace: {
        type: "string",
        description: `The \`replace\` parameter will replace the \`find\` text.

This MUST be the complete and exact replacement text. It should repeat the context lines that should not change, including indentation.`,
      },
    },
    required: ["filePath", "find", "replace"],
    additionalProperties: false,
  },
};

export type Input = {
  filePath: string;
  find: string;
  replace: string;
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
