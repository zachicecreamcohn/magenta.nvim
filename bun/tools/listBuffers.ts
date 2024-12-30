import * as Anthropic from "@anthropic-ai/sdk";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Thunk, Update } from "../tea/tea.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import { type ToolRequestId } from "./toolManager.ts";
import { type Result } from "../utils/result.ts";
import type { Nvim } from "bunvim";
import { parseLsResponse } from "../utils/lsBuffers.ts";

export type Model = {
  type: "list_buffers";
  request: ListBuffersToolRequest;
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
  request: ListBuffersToolRequest,
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
      return d`⚙️ Grabbing buffers...`;
    case "done":
      return d`✅ Finished getting buffers.`;
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

export type ListBuffersToolRequest = {
  type: "tool_use";
  id: ToolRequestId; //"toolu_01UJtsBsBED9bwkonjqdxji4"
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  input: {};
  name: "list_buffers";
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function displayRequest(_request: ListBuffersToolRequest) {
  return `list_buffers: {}`;
}

export function validateToolRequest(
  req: unknown,
): Result<ListBuffersToolRequest> {
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

  if (req2.name != "list_buffers") {
    return { status: "error", error: "expected req.name to be insert" };
  }

  if (typeof req2.input != "object" || req2.input == null) {
    return { status: "error", error: "expected req.input to be an object" };
  }

  return {
    status: "ok",
    value: req as ListBuffersToolRequest,
  };
}
