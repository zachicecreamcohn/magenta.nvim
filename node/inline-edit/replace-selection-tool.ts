import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { type Update } from "../tea/tea.ts";
import { type Result } from "../utils/result.ts";
import type { ToolRequestId } from "../tools/toolManager.ts";
import type {
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";

export type ReplaceSelectionToolRequest = {
  id: ToolRequestId;
  name: "replace-selection";
  input: Input;
};

export type Model = {
  type: "replace-selection";
  request: ReplaceSelectionToolRequest;
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

export function initModel(request: ReplaceSelectionToolRequest): [Model] {
  const model: Model = {
    type: "replace-selection",
    request,
    state: {
      state: "done",
      result: {
        type: "tool_result",
        id: request.id,
        result: {
          status: "ok",
          value: `Successfully replaced selection.`,
        },
      },
    },
  };

  return [model];
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
  name: "replace-selection",
  description: `Replace the selected text.`,
  input_schema: {
    type: "object",
    properties: {
      replace: {
        type: "string",
        description:
          "New content that will replace the existing text. This should be the complete text - do not skip lines or use ellipsis.",
      },
    },
    required: ["replace"],
    additionalProperties: false,
  },
};

export type Input = {
  replace: string;
};

export function displayInput(input: Input) {
  return `replace: {
    replace:
\`\`\`
${input.replace}
\`\`\`
}`;
}

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
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
