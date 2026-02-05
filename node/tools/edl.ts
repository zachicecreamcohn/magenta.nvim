import { assertUnreachable } from "../utils/assertUnreachable.ts";
import {
  d,
  withBindings,
  withCode,
  withExtmark,
  type VDOMNode,
} from "../tea/view.ts";
import type { Result } from "../utils/result.ts";
import type { CompletedToolInfo } from "./types.ts";

import type { Nvim } from "../nvim/nvim-node";
import {
  resolveFilePath,
  displayPath,
  type UnresolvedFilePath,
  type NvimCwd,
  type HomeDir,
} from "../utils/files.ts";
import type { MagentaOptions } from "../options.ts";
import { canReadFile, canWriteFile } from "./permissions.ts";
import type {
  ProviderToolResult,
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { StaticTool, ToolName, GenericToolRequest } from "./types.ts";
import {
  runScript,
  analyzeFileAccess,
  type EdlResultData,
  type FileAccessInfo,
} from "../edl/index.ts";

export type ToolRequest = GenericToolRequest<"edl", Input>;

export type State =
  | {
      state: "pending";
    }
  | {
      state: "pending-user-action";
      deniedFiles: DeniedFileAccess[];
    }
  | {
      state: "processing";
    }
  | {
      state: "done";
      result: ProviderToolResult;
    };

type DeniedFileAccess = FileAccessInfo & {
  displayPath: string;
};

export type Msg =
  | {
      type: "finish";
      result: Result<ProviderToolResultContent[]>;
    }
  | {
      type: "permissions-ok";
    }
  | {
      type: "permissions-denied";
      deniedFiles: DeniedFileAccess[];
    }
  | {
      type: "user-approval";
      approved: boolean;
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
      cwd: NvimCwd;
      homeDir: HomeDir;
      options: MagentaOptions;
      myDispatch: (msg: Msg) => void;
    },
  ) {
    this.state = {
      state: "pending",
    };

    setTimeout(() => {
      this.checkPermissions().catch((error) => {
        this.context.nvim.logger.error(
          `Error checking EDL permissions: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
  }

  isDone(): boolean {
    return this.state.state === "done";
  }

  isPendingUserAction(): boolean {
    return this.state.state === "pending-user-action";
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

      case "permissions-ok":
        if (this.state.state === "pending") {
          this.state = { state: "processing" };
          this.executeScript().catch((error) => {
            this.context.nvim.logger.error(
              `Error executing EDL script: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        }
        return;

      case "permissions-denied":
        if (this.state.state === "pending") {
          this.state = {
            state: "pending-user-action",
            deniedFiles: msg.deniedFiles,
          };
        }
        return;

      case "user-approval":
        if (this.state.state === "pending-user-action") {
          if (msg.approved) {
            this.state = { state: "processing" };
            this.executeScript().catch((error) => {
              this.context.nvim.logger.error(
                `Error executing EDL script: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
          } else {
            this.state = {
              state: "done",
              result: {
                type: "tool_result",
                id: this.request.id,
                result: {
                  status: "error",
                  error:
                    "The user did not approve the file access required by this EDL script.",
                },
              },
            };
          }
        }
        return;

      default:
        assertUnreachable(msg);
    }
  }

  async checkPermissions() {
    if (this.aborted) return;

    const script = this.request.input.script;
    let fileAccesses: FileAccessInfo[];
    try {
      fileAccesses = analyzeFileAccess(script);
    } catch {
      // If parsing fails, we'll let executeScript handle the error
      this.context.myDispatch({ type: "permissions-ok" });
      return;
    }

    if (fileAccesses.length === 0) {
      this.context.myDispatch({ type: "permissions-ok" });
      return;
    }

    const deniedFiles: DeniedFileAccess[] = [];

    for (const access of fileAccesses) {
      const absPath = resolveFilePath(
        this.context.cwd,
        access.path as UnresolvedFilePath,
        this.context.homeDir,
      );
      const dp = displayPath(this.context.cwd, absPath, this.context.homeDir);

      if (access.read) {
        const canRead = await canReadFile(absPath, this.context);
        if (!canRead) {
          deniedFiles.push({ ...access, displayPath: dp });
          continue;
        }
      }

      if (access.write) {
        const hasWrite = canWriteFile(absPath, this.context);
        if (!hasWrite) {
          deniedFiles.push({ ...access, displayPath: dp });
        }
      }
    }

    if (deniedFiles.length === 0) {
      this.context.myDispatch({ type: "permissions-ok" });
    } else {
      this.context.myDispatch({
        type: "permissions-denied",
        deniedFiles,
      });
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
            value: [
              { type: "text", text: result.formatted },
              {
                type: "text",
                text: `\n\n__EDL_DATA__${JSON.stringify(result.data)}`,
              },
            ],
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
      case "pending":
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
      case "pending-user-action":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: [
              {
                type: "text",
                text: `Waiting for user approval to access files required by this EDL script.`,
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
      case "pending":
        return d`📝⚙️ edl checking permissions...`;
      case "pending-user-action": {
        const fileList = this.state.deniedFiles
          .map((f) => {
            const access = f.write ? "read/write" : "read";
            return `  ${f.displayPath} (${access})`;
          })
          .join("\n");
        return d`📝⏳ EDL script needs file access:
${fileList}

┌───────────────────┐
│ ${withBindings(
          withExtmark(d`[ NO ]`, {
            hl_group: ["ErrorMsg", "@markup.strong.markdown"],
          }),
          {
            "<CR>": () =>
              this.context.myDispatch({
                type: "user-approval",
                approved: false,
              }),
          },
        )} ${withBindings(
          withExtmark(d`[ YES ]`, {
            hl_group: ["String", "@markup.strong.markdown"],
          }),
          {
            "<CR>": () =>
              this.context.myDispatch({
                type: "user-approval",
                approved: true,
              }),
          },
        )} │
└───────────────────┘`;
      }
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

  renderPreview() {
    const abridged = abridgeScript(this.request.input.script);
    switch (this.state.state) {
      case "pending":
      case "pending-user-action":
      case "processing":
        return withCode(d`\`\`\`
${abridged}
\`\`\``);
      case "done":
        return renderCompletedPreview({
          request: this.request as CompletedToolInfo["request"],
          result: this.state.result,
        });
      default:
        assertUnreachable(this.state);
    }
  }

  renderDetail() {
    const scriptBlock = withCode(d`\`\`\`
${this.request.input.script}
\`\`\``);
    switch (this.state.state) {
      case "pending":
      case "pending-user-action":
      case "processing":
        return scriptBlock;
      case "done":
        return d`${scriptBlock}
${renderCompletedDetail({
  request: this.request as CompletedToolInfo["request"],
  result: this.state.result,
})}`;
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

const PREVIEW_MAX_LINES = 10;
const PREVIEW_MAX_LINE_LENGTH = 80;

function abridgeScript(script: string): string {
  const lines = script.split("\n");
  const preview = lines
    .slice(0, PREVIEW_MAX_LINES)
    .map((line) =>
      line.length > PREVIEW_MAX_LINE_LENGTH
        ? line.substring(0, PREVIEW_MAX_LINE_LENGTH) + "..."
        : line,
    );
  if (lines.length > PREVIEW_MAX_LINES) {
    preview.push(`... (${lines.length - PREVIEW_MAX_LINES} more lines)`);
  }
  return preview.join("\n");
}
function isError(result: CompletedToolInfo["result"]): boolean {
  return result.result.status === "error";
}

function getStatusEmoji(result: CompletedToolInfo["result"]): string {
  return isError(result) ? "❌" : "✅";
}

function extractEdlData(info: CompletedToolInfo): EdlResultData | undefined {
  if (info.result.result.status !== "ok") return undefined;
  const content = info.result.result.value;
  for (const item of content) {
    if (item.type === "text" && item.text.startsWith("\n\n__EDL_DATA__")) {
      try {
        return JSON.parse(
          item.text.slice("\n\n__EDL_DATA__".length),
        ) as EdlResultData;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function extractFormattedResult(info: CompletedToolInfo): string {
  if (info.result.result.status !== "ok") {
    return info.result.result.error;
  }
  const content = info.result.result.value;
  for (const item of content) {
    if (item.type === "text" && !item.text.startsWith("\n\n__EDL_DATA__")) {
      return item.text;
    }
  }
  return "";
}

export function renderCompletedSummary(info: CompletedToolInfo): VDOMNode {
  const status = getStatusEmoji(info.result);
  const data = extractEdlData(info);

  if (data) {
    const totalMutations = data.mutations.reduce(
      (acc, m) =>
        acc +
        m.summary.replacements +
        m.summary.insertions +
        m.summary.deletions,
      0,
    );
    const filesCount = data.mutations.length;
    return d`📝${status} edl: ${String(totalMutations)} mutations in ${String(filesCount)} file${filesCount !== 1 ? "s" : ""}`;
  }

  return d`📝${status} edl script`;
}

export function renderCompletedPreview(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const abridged = abridgeScript(input.script);
  const scriptBlock = withCode(d`\`\`\`
${abridged}
\`\`\``);
  const data = extractEdlData(info);
  if (!data || isError(info.result)) return scriptBlock;

  const lines: string[] = [];

  for (const { path, summary } of data.mutations) {
    const parts: string[] = [];
    if (summary.replacements > 0) parts.push(`${summary.replacements} replace`);
    if (summary.insertions > 0) parts.push(`${summary.insertions} insert`);
    if (summary.deletions > 0) parts.push(`${summary.deletions} delete`);
    lines.push(
      `  ${path}: ${parts.join(", ")} (+${summary.linesAdded}/-${summary.linesRemoved})`,
    );
  }

  if (data.finalSelection) {
    lines.push(
      `  Final selection: ${data.finalSelection.count} range${data.finalSelection.count !== 1 ? "s" : ""}`,
    );
  }

  return d`${scriptBlock}
${lines.join("\n")}`;
}

export function renderCompletedDetail(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const scriptBlock = withCode(d`\`\`\`
${input.script}
\`\`\``);
  return d`${scriptBlock}
${extractFormattedResult(info)}`;
}

export const spec: ProviderToolSpec = {
  name: "edl" as ToolName,
  description: `Execute an EDL (Edit Description Language) script to perform programmatic file edits.

## Commands

### File commands
- \`file \`path\`\` or \`file path\` - Select a file to edit, resets the selection to the entire contents of the file.
- \`newfile \`path\`\` - Create a new file (must not already exist)

### Selection commands (patterns can be: /regex/, heredoc, line number like \`5:\`, line:col like \`5:10\`, \`bof\`, \`eof\`)
- \`narrow <pattern>\` - Narrow the selection to all matches of the pattern within the current selection.
- \`narrow_one <pattern>\` - Like narrow, but asserts that only one match within the current selection exists.
- \`retain_first\` - Retain just the first selection from the current multi-selection (no-op for single selection).
- \`retain_last\` - Retain just the last selection.
- \`select_next <pattern>\` - Select next non-overlapping match after end of current selection.
- \`select_prev <pattern>\` - Select previous non-overlapping match before start of current selection.
- \`extend_forward <pattern>\` - Extend selection forward from its end to include the next non-overlapping match
- \`extend_back <pattern>\` - Extend selection backward from its start to include the previous non-overlapping match
- \`nth <n>\` - Select the nth match (1-indexed)

## Examples

# Simple text replacement using replace:
\`\`\`
file \`src/utils.ts\`
narrow_one <<END
const oldValue = 42;
END
replace <<END
const newValue = 100;
END
\`\`\`

# Insert after a match using insert_after:
\`\`\`
file \`src/utils.ts\`
narrow_one <<END
import { foo } from './foo';
END
insert_after <<END

import { bar } from './bar';
END
\`\`\`

# Create a new file:
\`\`\`
newfile \`src/newModule.ts\`
insert_after <<END2
export function hello() {
  return "world";
}
END2
\`\`\`
# Delete a line using delete:
\`\`\`
file \`src/config.ts\`
narrow_one /const DEBUG = true;.*\\n/
delete
\`\`\`

# Replace part of a line (heredocs don't include surrounding newlines):

file contents before:
const prev = true;
const value = "old-value";
const next = true;

\`\`\`
file \`src/config.ts\`
narrow_one <<END
"old-value"
END
replace <<END
"new-value"
END
\`\`\`

file contents after:
const prev = true;
const value = "new-value";
const next = true;

## Notes on pattern matching
- Patterns match against raw file bytes. Heredoc patterns are literal text and match exactly.
- **Prefer heredoc patterns over regexes** - they are easier to read, less error-prone, and match exactly what you write. Only use regexes when you need their power (wildcards, character classes, etc.).
- For regex, to match a literal backslash in the file, escape it with another backslash (e.g. /\\\\/ matches a single backslash).
- When pattern matching is difficult due to complex escaping, use line-number selection (e.g. select 42:) as a fallback.`,
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
