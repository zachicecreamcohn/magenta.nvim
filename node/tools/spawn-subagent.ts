import { d, withBindings, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { CompletedToolInfo } from "./types.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { StaticTool, ToolName, GenericToolRequest } from "./types.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import { AGENT_TYPES, type AgentType } from "../providers/system-prompt.ts";
import type { ThreadId, ThreadType } from "../chat/types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Chat } from "../chat/chat.ts";

export type ToolRequest = GenericToolRequest<"spawn_subagent", Input>;

export type Msg =
  | {
      type: "subagent-created";
      result: Result<ThreadId>;
    }
  | {
      type: "check-thread";
    };

export type State =
  | {
      state: "preparing";
    }
  | {
      state: "waiting-for-subagent";
      threadId: ThreadId;
    }
  | {
      state: "done";
      result: ProviderToolResult;
    };

export class SpawnSubagentTool implements StaticTool {
  toolName = "spawn_subagent" as const;
  public state: State;
  public aborted: boolean = false;

  constructor(
    public request: ToolRequest,
    public context: {
      nvim: Nvim;
      dispatch: Dispatch<RootMsg>;
      chat: Chat;
      threadId: ThreadId;
      myDispatch: Dispatch<Msg>;
    },
  ) {
    this.state = {
      state: "preparing",
    };

    // Start the process of spawning a sub-agent
    // Wrap in setTimeout to force new eventloop frame, to avoid dispatch-in-dispatch
    setTimeout(() => {
      if (this.aborted) return;
      this.spawnSubagent();
    });
  }

  private spawnSubagent(): void {
    const input = this.request.input;
    const prompt = input.prompt;
    const contextFiles = input.contextFiles || [];
    const threadType: ThreadType =
      input.agentType === "fast"
        ? "subagent_fast"
        : input.agentType === "explore"
          ? "subagent_explore"
          : "subagent_default";

    this.context.dispatch({
      type: "chat-msg",
      msg: {
        type: "spawn-subagent-thread",
        parentThreadId: this.context.threadId,
        spawnToolRequestId: this.request.id,
        inputMessages: [{ type: "system", text: prompt }],
        threadType,
        contextFiles,
      },
    });
  }

  isDone(): boolean {
    return this.state.state === "done";
  }

  isPendingUserAction(): boolean {
    return false; // Spawn subagent never requires user action
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
    if (this.aborted) return;

    switch (msg.type) {
      case "subagent-created":
        switch (msg.result.status) {
          case "ok": {
            const threadId = msg.result.value;
            const isBlocking = this.request.input.blocking === true;

            if (isBlocking) {
              this.state = {
                state: "waiting-for-subagent",
                threadId,
              };
              this.checkThread();
            } else {
              this.state = {
                state: "done",
                result: {
                  type: "tool_result",
                  id: this.request.id,
                  result: {
                    status: "ok",
                    value: [
                      {
                        type: "text",
                        text: `Sub-agent started with threadId: ${threadId}`,
                      },
                    ],
                  },
                },
              };
            }
            break;
          }

          case "error":
            this.state = {
              state: "done",
              result: {
                type: "tool_result",
                id: this.request.id,
                result: {
                  status: "error",
                  error: `Failed to create sub-agent thread: ${msg.result.error}`,
                },
              },
            };
            return;
        }
        return;

      case "check-thread":
        this.checkThread();
        return;

      default:
        assertUnreachable(msg);
    }
  }

  private checkThread(): void {
    if (this.state.state !== "waiting-for-subagent" || this.aborted) {
      return;
    }

    const threadId = this.state.threadId;
    const threadResult = this.context.chat.getThreadResult(threadId);

    switch (threadResult.status) {
      case "done": {
        const result = threadResult.result;
        this.state = {
          state: "done",
          result: {
            type: "tool_result",
            id: this.request.id,
            result:
              result.status === "ok"
                ? {
                    status: "ok",
                    value: [
                      {
                        type: "text",
                        text: `Sub-agent (${threadId}) completed:\n${result.value}`,
                      },
                    ],
                  }
                : {
                    status: "error",
                    error: `Sub-agent (${threadId}) failed: ${result.error}`,
                  },
          },
        };
        break;
      }

      case "pending":
        // Still waiting, will be checked again when thread state changes
        return;

      default:
        assertUnreachable(threadResult);
    }
  }

  getToolResult(): ProviderToolResult {
    if (this.state.state !== "done") {
      return {
        type: "tool_result",
        id: this.request.id,
        result: {
          status: "ok",
          value: [
            { type: "text", text: `Waiting for subagent to finish running...` },
          ],
        },
      };
    }

    return this.state.result;
  }

  renderSummary(): VDOMNode {
    const promptPreview =
      this.request.input.prompt.length > 50
        ? this.request.input.prompt.substring(0, 50) + "..."
        : this.request.input.prompt;

    switch (this.state.state) {
      case "preparing":
        return d`🚀⚙️ spawn_subagent: ${promptPreview}`;
      case "waiting-for-subagent": {
        const summary = this.context.chat.getThreadSummary(this.state.threadId);
        const title = summary.title || "[Untitled]";
        let statusText: string;

        switch (summary.status.type) {
          case "missing":
            statusText = "❓ not found";
            break;
          case "pending":
            statusText = "⏳ initializing";
            break;
          case "running":
            statusText = `⏳ ${summary.status.activity}`;
            break;
          case "stopped":
            statusText = `⏹️ stopped (${summary.status.reason})`;
            break;
          case "yielded":
            statusText = "✅ yielded";
            break;
          case "error":
            statusText = `❌ error`;
            break;
          default:
            assertUnreachable(summary.status);
        }

        return withBindings(
          d`🚀⏳ spawn_subagent (blocking) ${this.state.threadId} ${title}: ${statusText}`,
          {
            "<CR>": () =>
              this.context.dispatch({
                type: "chat-msg",
                msg: {
                  type: "select-thread",
                  id:
                    this.state.state === "waiting-for-subagent"
                      ? this.state.threadId
                      : (undefined as unknown as ThreadId),
                },
              }),
          },
        );
      }
      case "done":
        return renderCompletedSummary(
          {
            request: this.request as CompletedToolInfo["request"],
            result: this.state.result,
          },
          this.context.dispatch,
        );
    }
  }
}

export function renderCompletedSummary(
  info: CompletedToolInfo,
  dispatch: Dispatch<RootMsg>,
): VDOMNode {
  const result = info.result.result;
  if (result.status === "error") {
    const errorPreview =
      result.error.length > 50
        ? result.error.substring(0, 50) + "..."
        : result.error;

    return d`🤖❌ spawn_subagent: ${errorPreview}`;
  }

  // Parse threadId from result text: "Sub-agent started with threadId: <id>"
  const resultText =
    result.value[0]?.type === "text" ? result.value[0].text : "";
  const match = resultText.match(/threadId: ([a-f0-9-]+)/);
  const threadId = match ? (match[1] as ThreadId) : undefined;

  return withBindings(d`🤖✅ spawn_subagent ${threadId || "undefined"}`, {
    "<CR>": () => {
      if (threadId) {
        dispatch({
          type: "chat-msg",
          msg: {
            type: "select-thread",
            id: threadId,
          },
        });
      }
    },
  });
}

export const spec: ProviderToolSpec = {
  name: "spawn_subagent" as ToolName,
  description: `Create a sub-agent that can perform a specific task and report back the results.

- Use 'explore' for searching the codebase - finding where something is defined, how it's used, or discovering code patterns. The explore agent is optimized for using search tools (rg, fd, grep) and returns structured findings with file paths, line numbers, and code snippets
- Use 'fast' for quick tasks that don't require the full model capabilities
- Use 'default' for everything else

**Blocking vs non-blocking:**
- Use \`blocking: true\` when you need the result before proceeding (simpler, no need to call wait_for_subagents)
- Use \`blocking: false\` (default) when spawning multiple subagents in parallel, then use wait_for_subagents to collect results

<example>
user: I'd like to change this interface
assistant -> explore subagent, blocking: figure out where this interface is defined and used. Respond with code locations
explore subagent: the interface is defined in file:line, and is used in file:line, file:line and file:line
</example>


<example>
user: Where in this code base do we do X?
assistant -> explore subagent, blocking: figure out where in the code we do X. Respond with code locations, and key snippets
explore subagent: there is a class Class defined in file:line which does Y that's related to X. The main function is at file:line
\`\`\`
class Class...
  function(args)...
\`\`\`

There is also another class Class2 ... etc...
</example>


<example>
user: run the tests
assistant: runs tests via bash command, receives a very long, trimmed output, as well as the full output file path
assistant -> explore subagent, blocking: (full output of bash command passed via contextFiles) here's the output of a test command. Figure out which tests failed. Respond with the files and test names, as well as summaries of what failed.
explore subagent: There were 4 failing tests:
file: testfile
test 'test description' on line
failed assertion
failed stack trace

test 'test description' on line
failed assertion
failed stack trace

file: otherfile
... etc ...
</example>

<example>
assistant: while doing some work, uses get_file to read a file. The file is really large so get_file returns a file summary.
assistant -> explore subagent, blocking: (file passed via contextFiles) here's a large file. Figure out where in this file we do X. Return the line numbers and the contents of a few surrounding relevant lines.
explore subagent: X is defined on line XX.
\`\`\`
XX function x() {
...
YY }
\`\`\`
</example>`,
  input_schema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "The sub-agent prompt. This should contain a clear question, and information about what the answer should look like.",
      },
      contextFiles: {
        type: "array",
        items: {
          type: "string",
        },
        description:
          "Optional list of file paths to provide as context to the sub-agent.",
      },
      agentType: {
        type: "string",
        enum: AGENT_TYPES as unknown as string[],
        description:
          "Optional agent type to use for the sub-agent. Use 'explore' for finding things and summarizing files. Use 'fast' for simple editing tasks. Use 'default' for tasks that require more thought and smarts.",
      },
      blocking: {
        type: "boolean",
        description:
          "Pause this thread until the subagent finishes. If false (default), the tool returns immediately with the threadId you can use with wait_for_subagents to get the result.",
      },
    },

    required: ["prompt"],
  },
};

export type Input = {
  prompt: string;
  contextFiles?: UnresolvedFilePath[];
  agentType?: AgentType;
  blocking?: boolean;
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.prompt != "string") {
    return {
      status: "error",
      error: `expected req.input.prompt to be a string but it was ${JSON.stringify(input.prompt)}`,
    };
  }

  if (input.contextFiles !== undefined) {
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
  }

  if (input.agentType !== undefined) {
    if (typeof input.agentType !== "string") {
      return {
        status: "error",
        error: `expected req.input.agentType to be a string but it was ${JSON.stringify(input.agentType)}`,
      };
    }

    if (!AGENT_TYPES.includes(input.agentType as AgentType)) {
      return {
        status: "error",
        error: `expected req.input.agentType to be one of ${AGENT_TYPES.join(", ")} but it was ${JSON.stringify(input.agentType)}`,
      };
    }
  }

  if (input.blocking !== undefined) {
    if (typeof input.blocking !== "boolean") {
      return {
        status: "error",
        error: `expected req.input.blocking to be a boolean but it was ${JSON.stringify(input.blocking)}`,
      };
    }
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
