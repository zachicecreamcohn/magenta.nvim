import * as Anthropic from "@anthropic-ai/sdk";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Thunk, Update } from "../tea/tea.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import { type ToolRequest } from "./toolManager.ts";
import { type Result } from "../utils/result.ts";
import type { Nvim } from "bunvim";
import { parseLsResponse } from "../utils/lsBuffers.ts";
import type { ProviderToolResultContent } from "../providers/provider.ts";

export type Model = {
  type: "list_buffers";
  request: ToolRequest<"list_buffers">;
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
  request: ToolRequest<"list_buffers">,
  context: { nvim: Nvim },
): [Model, Thunk<Msg>] {
  const model: Model = {
    type: "list_buffers",
    request,
    state: {
      state: "processing",
    },
  };
  return [
    model,
    async (dispatch) => {
      const lsResponse = await context.nvim.call("nvim_exec2", [
        "ls",
        { output: true },
      ]);

      const result = parseLsResponse(lsResponse.output as string);
      const content = result
        .map((bufEntry) => {
          let out = "";
          if (bufEntry.flags.active) {
            out += "active ";
          }
          if (bufEntry.flags.modified) {
            out += "modified ";
          }
          if (bufEntry.flags.terminal) {
            out += "terminal ";
          }
          out += bufEntry.filePath;
          return out;
        })
        .join("\n");

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
      return d`⚙️ Grabbing buffers...`;
    case "done":
      return d`✅ Finished getting buffers.`;
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
  name: "list_buffers",
  description: `List all the buffers the user currently has open.
This will be similar to the output of :buffers in neovim, so buffers will be listed in the order they were opened, with the most recent buffers last.
This can be useful to understand the context of what the user is trying to do.`,
  input_schema: {
    type: "object",
    properties: {},
    required: [],
  },
};

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type Input = {};

export function displayInput() {
  return `list_buffers: {}`;
}

export function validateInput(): Result<Input> {
  return {
    status: "ok",
    value: {} as Input,
  };
}
