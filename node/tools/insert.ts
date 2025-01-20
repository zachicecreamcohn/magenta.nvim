import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { type Dispatch, type Update } from "../tea/tea.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { ToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import { REVIEW_PROMPT } from "./diff.ts";

export type Model = {
  type: "insert";
  request: ToolRequest<"insert">;
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

export function initModel(request: ToolRequest<"insert">): [Model] {
  const model: Model = {
    type: "insert",
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

export function view({
  model,
  dispatch,
}: {
  model: Model;
  dispatch: Dispatch<Msg>;
}): VDOMNode {
  return d`Insert [[ +${(
    (model.request.input.content.match(/\n/g) || []).length + 1
  ).toString()} ]] in \`${model.request.input.filePath}\` ${toolStatusView({ model, dispatch })}`;
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
    additionalProperties: false,
  },
};

export type Input = {
  filePath: string;
  insertAfter: string;
  content: string;
};

export function displayInput(input: Input) {
  return `insert: {
    filePath: ${input.filePath}
    insertAfter: "${input.insertAfter}"
    content:
\`\`\`
${input.content}
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
    value: input as Input,
  };
}
