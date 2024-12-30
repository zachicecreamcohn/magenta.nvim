import * as Anthropic from "@anthropic-ai/sdk";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { type Dispatch, type Update } from "../tea/tea.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import { type ToolRequestId } from "./toolManager.ts";
import { type Result } from "../utils/result.ts";

export type Model = {
  type: "insert";
  request: InsertToolUseRequest;
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

export function initModel(request: InsertToolUseRequest): [Model] {
  const model: Model = {
    type: "insert",
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
  return d`Insert ${(
    model.request.input.content.match(/\n/g) || []
  ).length.toString()} lines.
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
  name: "insert",
  description:
    "Insert content after the specified string in a file. You can also use this tool to create new files.",
  input_schema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description:
          "Path to the file to modify. The file will be created if it does not exist yet.",
      },
      insertAfter: {
        type: "string",
        description:
          "String after which to insert the content. This text will not be changed. This should be the literal text of the file - regular expressions are not allowed. Provide just enough text to uniquely identify a location in the file. Provide the empty string to insert at the beginning of the file.",
      },
      content: {
        type: "string",
        description: "Content to insert",
      },
    },
    required: ["filePath", "insertAfter", "content"],
  },
};

export type InsertToolUseRequest = {
  type: "tool_use";
  id: ToolRequestId;
  name: "insert";
  input: {
    filePath: string;
    insertAfter: string;
    content: string;
  };
};

export function displayRequest(request: InsertToolUseRequest) {
  return `insert: {
    filePath: ${request.input.filePath}
    insertAfter: "${request.input.insertAfter}"
    content:
\`\`\`
${request.input.content}
\`\`\`
}`;
}

export function validateToolRequest(
  req: unknown,
): Result<InsertToolUseRequest> {
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

  if (req2.name != "insert") {
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

  if (typeof input.insertAfter != "string") {
    return {
      status: "error",
      error: "expected req.input.insertAfter to be a string",
    };
  }

  if (typeof input.content != "string") {
    return {
      status: "error",
      error: "expected req.input.content to be a string",
    };
  }

  return {
    status: "ok",
    value: req as InsertToolUseRequest,
  };
}
