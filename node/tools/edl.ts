import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import type { Result } from "../utils/result.ts";
import type { CompletedToolInfo } from "./types.ts";

import type { Nvim } from "../nvim/nvim-node";
import type {
  ProviderToolResult,
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { StaticTool, ToolName, GenericToolRequest } from "./types.ts";
import { runScript } from "../edl/index.ts";

export type ToolRequest = GenericToolRequest<"edl", Input>;

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

export class EdlTool implements StaticTool {
  state: State;
  toolName = "edl" as const;
  autoRespond = true;
  aborted: boolean = false;

  constructor(
    public request: ToolRequest,
    public context: {
      nvim: Nvim;
      myDispatch: (msg: Msg) => void;
    },
  ) {
    this.state = {
      state: "processing",
    };
    this.executeScript().catch((error) => {
      this.context.nvim.logger.error(
        `Error executing EDL script: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
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

  update(msg: Msg) {
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

  async executeScript() {
    try {
      const script = this.request.input.script;
      const result = await runScript(script);

      if (this.aborted) return;

      if (result.status === "ok") {
        this.context.myDispatch({
          type: "finish",
          result: {
            status: "ok",
            value: [{ type: "text", text: result.result }],
          },
        });
      } else {
        this.context.myDispatch({
          type: "finish",
          result: {
            status: "error",
            error: result.error,
          },
        });
      }
    } catch (error) {
      if (this.aborted) return;
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: `Failed to execute EDL script: ${(error as Error).message}`,
        },
      });
    }
  }

  getToolResult(): ProviderToolResult {
    switch (this.state.state) {
      case "processing":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: [
              {
                type: "text",
                text: `This tool use is being processed. Please proceed with your answer or address other parts of the question.`,
              },
            ],
          },
        };
      case "done":
        return this.state.result;
      default:
        assertUnreachable(this.state);
    }
  }

  renderSummary() {
    switch (this.state.state) {
      case "processing":
        return d`📝⚙️ edl script executing...`;
      case "done":
        return renderCompletedSummary({
          request: this.request as CompletedToolInfo["request"],
          result: this.state.result,
        });
      default:
        assertUnreachable(this.state);
    }
  }

  displayInput() {
    const script = this.request.input.script;
    const preview =
      script.length > 100 ? script.substring(0, 100) + "..." : script;
    return `edl: {
    script: ${preview}
}`;
  }
}

function isError(result: CompletedToolInfo["result"]): boolean {
  return result.result.status === "error";
}

function getStatusEmoji(result: CompletedToolInfo["result"]): string {
  return isError(result) ? "❌" : "✅";
}

export function renderCompletedSummary(info: CompletedToolInfo): VDOMNode {
  const status = getStatusEmoji(info.result);
  return d`📝${status} edl script`;
}

export const spec: ProviderToolSpec = {
  name: "edl" as ToolName,
  description: `Execute an EDL (Edit Description Language) script to perform programmatic file edits.

EDL is a mini-language for selecting and modifying text in files. Commands are whitespace-separated.

## Commands

### File selection
- \`file \`path\`\` or \`file path\` - Select a file to edit

### Selection commands (patterns can be: /regex/, heredoc, line number like \`5:\`, line:col like \`5:10\`, \`bof\`, \`eof\`)
- \`select <pattern>\` - Select all matches
- \`select_first <pattern>\` - Select first match
- \`select_last <pattern>\` - Select last match
- \`select_one <pattern>\` - Select exactly one match (errors if 0 or >1)
- \`select_next <pattern>\` - Select next match after current selection
- \`select_prev <pattern>\` - Select previous match before current selection
- \`extend_forward <pattern>\` - Extend selection forward to include pattern
- \`extend_back <pattern>\` - Extend selection backward to include pattern
- \`nth <n>\` - Select the nth match (1-indexed)

### Mutation commands
- \`replace <<DELIM\\n...\\nDELIM\` - Replace selection with heredoc content
- \`delete\` - Delete the selection
- \`insert_before <<DELIM\\n...\\nDELIM\` - Insert before selection
- \`insert_after <<DELIM\\n...\\nDELIM\` - Insert after selection

### Registers
- \`cut <register>\` - Cut selection to named register
- \`paste <register>\` - Paste from named register

## Examples

Simple text replacement (like the replace tool):
\`\`\`
file \`src/utils.ts\`
select_one <<END
const oldValue = 42;
END
replace <<END
const newValue = 100;
END
\`\`\`

Insert after a match (like the insert tool):
\`\`\`
file \`src/utils.ts\`
select_one <<END
import { foo } from './foo';
END
insert_after <<END

import { bar } from './bar';
END
\`\`\`

Replace a function using regex:
\`\`\`
file \`src/utils.ts\`
select_one /function oldName\\(/
extend_forward /^}/
replace <<END
function newName() {
  return 42;
}
END
\`\`\`

Insert import at top of file:
\`\`\`
file \`src/index.ts\`
select bof
insert_after <<END
import { something } from './somewhere';
END
\`\`\`

Delete a line:
\`\`\`
file \`src/config.ts\`
select_one /const DEBUG = true;.*\\n/
delete
\`\`\``,
  input_schema: {
    type: "object",
    properties: {
      script: {
        type: "string",
        description: "The EDL script to execute",
      },
    },
    required: ["script"],
  },
};

export type Input = {
  script: string;
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.script !== "string") {
    return {
      status: "error",
      error: "expected req.input.script to be a string",
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
