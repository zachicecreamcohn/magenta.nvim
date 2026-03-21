import type { DiagnosticsProvider } from "../capabilities/diagnostics-provider.ts";
import type { ProviderToolSpec } from "../providers/provider-types.ts";
import type {
  GenericToolRequest,
  ToolInvocation,
  ToolInvocationResult,
  ToolName,
} from "../tool-types.ts";
import type { Result } from "../utils/result.ts";

export type ResultInfo = { toolName: "diagnostics" };
export type Input = {};

export type ToolRequest = GenericToolRequest<"diagnostics", Input>;

export function execute(
  request: ToolRequest,
  context: {
    diagnosticsProvider: DiagnosticsProvider;
  },
): ToolInvocation {
  let aborted = false;

  const promise = (async (): Promise<ToolInvocationResult> => {
    try {
      const content = await context.diagnosticsProvider.getDiagnostics();
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
          resultInfo: { toolName: "diagnostics" },
        };
      }
      return {
        result: {
          type: "tool_result",
          id: request.id,
          result: {
            status: "ok",
            value: [{ type: "text", text: content }],
          },
        },
        resultInfo: { toolName: "diagnostics" },
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
          resultInfo: { toolName: "diagnostics" },
        };
      }
      return {
        result: {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: `Failed to get diagnostics: ${error instanceof Error ? error.message : String(error)}`,
          },
        },
        resultInfo: { toolName: "diagnostics" },
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
  name: "diagnostics" as ToolName,
  description: "Get all diagnostic messages in the workspace.",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export function validateInput(): Result<Input> {
  return {
    status: "ok",
    value: {} as Input,
  };
}
