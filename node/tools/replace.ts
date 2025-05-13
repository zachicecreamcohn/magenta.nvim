import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { ToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import { applyEdit } from "./applyEdit.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { RootMsg } from "../root-msg.ts";
import type { MessageId } from "../chat/message.ts";
import * as diff from "diff";
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

export class ReplaceTool implements ToolInterface {
  state: State;
  toolName = "replace" as const;

  constructor(
    public request: Extract<ToolRequest, { toolName: "replace" }>,
    public threadId: ThreadId,
    public messageId: MessageId,
    private context: {
      myDispatch: Dispatch<Msg>;
      dispatch: Dispatch<RootMsg>;
      nvim: Nvim;
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

  view(): VDOMNode {
    return d`${this.toolStatusIcon()} Replace [[ -${this.countLines(this.request.input.find).toString()} / +${this.countLines(
      this.request.input.replace,
    ).toString()} ]] in \`${this.request.input.filePath}\` ${this.toolStatusView()}`;
  }

  countLines(str: string) {
    return (str.match(/\n/g) || []).length + 1;
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
        return d`Processing replace...`;
      case "done":
        if (this.state.result.result.status == "error") {
          return d`Error: ${this.state.result.result.error}`;
        } else {
          return d`Success!
\`\`\`diff
${this.getReplacePreview()}
\`\`\``;
        }
    }
  }

  getReplacePreview(): string {
    const find = this.request.input.find;
    const replace = this.request.input.replace;

    const diffResult = diff.createPatch(
      this.request.input.filePath,
      find,
      replace,
      "before",
      "after",
      {
        context: 2,
        ignoreNewlineAtEof: true,
      },
    );

    // slice off the diff header
    const diffLines = diffResult.split("\n").slice(5);

    const maxLines = 10;
    const maxLength = 80;

    let previewLines =
      diffLines.length > maxLines
        ? diffLines.slice(diffLines.length - maxLines)
        : diffLines;

    previewLines = previewLines.map((line) => {
      if (line.length > maxLength) {
        return line.substring(0, maxLength) + "...";
      }
      return line;
    });

    // Add prefix indicators
    let result = previewLines.join("\n");

    // Add ellipsis if we truncated
    if (diffLines.length > maxLines) {
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

Break up replace opertations into multiple, smaller replace calls. Try to make each replace call meaningful and atomic.`,
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

If the text appears multiple times, only the first match will be replaced. If you would like to replace multiple instances of the same text, use multiple tool calls.

Special case: If \`find\` is an empty string (""), the entire file content will be replaced with the \`replace\` text.`,
      },
      replace: {
        type: "string",
        description: `The \`replace\` parameter will replace the \`find\` text.

This MUST be the complete and exact replacement text. Make sure to keep track of braces and indentation.`,
      },
    },
    required: ["filePath", "find", "replace"],
    additionalProperties: false,
  },
};

export type Input = {
  filePath: UnresolvedFilePath;
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
const FIND_KEY_STR = '"find":"';
const REPLACE_KEY_STR = '"replace":"';

export function renderStreamedBlock(streamed: string): VDOMNode {
  // Look for file path pattern
  const filePathMatch = streamed.match(/"filePath"\s*:\s*"([^"]+)"/);
  const filePath = filePathMatch ? filePathMatch[1] : null;

  // Count negative lines (find)
  let findLineCount = 1; // Start with 1 for the first line
  const findKeyIndex = streamed.indexOf(FIND_KEY_STR);
  if (findKeyIndex !== -1) {
    // Start after the opening quote
    for (let i = findKeyIndex + FIND_KEY_STR.length; i < streamed.length; i++) {
      const char = streamed[i];
      const prevChar = i > 0 ? streamed[i - 1] : "";

      if (char === '"' && prevChar !== "\\") {
        // Unescaped quote marks the end of content
        break;
      } else if (char === "n" && prevChar === "\\") {
        // Found a newline sequence
        findLineCount++;
      }
    }
  }

  // Count positive lines (replace)
  let replaceLineCount = 1; // Start with 1 for the first line
  const replaceKeyIndex = streamed.indexOf(REPLACE_KEY_STR);
  if (replaceKeyIndex !== -1) {
    // Start after the opening quote
    for (
      let i = replaceKeyIndex + REPLACE_KEY_STR.length;
      i < streamed.length;
      i++
    ) {
      const char = streamed[i];
      const prevChar = i > 0 ? streamed[i - 1] : "";

      if (char === '"' && prevChar !== "\\") {
        // Unescaped quote marks the end of content
        break;
      } else if (char === "n" && prevChar === "\\") {
        // Found a newline sequence
        replaceLineCount++;
      }
    }
  }

  // Format the message in the same style as the view method
  if (filePath) {
    return d`⏳ Replace [[ -${findLineCount.toString()} / +${replaceLineCount.toString()} ]] in \`${filePath}\` streaming...`;
  } else {
    return d`⏳ Preparing replace operation...`;
  }
}
