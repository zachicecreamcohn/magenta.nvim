import { d } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { ToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { ToolInterface } from "./types.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import type { ThreadId } from "../chat/thread.ts";
import { SUBAGENT_TOOL_NAMES, type ToolName } from "./tool-registry.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import {
  SUBAGENT_SYSTEM_PROMPTS,
  type SubagentSystemPrompt,
} from "../providers/system-prompt.ts";

export type Msg = {
  type: "subagent-created";
  result: Result<ThreadId>;
};

export type State =
  | {
      state: "preparing";
    }
  | {
      state: "done";
      result: ProviderToolResultContent;
    };

export class SpawnSubagentTool implements ToolInterface {
  toolName = "spawn_subagent" as const;
  public state: State;

  constructor(
    public request: Extract<ToolRequest, { toolName: "spawn_subagent" }>,
    public context: {
      nvim: Nvim;
      dispatch: Dispatch<RootMsg>;
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
      this.spawnSubagent();
    });
  }

  private spawnSubagent(): void {
    const input = this.request.input;
    const prompt = input.prompt;
    const contextFiles = input.contextFiles || [];
    const systemPrompt = input.systemPrompt;

    const suppressTools = input.suppressTools || [];
    let allowedTools = SUBAGENT_TOOL_NAMES.filter(
      (tool) => !suppressTools.includes(tool),
    );

    if (!allowedTools.includes("yield_to_parent")) {
      allowedTools = [...allowedTools, "yield_to_parent"];
    }

    this.context.dispatch({
      type: "chat-msg",
      msg: {
        type: "spawn-subagent-thread",
        parentThreadId: this.context.threadId,
        spawnToolRequestId: this.request.id,
        allowedTools,
        initialPrompt: prompt,
        contextFiles,
        systemPrompt,
      },
    });
  }

  abort() {
    switch (this.state.state) {
      case "preparing":
        this.state = {
          state: "done",
          result: {
            type: "tool_result",
            id: this.request.id,
            result: {
              status: "error",
              error: "Sub-agent execution was aborted",
            },
          },
        };
        break;

      case "done":
        // Already done, nothing to abort
        break;
      default:
        assertUnreachable(this.state);
    }
  }

  update(msg: Msg): void {
    switch (msg.type) {
      case "subagent-created":
        switch (msg.result.status) {
          case "ok":
            this.state = {
              state: "done",
              result: {
                type: "tool_result",
                id: this.request.id,
                result: {
                  status: "ok",
                  value: `Sub-agent started with threadId: ${msg.result.value}`,
                },
              },
            };

            break;

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

      default:
        assertUnreachable(msg.type);
    }
  }

  getToolResult(): ProviderToolResultContent {
    if (this.state.state !== "done") {
      return {
        type: "tool_result",
        id: this.request.id,
        result: {
          status: "ok",
          value: `Waiting for subagent to finish running...`,
        },
      };
    }

    return this.state.result;
  }

  view() {
    switch (this.state.state) {
      case "preparing":
        return d`🤖⚙️ Preparing to spawn sub-agent...`;
      case "done": {
        const result = this.state.result.result;
        if (result.status === "error") {
          return d`🤖❌ Error spawning sub-agent: ${result.error}`;
        } else {
          return d`🤖✅ Sub-agent started: ${result.value}`;
        }
      }
    }
  }

  displayInput(): string {
    const input = this.request.input;
    return `spawn_subagent: ${JSON.stringify(input, null, 2)}`;
  }
}

export const spec: ProviderToolSpec = {
  name: "spawn_subagent",
  description: `Create a sub-agent that can perform a specific task and report back the results.`,
  input_schema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The sub-agent prompt.",
      },
      contextFiles: {
        type: "array",
        items: {
          type: "string",
        },
        description:
          "Optional list of file paths to provide as context to the sub-agent.",
      },
      suppressTools: {
        type: "array",
        items: {
          type: "string",
          enum: SUBAGENT_TOOL_NAMES,
        },
        description:
          "List of tool names that the sub-agent is not allowed to use. If not provided, all standard tools except spawn_subagent will be available. Note: spawn_subagent is never allowed to prevent recursive spawning. yield_to_parent is always available to subagents regardless of this setting.",
      },
      systemPrompt: {
        type: "string",
        enum: SUBAGENT_SYSTEM_PROMPTS as unknown as string[],
        description:
          "Optional preset system prompt to use for the sub-agent. 'learn' provides instructions optimized for learning and discovery tasks. 'plan' provides instructions optimized for planning and strategy tasks.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
};

export type Input = {
  prompt: string;
  contextFiles?: UnresolvedFilePath[];
  suppressTools?: ToolName[];
  systemPrompt?: SubagentSystemPrompt;
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

  if (input.suppressTools !== undefined) {
    if (!Array.isArray(input.suppressTools)) {
      return {
        status: "error",
        error: `expected req.input.suppressTools to be an array but it was ${JSON.stringify(input.suppressTools)}`,
      };
    }

    if (!input.suppressTools.every((item) => typeof item === "string")) {
      return {
        status: "error",
        error: `expected all items in req.input.suppressTools to be strings but they were ${JSON.stringify(input.suppressTools)}`,
      };
    }

    // we're not going to check that every tool in suppressTools is a valid tool. If invalid tools are included, we will
    // just ignore them
  }

  if (input.systemPrompt !== undefined) {
    if (typeof input.systemPrompt !== "string") {
      return {
        status: "error",
        error: `expected req.input.systemPrompt to be a string but it was ${JSON.stringify(input.systemPrompt)}`,
      };
    }

    if (
      !SUBAGENT_SYSTEM_PROMPTS.includes(
        input.systemPrompt as SubagentSystemPrompt,
      )
    ) {
      return {
        status: "error",
        error: `expected req.input.systemPrompt to be one of ${SUBAGENT_SYSTEM_PROMPTS.join(", ")} but it was ${JSON.stringify(input.systemPrompt)}`,
      };
    }
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
