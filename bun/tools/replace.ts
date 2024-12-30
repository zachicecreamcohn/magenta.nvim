import * as Anthropic from "@anthropic-ai/sdk";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { type Dispatch, type Update } from "../tea/tea.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import { type ToolRequestId } from "./toolManager.ts";
import { type Result } from "../utils/result.ts";

export type Model = {
  type: "replace";
  request: ReplaceToolRequest;
  state: {
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

export function initModel(request: ReplaceToolRequest): [Model] {
  const model: Model = {
    type: "replace",
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
  return d`Replace [[ -? / +${countLines(
    model.request.input.replace,
  ).toString()} ]] in ${model.request.input.filePath} ${toolStatusView({ model, dispatch })}`;
}

function countLines(str: string) {
  return (str.match(/\n/g) || []).length + 1;
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

export function getToolResult(
  model: Model,
): Anthropic.Anthropic.ToolResultBlockParam {
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
      startLine: {
        type: "string",
        description: `Replace text starting with and including this line.
This should be the exact and complete single line, including indentation.
If multiple locations in the file match this line, the first line will be used.`,
      },
      endLine: {
        type: "string",
        description: `Replace text up to and including this line.
This should be the exact and complete single line, including indentation.
If multiple locations in the file match this line, the first line will be used.`,
      },
      replace: {
        type: "string",
        description: "New content that will replace the existing text.",
      },
    },
    required: ["filePath", "startLine", "endLine", "replace"],
  },
};

export type ReplaceToolRequest = {
  type: "tool_use";
  id: ToolRequestId;
  name: "replace";
  input: {
    filePath: string;
    startLine: string;
    endLine: string;
    replace: string;
  };
};

export function displayRequest(request: ReplaceToolRequest) {
  return `replace: {
    filePath: ${request.input.filePath}
    match:
\`\`\`
${request.input.startLine}
...
${request.input.endLine}
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

  if (typeof input.startLine != "string") {
    return {
      status: "error",
      error: "expected req.input.startLine to be a string",
    };
  }

  if (typeof input.endLine != "string") {
    return {
      status: "error",
      error: "expected req.input.endLine to be a string",
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
