import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { type Dispatch, type Update } from "../tea/tea.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { ToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";

export type Model = {
  type: "replace";
  request: ToolRequest<"replace">;
  state: {
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

export function initModel(request: ToolRequest<"replace">): [Model] {
  const model: Model = {
    type: "replace",
    request,
    state: {
      state: "done",
      result: {
        type: "tool_result",
        id: request.id,
        result: {
          status: "ok",
          value: `\
The user will review your proposed change.
Assume that your change will be accepted and address other parts of the question, if any exist.
Do not take more attempts at the same edit unless the user requests it.`,
        },
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
      if (model.state.result.result.status == "error") {
        return d`⚠️ Error: ${JSON.stringify(model.state.result.result.error, null, 2)}`;
      } else {
        return d`Awaiting user review.`;
      }
  }
}

export function getToolResult(model: Model): ProviderToolResultContent {
  switch (model.state.state) {
    case "done":
      return model.state.result;
    default:
      assertUnreachable(model.state.state);
  }
}

export const spec: ProviderToolSpec = {
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
    additionalProperties: false,
  },
};

export type Input = {
  filePath: string;
  startLine: string;
  endLine: string;
  replace: string;
};

export function displayInput(input: Input) {
  return `replace: {
    filePath: ${input.filePath}
    match:
\`\`\`
${input.startLine}
...
${input.endLine}
\`\`\`
    replace:
\`\`\`
${input.replace}
\`\`\`
}`;
}

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
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
    value: input as Input,
  };
}
