import * as Anthropic from "@anthropic-ai/sdk";
import path from "path";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Thunk, Update } from "../tea/tea.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import { type ToolRequestId } from "./toolManager.ts";
import { type Result } from "../utils/result.ts";
import { getAllBuffers, getcwd } from "../nvim/nvim.ts";

export type Model = {
  type: "list_buffers";
  autoRespond: boolean;
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
): [Model, Thunk<Msg>] {
  const model: Model = {
    type: "list_buffers",
    autoRespond: true,
    request,
    state: {
      state: "processing",
    },
  };
  return [
    model,
    async (dispatch) => {
      const buffers = await getAllBuffers();
      const cwd = await getcwd();
      const bufferPaths = await Promise.all(
        buffers.map(async (buffer) => {
          const fullPath = await buffer.getName();
          return fullPath.length ? path.relative(cwd, fullPath) : "";
        }),
      );

      dispatch({
        type: "finish",
        result: {
          type: "tool_result",
          tool_use_id: request.id,
          content: bufferPaths.filter((p) => p.length).join("\n"),
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
  description: `List the file paths of all the buffers the user currently has open. This can be useful to understand the context of what the user is trying to do.`,
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
