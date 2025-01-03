import * as Anthropic from "@anthropic-ai/sdk";
import { type Thunk, type Update } from "../tea/tea.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { getOrOpenBuffer } from "../utils/buffers.ts";
import type { NvimBuffer } from "../nvim/buffer.ts";
import type { Nvim } from "bunvim";
import type { Lsp } from "../lsp.ts";
import { getcwd } from "../nvim/nvim.ts";
import { calculateStringPosition } from "../tea/util.ts";
import type { PositionString, StringIdx } from "../nvim/window.ts";
import path from "path";
import type { ToolRequest } from "./toolManager.ts";
import type { ProviderToolResultContent } from "../providers/provider.ts";

export type Model = {
  type: "find_references";
  request: ToolRequest<"find_references">;
  state:
    | {
        state: "processing";
      }
    | {
        state: "done";
        result: ProviderToolResultContent;
      };
};

export type Msg = {
  type: "finish";
  result: Result<string>;
};

export const update: Update<Msg, Model> = (msg, model) => {
  switch (msg.type) {
    case "finish":
      return [
        {
          ...model,
          state: {
            state: "done",
            result: {
              type: "tool_result",
              id: model.request.id,
              result: msg.result,
            },
          },
        },
      ];
    default:
      assertUnreachable(msg.type);
  }
};

export function initModel(
  request: ToolRequest<"find_references">,
  context: { nvim: Nvim; lsp: Lsp },
): [Model, Thunk<Msg>] {
  const model: Model = {
    type: "find_references",
    request,
    state: {
      state: "processing",
    },
  };
  return [
    model,
    async (dispatch) => {
      const { lsp, nvim } = context;
      const filePath = model.request.input.filePath;
      const bufferResult = await getOrOpenBuffer({
        relativePath: filePath,
        context: { nvim },
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
            status: "error",
            error: bufferResult.error,
          },
        });
        return;
      }
      const symbolStart = bufferContent.indexOf(
        model.request.input.symbol,
      ) as StringIdx;

      if (symbolStart === -1) {
        dispatch({
          type: "finish",
          result: {
            status: "error",
            error: `Symbol "${model.request.input.symbol}" not found in file.`,
          },
        });
        return;
      }

      const symbolPos = calculateStringPosition(
        { row: 0, col: 0 } as PositionString,
        bufferContent,
        (symbolStart + model.request.input.symbol.length - 1) as StringIdx,
      );

      try {
        const cwd = await getcwd(nvim);
        const result = await lsp.requestReferences(buffer, symbolPos);
        let content = "";
        for (const lspResult of result) {
          if (lspResult != null && lspResult.result) {
            for (const ref of lspResult.result) {
              const uri = ref.uri.startsWith("file://")
                ? ref.uri.slice(7)
                : ref.uri;
              const relativePath = path.relative(cwd, uri);
              content += `${relativePath}:${ref.range.start.line + 1}:${ref.range.start.character}\n`;
            }
          }
        }

        dispatch({
          type: "finish",
          result: {
            status: "ok",
            value: content || "No references found",
          },
        });
      } catch (error) {
        dispatch({
          type: "finish",
          result: {
            status: "error",
            error: `Error requesting references: ${(error as Error).message}`,
          },
        });
      }
    },
  ];
}

export function view({ model }: { model: Model }): VDOMNode {
  switch (model.state.state) {
    case "processing":
      return d`⚙️ Finding references...`;
    case "done":
      return d`✅ References request complete.`;
    default:
      assertUnreachable(model.state);
  }
}

export function getToolResult(model: Model): ProviderToolResultContent {
  switch (model.state.state) {
    case "processing":
      return {
        type: "tool_result",
        id: model.request.id,
        result: {
          status: "ok",
          value: `This tool use is being processed.`,
        },
      };
    case "done":
      return model.state.result;
    default:
      assertUnreachable(model.state);
  }
}

export const spec: Anthropic.Anthropic.Tool = {
  name: "find_references",
  description: "Find all references to a symbol in the workspace.",
  input_schema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path to the file containing the symbol.",
      },
      symbol: {
        type: "string",
        description: `The symbol to find references for.
We will use the first occurrence of the symbol.
We will use the right-most character of this string, so if the string is "a.b.c", we will find references for c.`,
      },
    },
    required: ["filePath", "symbol"],
  },
};

export type Input = {
  filePath: string;
  symbol: string;
};

export function displayInput(input: Input) {
  return `find_references: { filePath: "${input.filePath}", symbol: "${input.symbol}" }`;
}

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.filePath != "string") {
    return { status: "error", error: "expected input.filePath to be a string" };
  }

  if (typeof input.symbol != "string") {
    return { status: "error", error: "expected input.symbol to be a string" };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
