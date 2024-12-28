import * as Anthropic from "@anthropic-ai/sdk";
import { type Thunk, type Update } from "../tea/tea.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import { type ToolRequestId } from "./toolManager.ts";
import { type Result } from "../utils/result.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { getOrOpenBuffer } from "../utils/buffers.ts";
import type { NvimBuffer } from "../nvim/buffer.ts";
import type { Nvim } from "bunvim";
import type { Lsp } from "../lsp.ts";

export type Model = {
  type: "hover";
  request: HoverToolUseRequest;
  state:
    | {
        state: "processing";
      }
    | {
        state: "done";
        result: Anthropic.Anthropic.ToolResultBlockParam;
      };
};

export type Msg = {
  type: "finish";
  result: Anthropic.Anthropic.ToolResultBlockParam;
};

export const update: Update<Msg, Model> = (msg, model) => {
  switch (msg.type) {
    case "finish":
      return [
        {
          ...model,
          state: {
            state: "done",
            result: msg.result,
          },
        },
      ];
    default:
      assertUnreachable(msg.type);
  }
};

export function initModel(
  request: HoverToolUseRequest,
  context: {
    nvim: Nvim;
    lsp: Lsp;
  },
): [Model, Thunk<Msg>] {
  const model: Model = {
    type: "hover",
    request,
    state: {
      state: "processing",
    },
  };
  return [
    model,
    async (dispatch) => {
      const { lsp } = context;
      const filePath = model.request.input.filePath;
      context.nvim.logger?.debug(`request: ${JSON.stringify(model.request)}`);
      const bufferResult = await getOrOpenBuffer({
        relativePath: filePath,
        context,
      });

      let buffer: NvimBuffer;
      let bufferContent: string;
      if (bufferResult.status == "ok") {
        bufferContent = bufferResult.result;
        buffer = bufferResult.buffer;
      } else {
        dispatch({
          type: "finish",
          result: {
            type: "tool_result",
            tool_use_id: model.request.id,
            content: bufferResult.error,
            is_error: true,
          },
        });
        return;
      }

      let searchText = bufferContent;
      let startOffset = 0;

      // If context is provided, find it first
      if (model.request.input.context) {
        const contextIndex = bufferContent.indexOf(model.request.input.context);
        if (contextIndex === -1) {
          dispatch({
            type: "finish",
            result: {
              type: "tool_result",
              tool_use_id: model.request.id,
              content: `Context not found in file.`,
              is_error: true,
            },
          });
          return;
        }
        searchText = model.request.input.context;
        startOffset = contextIndex;
      }

      const symbolIndex = searchText.indexOf(model.request.input.symbol);
      if (symbolIndex === -1) {
        dispatch({
          type: "finish",
          result: {
            type: "tool_result",
            tool_use_id: model.request.id,
            content: `Symbol "${model.request.input.symbol}" not found in file.`,
            is_error: true,
          },
        });
        return;
      }

      const absoluteSymbolIndex = startOffset + symbolIndex;
      const precedingText = bufferContent.substring(0, absoluteSymbolIndex);
      const row = precedingText.split("\n").length - 1;
      const lastNewline = precedingText.lastIndexOf("\n");
      const col =
        lastNewline === -1
          ? absoluteSymbolIndex
          : absoluteSymbolIndex - lastNewline - 1;

      try {
        const result = await lsp.requestHover(buffer, row, col);
        let content = "";
        for (const lspResult of result) {
          if (lspResult != null) {
            content += `\
(${lspResult.result.contents.kind}):
${lspResult.result.contents.value}
`;
          }
        }

        dispatch({
          type: "finish",
          result: {
            type: "tool_result",
            tool_use_id: model.request.id,
            content,
          },
        });
      } catch (error) {
        dispatch({
          type: "finish",
          result: {
            type: "tool_result",
            tool_use_id: request.id,
            content: `Error requesting hover: ${(error as Error).message}`,
          },
        });
      }
    },
  ];
}

export function view({ model }: { model: Model }): VDOMNode {
  switch (model.state.state) {
    case "processing":
      return d`⚙️ Requesting hover info...`;
    case "done":
      return d`✅ Hover request complete.`;
    default:
      assertUnreachable(model.state);
  }
}

export function getToolResult(
  model: Model,
): Anthropic.Anthropic.ToolResultBlockParam {
  switch (model.state.state) {
    case "processing":
      return {
        type: "tool_result",
        tool_use_id: model.request.id,
        content: `This tool use is being processed.`,
      };
    case "done":
      return model.state.result;
    default:
      assertUnreachable(model.state);
  }
}

export const spec: Anthropic.Anthropic.Tool = {
  name: "hover",
  description:
    "Get hover information for a symbol in a file. This will use the attached lsp client if one is available.",
  input_schema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path to the file containing the symbol.",
      },
      symbol: {
        type: "string",
        description:
          "The symbol to get hover information for. We will use the first occurrence of the symbol.",
      },
      context: {
        type: "string",
        description: `Optionally, you can disambiguate which instance of the symbol you want to hover. \
If context is provided, we will first find the first instance of context in the file, and then look for the symbol inside the context. \
This should be the literal text of the file. Regular expressions are not allowed.`,
      },
    },
    required: ["filePath", "symbol"],
  },
};

export type HoverToolUseRequest = {
  type: "tool_use";
  id: ToolRequestId;
  input: {
    filePath: string;
    symbol: string;
    context?: string;
  };
  name: "hover";
};

export function displayRequest(request: HoverToolUseRequest) {
  return `hover: { filePath: "${request.input.filePath}", symbol: "${request.input.symbol}" }`;
}

export function validateToolRequest(req: unknown): Result<HoverToolUseRequest> {
  if (typeof req != "object" || req == null) {
    return { status: "error", error: "received a non-object" };
  }

  const req2 = req as { [key: string]: unknown };

  if (req2.type != "tool_use") {
    return { status: "error", error: "expected req.type to be tool_use" };
  }

  if (typeof req2.id != "string") {
    return { status: "error", error: "expected req.id to be a string" };
  }

  if (req2.name != "hover") {
    return { status: "error", error: "expected req.name to be hover" };
  }

  if (typeof req2.input != "object" || req2.input == null) {
    return { status: "error", error: "expected req.input to be an object" };
  }

  const input = req2.input as { [key: string]: unknown };

  if (typeof input.filePath != "string") {
    return { status: "error", error: "expected input.filePath to be a string" };
  }

  if (typeof input.symbol != "string") {
    return { status: "error", error: "expected input.symbol to be a string" };
  }

  if (input.context && typeof input.context != "string") {
    return {
      status: "error",
      error: "input.context must be a string if provided",
    };
  }

  return {
    status: "ok",
    value: req as HoverToolUseRequest,
  };
}
