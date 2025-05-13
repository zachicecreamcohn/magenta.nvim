import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { ToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { Nvim } from "../nvim/nvim-node";
import { applyEdit } from "./diff.ts";
import type { RootMsg } from "../root-msg.ts";
import type { MessageId } from "../chat/message.ts";
import type { ThreadId } from "../chat/thread.ts";
import type { ToolInterface } from "./types.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";

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

export class InsertTool implements ToolInterface {
  state: State;
  toolName = "insert" as const;

  constructor(
    public request: Extract<ToolRequest, { toolName: "insert" }>,
    public threadId: ThreadId,
    public messageId: MessageId,
    private context: {
      myDispatch: Dispatch<Msg>;
      nvim: Nvim;
      dispatch: Dispatch<RootMsg>;
    },
  ) {
    this.state = { state: "processing" };
    applyEdit(this.request, this.threadId, this.messageId, this.context).catch(
      (err: Error) =>
        this.context.myDispatch({
          type: "finish",
          result: {
            status: "error",
            error: err.message,
          },
        }),
    );
  }

  abort() {
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

  view(): VDOMNode {
    return d`${this.toolStatusIcon()} Insert [[ +${(
      (this.request.input.content.match(/\n/g) || []).length + 1
    ).toString()} ]] in \`${this.request.input.filePath}\` ${this.toolStatusView()}`;
  }

  toolStatusIcon(): string {
    switch (this.state.state) {
      case "processing":
        return "⏳";
      case "done":
        if (this.state.result.result.status == "error") {
          return "⚠️";
        } else {
          return "✏️";
        }
    }
  }

  toolStatusView(): VDOMNode {
    switch (this.state.state) {
      case "processing":
        return d`Processing insert...`;
      case "done":
        if (this.state.result.result.status == "error") {
          return d`Error: ${this.state.result.result.error}`;
        } else {
          return d`Success!
\`\`\`diff
${this.getInsertPreview()}
\`\`\``;
        }
    }
  }

  getInsertPreview(): string {
    const content = this.request.input.content;
    const lines = content.split("\n");
    const maxLines = 5;
    const maxLength = 80;

    let previewLines = lines.length > maxLines ? lines.slice(-maxLines) : lines;
    previewLines = previewLines.map((line) =>
      line.length > maxLength ? line.substring(0, maxLength) + "..." : line,
    );

    let result = previewLines.map((line) => "+ " + line).join("\n");
    if (lines.length > maxLines) {
      result = "...\n" + result;
    }

    return result;
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
    return `insert: {
    filePath: ${this.request.input.filePath}
    insertAfter: "${this.request.input.insertAfter}"
    content:
\`\`\`
${this.request.input.content}
\`\`\`
}`;
  }
}

export const spec: ProviderToolSpec = {
  name: "insert",
  description:
    "Insert content after the specified string in a file. You can also use this tool to create new files.",
  input_schema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: `Path to the file to modify. The file will be created if it does not exist yet.`,
      },
      insertAfter: {
        type: "string",
        description: `String after which to insert the content.

The \`insertAfter\` string MUST uniquely identify a single location in the file. Provide at least 2-3 lines of context from the target file to ensure that the insert only matches ONE location. This should exactly match the file content, including the exact indentation. Regular expressions are not supported.

The insertAfter text will not be changed.

Set insertAfter to the empty string to append to the end of the file.`,
      },
      content: {
        type: "string",
        description:
          "Content to insert immediately after the `insertAfter` text. Make sure you match the indentation of the file.",
      },
    },
    required: ["filePath", "insertAfter", "content"],
    additionalProperties: false,
  },
};

export type Input = {
  filePath: UnresolvedFilePath;
  insertAfter: string;
  content: string;
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

  if (typeof input.insertAfter != "string") {
    return {
      status: "error",
      error: "expected req.input.insertAfter to be a string",
    };
  }

  if (typeof input.content != "string") {
    return {
      status: "error",
      error: "expected req.input.content to be a string",
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
