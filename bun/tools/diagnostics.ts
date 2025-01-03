import * as Anthropic from "@anthropic-ai/sdk";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Thunk, Update } from "../tea/tea.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { Nvim } from "bunvim";
import { parseLsResponse } from "../utils/lsBuffers.ts";
import type { ToolRequest } from "./toolManager.ts";
import type { ProviderToolResultContent } from "../providers/provider.ts";

export type Model = {
  type: "diagnostics";
  request: ToolRequest<"diagnostics">;
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

type DiagnosticsRes = {
  end_col: number;
  message: string;
  namespace: number;
  col: number;
  code: number;
  end_lnum: number;
  source: string;
  lnum: number;
  user_data: {
    lsp: {
      code: number;
      message: string;
      range: {
        start: {
          character: number;
          line: number;
        };
        end: {
          character: number;
          line: number;
        };
      };
      tags: [];
      source: string;
      severity: number;
    };
  };
  bufnr: number;
  severity: number;
};

export function initModel(
  request: ToolRequest<"diagnostics">,
  context: { nvim: Nvim },
): [Model, Thunk<Msg>] {
  const model: Model = {
    type: "diagnostics",
    request,
    state: {
      state: "processing",
    },
  };
  return [
    model,
    async (dispatch) => {
      context.nvim.logger?.debug(`in diagnostics initModel`);
      let diagnostics;
      try {
        diagnostics = (await context.nvim.call("nvim_exec_lua", [
          `return vim.diagnostic.get(nil)`,
          [],
        ])) as DiagnosticsRes[];
      } catch (e) {
        throw new Error(`failed to nvim_exec_lua: ${JSON.stringify(e)}`);
      }
      const lsResponse = await context.nvim.call("nvim_exec2", [
        "ls",
        { output: true },
      ]);

      const result = parseLsResponse(lsResponse.output as string);
      const bufMap: { [bufId: string]: string } = {};
      for (const res of result) {
        bufMap[res.id] = res.filePath;
      }

      const content = diagnostics
        .map(
          (d) =>
            `file: ${bufMap[d.bufnr]} source: ${d.source}, severity: ${d.severity}, message: "${d.message}"`,
        )
        .join("\n");
      context.nvim.logger?.debug(`got diagnostics content: ${content}`);

      dispatch({
        type: "finish",
        result: {
          status: "ok",
          value: content,
        },
      });
    },
  ];
}

export function view({ model }: { model: Model }): VDOMNode {
  switch (model.state.state) {
    case "processing":
      return d`⚙️ Getting diagnostics...`;
    case "done":
      return d`✅ Finished getting diagnostics.`;
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
          value: `This tool use is being processed. Please proceed with your answer or address other parts of the question.`,
        },
      };
    case "done":
      return model.state.result;
    default:
      assertUnreachable(model.state);
  }
}

export const spec: Anthropic.Anthropic.Tool = {
  name: "diagnostics",
  description: "Get all diagnostic messages in the workspace.",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
  },
};

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type Input = {};

export function displayInput() {
  return `diagnostics: {}`;
}

export function validateInput(): Result<Input> {
  return {
    status: "ok",
    value: {} as Input,
  };
}
