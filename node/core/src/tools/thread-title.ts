import type { ProviderToolSpec } from "../providers/provider-types.ts";
import type {
  GenericToolRequest,
  ToolInvocation,
  ToolInvocationResult,
  ToolName,
} from "../tool-types.ts";
import type { Result } from "../utils/result.ts";

export function execute(
  request: ToolRequest,
  _context: Record<string, never>,
): ToolInvocation {
  let aborted = false;

  const promise = (async (): Promise<ToolInvocationResult> => {
    try {
      await Promise.resolve();
      if (aborted) {
        return {
          result: {
            type: "tool_result",
            id: request.id,
            result: {
              status: "error",
              error: "Request was aborted by the user.",
            },
          },
          resultInfo: { toolName: "thread_title" },
        };
      }
      return {
        result: {
          type: "tool_result",
          id: request.id,
          result: {
            status: "ok",
            value: [{ type: "text", text: request.input.title }],
          },
        },
        resultInfo: { toolName: "thread_title" },
      };
    } catch (error) {
      if (aborted) {
        return {
          result: {
            type: "tool_result",
            id: request.id,
            result: {
              status: "error",
              error: "Request was aborted by the user.",
            },
          },
          resultInfo: { toolName: "thread_title" },
        };
      }
      return {
        result: {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: `Failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        },
        resultInfo: { toolName: "thread_title" },
      };
    }
  })();

  return {
    promise,
    abort: () => {
      aborted = true;
    },
  };
}

export const spec: ProviderToolSpec = {
  name: "thread_title" as ToolName,
  description: `Set a title for the current conversation thread based on the user's message.`,
  input_schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "A short, descriptive title for the conversation thread. Should be shorter than 80 characters.",
      },
    },
    required: ["title"],
    additionalProperties: false,
  },
};

export type Input = {
  title: string;
};

export type ToolRequest = GenericToolRequest<"thread_title", Input>;
export type ResultInfo = { toolName: "thread_title" };

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.title !== "string") {
    return {
      status: "error",
      error: "expected req.input.title to be a string",
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
