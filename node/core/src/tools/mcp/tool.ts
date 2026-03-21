import type {
  ToolInvocation,
  ToolInvocationResult,
  ToolName,
  ToolRequestId,
} from "../../tool-types.ts";
import type { MCPClient } from "./client.ts";
import { type MCPToolRequestParams, parseToolName } from "./types.ts";

export type Input = {
  [key: string]: unknown;
};

export type MCPProgress = {
  startTime: number;
};

export function execute(
  request: {
    id: ToolRequestId;
    toolName: ToolName;
    input: Input;
  },
  context: {
    mcpClient: MCPClient;
    requestRender: () => void;
  },
): ToolInvocation & { progress: MCPProgress } {
  let aborted = false;

  const progress: MCPProgress = {
    startTime: Date.now(),
  };

  const tickInterval = setInterval(() => {
    context.requestRender();
  }, 1000);

  const abortResult: ToolInvocationResult = {
    result: {
      type: "tool_result",
      id: request.id,
      result: { status: "error", error: "Request was aborted by the user." },
    },
    resultInfo: { toolName: request.toolName },
  };

  const promise = (async (): Promise<ToolInvocationResult> => {
    try {
      if (aborted) return abortResult;

      const mcpToolName = parseToolName(request.toolName).mcpToolName;
      const params = request.input as MCPToolRequestParams;

      const result = await context.mcpClient.callTool(mcpToolName, params);

      if (aborted) return abortResult;

      return {
        result: {
          type: "tool_result",
          id: request.id,
          result: {
            status: "ok",
            value: result,
          },
        },
        resultInfo: { toolName: request.toolName },
      };
    } catch (error) {
      if (aborted) return abortResult;

      const errorMessage =
        error instanceof Error
          ? `${error.message}\n${error.stack}`
          : String(error);

      return {
        result: {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: `MCP tool error: ${errorMessage}`,
          },
        },
        resultInfo: { toolName: request.toolName },
      };
    } finally {
      clearInterval(tickInterval);
    }
  })();

  return {
    promise,
    progress,
    abort: () => {
      aborted = true;
      clearInterval(tickInterval);
    },
  };
}
