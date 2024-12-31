import * as Anthropic from "@anthropic-ai/sdk";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Thunk, Update } from "../tea/tea.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import { type ToolRequestId } from "./toolManager.ts";
import { type Result } from "../utils/result.ts";
import type { Nvim } from "bunvim";

export type Model = {
  type: "diagnostics";
  request: DiagnosticsToolRequest;
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
  request: DiagnosticsToolRequest,
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
      const diagnostics = await context.nvim.call("nvim_exec_lua", [
        `return vim.diagnostic.get(nil)`,
        [],
      ]);

      const content = JSON.stringify(diagnostics, null, 2);

      dispatch({
        type: "finish",
        result: {
          type: "tool_result",
          tool_use_id: request.id,
          content,
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

export function getToolResult(
  model: Model,
): Anthropic.Anthropic.ToolResultBlockParam {
  switch (model.state.state) {
    case "processing":
      return {
        type: "tool_result",
        tool_use_id: model.request.id,
        content: `This tool use is being processed. Please proceed with your answer or address other parts of the question.`,
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

export type DiagnosticsToolRequest = {
  type: "tool_use";
  id: ToolRequestId;
  input: {};
  name: "diagnostics";
};

export function displayRequest(_request: DiagnosticsToolRequest) {
  return `diagnostics: {}`;
}

export function validateToolRequest(
  req: unknown,
): Result<DiagnosticsToolRequest> {
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

  if (req2.name != "diagnostics") {
    return { status: "error", error: "expected req.name to be diagnostics" };
  }

  if (typeof req2.input != "object" || req2.input == null) {
    return { status: "error", error: "expected req.input to be an object" };
  }

  return {
    status: "ok",
    value: req as DiagnosticsToolRequest,
  };
}
