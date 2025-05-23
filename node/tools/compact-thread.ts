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
    blockIndexes: [${this.request.input.blockIndexes.join(", ")}]
}`;
  }
}

export const spec: ProviderToolSpec = {
  name: "compact_thread",
  description: `⚠️ IMPORTANT: The next thread will automatically include the user's most recent prompt, so DO NOT include the last user message in your summary.

Create a concise thread summary that preserves only the essential context needed for future work. The summary should be no longer than necessary to maintain critical information.

PRIORITIZE:
1. Key decisions and architectural choices made during the conversation
2. Technical requirements and constraints that affect implementation
3. Relevant file paths, function names, and API interfaces discussed
4. Specific problems or edge cases identified that remain relevant
5. Current progress state and next steps in the development task

OMIT:
- Introductory exchanges, pleasantries, and tangential discussions
- Explanations of concepts that were only relevant to earlier questions
- Detailed troubleshooting steps that led to a solution (just keep the solution)
- Any information that could be quickly rediscovered from the codebase

FILE AND BLOCK SELECTION:
- In 'contextFiles': Only include files that are ACTIVELY being worked on or immediately relevant
- In 'blockIndexes': Only preserve blocks containing hard-to-recreate insights or critical decisions

CODE HANDLING:
- When a file or block contains mostly irrelevant code, extract only the essential functions or patterns into the summary
- Prefer code snippets of interfaces or types to full implementations, where the details of the implementation are not relevant

FORMAT YOUR SUMMARY:
- Keep explanations brief and technical, optimized for an engineer continuing work
- DO NOT restate information contained in retained files and blocks

Remember: The most effective summary preserves maximum context in minimum space.`,
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
      blockIndexes: {
        type: "array",
        items: {
          type: "number",
        },
        description: `The thread has annotated blocks with "## block N" headers. Use the blockIndexes argument to retain the entire content of the block.`,
      },
      summary: {
        type: "string",
        description: `\
Text summarizing just the relevant pieces of the thread to the user's latest query.
This should not restate anything relating to contextFiles or blockIndexes, since those will be retained in full.`,
      },
    },
    required: ["contextFiles", "blockIndexes", "summary"],
    additionalProperties: false,
  },
};

export type Input = {
  contextFiles: UnresolvedFilePath[];
  blockIndexes: number[];
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

  if (!Array.isArray(input.blockIndexes)) {
    return {
      status: "error",
      error: "expected req.input.blockIndexes to be an array",
    };
  }

  if (!input.blockIndexes.every((item) => typeof item === "number")) {
    return {
      status: "error",
      error: "expected all items in req.input.blockIndexes to be numbers",
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
