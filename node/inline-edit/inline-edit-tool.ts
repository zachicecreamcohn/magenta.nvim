import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { type Update } from "../tea/tea.ts";
import { type Result } from "../utils/result.ts";
import type { ToolRequestId } from "../tools/toolManager.ts";
import type {
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import { REVIEW_PROMPT } from "../tools/diff.ts";

export type InlineEditToolRequest = {
  id: ToolRequestId;
  name: "inline-edit";
  input: Input;
};

export type Model = {
  type: "inline-edit";
  request: InlineEditToolRequest;
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

export function initModel(request: InlineEditToolRequest): [Model] {
  const model: Model = {
    type: "inline-edit",
    request,
    state: {
      state: "done",
      result: {
        type: "tool_result",
        id: request.id,
        result: {
          status: "ok",
          value: REVIEW_PROMPT,
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
  name: "inline-edit",
  description: `Replace text. You will only get one shot so do the whole edit in a single tool invocation.`,
  input_schema: {
    type: "object",
    properties: {
      find: {
        type: "string",
        description: `The text to replace.
This should be the exact and complete text to replace, including indentation. Regular expressions are not supported.
If the text appears multiple times, only the first match will be replaced.`,
      },
      replace: {
        type: "string",
        description:
          "New content that will replace the existing text. This should be the complete text - do not skip lines or use ellipsis.",
      },
    },
    required: ["find", "replace"],
    additionalProperties: false,
  },
};

export type Input = {
  find: string;
  replace: string;
};

export function displayInput(input: Input) {
  return `replace: {
    match:
\`\`\`
${input.find}
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
  if (typeof input.find != "string") {
    return {
      status: "error",
      error: "expected req.input.find to be a string",
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
