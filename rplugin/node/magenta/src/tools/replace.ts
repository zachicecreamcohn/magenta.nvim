import * as Anthropic from "@anthropic-ai/sdk";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { Dispatch, Update } from "../tea/tea.ts";
import { d, VDOMNode } from "../tea/view.ts";
import { ToolRequestId } from "./toolManager.ts";
import { Result } from "../utils/result.ts";

export type Model = {
  type: "replace";
  autoRespond: boolean;
  request: ReplaceToolRequest;
  state: {
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

export function initModel(request: ReplaceToolRequest): [Model] {
  const model: Model = {
    type: "replace",
    autoRespond: true,
    request,
    state: {
      state: "done",
      result: {
        tool_use_id: request.id,
        type: "tool_result",
        content: `The user will review your proposed change. Please assume that your change will be accepted and address the remaining parts of the question.`,
      },
    },
  };

  return [model];
}

export function view({
  model,
  dispatch,
}: {
  model: Model;
  dispatch: Dispatch<Msg>;
}): VDOMNode {
  return d`Replace [[ +${(
    model.request.input.replace.match(/\n/g) || []
  ).length.toString()} / -${(
    model.request.input.match.match(/\n/g) || []
  ).length.toString()} ]] in ${model.request.input.filePath}
${toolStatusView({ model, dispatch })}`;
}

function toolStatusView({
  model,
}: {
  model: Model;
  dispatch: Dispatch<Msg>;
}): VDOMNode {
  switch (model.state.state) {
    case "done":
      if (model.state.result.is_error) {
        return d`⚠️ Error: ${JSON.stringify(model.state.result.content, null, 2)}`;
      } else {
        return d`Awaiting user review.`;
      }
  }
}

export function getToolResult(model: Model): ToolResultBlockParam {
  switch (model.state.state) {
    case "done":
      return model.state.result;
    default:
      assertUnreachable(model.state.state);
  }
}

export const spec: Anthropic.Anthropic.Tool = {
  name: "replace",
  description: `Replace the given text in a file. \
Break up replace opertations into multiple, smaller tool invocations to avoid repeating large sections of the existing code.`,
  input_schema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path of the file to modify.",
      },
      match: {
        type: "string",
        description: `Replace this text. \
This should be the literal text of the file. Regular expressions are not supported. \
If multiple locations in the file match this text, the first match will be used.`,
      },
      replace: {
        type: "string",
        description: "New content that will replace the existing text.",
      },
    },
    required: ["filePath", "match", "replace"],
  },
};

export type ReplaceToolRequest = {
  type: "tool_use";
  id: ToolRequestId;
  name: "replace";
  input: {
    filePath: string;
    match: string;
    replace: string;
  };
};

export function displayRequest(request: ReplaceToolRequest) {
  return `replace: {
    filePath: ${request.input.filePath}
    match:
\`\`\`
${request.input.match}"
\`\`\`
    replace:
\`\`\`
${request.input.replace}
\`\`\`
}`;
}

export function validateToolRequest(req: unknown): Result<ReplaceToolRequest> {
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

  if (req2.name != "replace") {
    return { status: "error", error: "expected req.name to be insert" };
  }

  if (typeof req2.input != "object" || req2.input == null) {
    return { status: "error", error: "expected req.input to be an object" };
  }

  const input = req2.input as { [key: string]: unknown };

  if (typeof input.filePath != "string") {
    return {
      status: "error",
      error: "expected req.input.filePath to be a string",
    };
  }

  if (typeof input.match != "string") {
    return {
      status: "error",
      error: "expected req.input.match to be a string",
    };
  }

  if (typeof input.replace != "string") {
    return {
      status: "error",
      error: "expected req.input.replace to be a string",
    };
  }

  return {
    status: "ok",
    value: req as ReplaceToolRequest,
  };
}
