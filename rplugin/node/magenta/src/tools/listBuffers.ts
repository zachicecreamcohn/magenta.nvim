import * as Anthropic from "@anthropic-ai/sdk";
import path from "path";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { Thunk, Update } from "../tea/tea.ts";
import { d, VDOMNode } from "../tea/view.ts";
import { context } from "../context.ts";
import { ToolRequestId } from "./toolManager.ts";

export type Model = {
  type: "list-buffers";
  autoRespond: boolean;
  request: ListBuffersToolRequest;
  state:
    | {
        state: "processing";
      }
    | {
        state: "done";
        result: ToolResultBlockParam;
      };
};

export type Msg = {
  type: "finish";
  result: ToolResultBlockParam;
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
    type: "list-buffers",
    autoRespond: true,
    request,
    state: {
      state: "processing",
    },
  };
  return [
    model,
    async (dispatch) => {
      const { nvim } = context;
      const buffers = await nvim.buffers;
      const cwd = (await nvim.call("getcwd")) as string;
      const bufferPaths = await Promise.all(
        buffers.map(async (buffer) => {
          const fullPath = await buffer.name;
          return path.relative(cwd, fullPath);
        }),
      );

      dispatch({
        type: "finish",
        result: {
          type: "tool_result",
          tool_use_id: request.id,
          content: bufferPaths.join("\n"),
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

export function getToolResult(model: Model): ToolResultBlockParam {
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
