import * as Part from "./part.ts";
import * as ToolManager from "../tools/toolManager.ts";
import { Role } from "./chat.ts";
import { Dispatch, Thunk } from "../tea/tea.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, View, withBindings } from "../tea/view.ts";
import { displayDiffs } from "../tools/diff.ts";
import { context } from "../context.ts";

export type Model = {
  role: Role;
  parts: Part.Model[];
  edits: {
    [filePath: string]: {
      requestIds: ToolManager.ToolRequestId[];
      status:
        | {
            status: "pending";
          }
        | {
            status: "error";
            message: string;
          };
    };
  };
};

export type Msg =
  | {
      type: "append-text";
      text: string;
    }
  | {
      type: "add-tool-request";
      requestId: ToolManager.ToolRequestId;
    }
  | {
      type: "add-malformed-tool-reqeust";
      error: string;
      rawRequest: unknown;
    }
  | {
      type: "tool-manager-msg";
      msg: ToolManager.Msg;
    }
  | {
      type: "diff-error";
      filePath: string;
      error: string;
    }
  | {
      type: "part-msg";
      partIdx: number;
      msg: Part.Msg;
    }
  | {
      type: "init-edit";
      filePath: string;
    };

export const update = (
  msg: Msg,
  model: Model,
  toolManager: ToolManager.Model,
): [Model, Thunk<Msg>] | [Model] => {
  switch (msg.type) {
    case "append-text": {
      const lastPart = model.parts[model.parts.length - 1];
      if (lastPart && lastPart.type == "text") {
        lastPart.text += msg.text;
      } else {
        model.parts.push({
          type: "text",
          text: msg.text,
        });
      }
      break;
    }

    case "add-malformed-tool-reqeust":
      model.parts.push({
        type: "malformed-tool-request",
        error: msg.error,
        rawRequest: msg.rawRequest,
      });
      break;

    case "add-tool-request": {
      const toolWrapper = toolManager.toolWrappers[msg.requestId];
      if (!toolWrapper) {
        throw new Error(`Tool request not found: ${msg.requestId}`);
      }

      switch (toolWrapper.model.type) {
        case "insert":
        case "replace": {
          const filePath = toolWrapper.model.request.input.filePath;
          if (!model.edits[filePath]) {
            model.edits[filePath] = {
              status: { status: "pending" },
              requestIds: [],
            };
          }

          model.edits[filePath].requestIds.push(msg.requestId);
          return [model];
        }

        case "get_file":
        case "list_buffers":
        case "list_directory":
          model.parts.push({
            type: "tool-request",
            requestId: msg.requestId,
          });
          return [model];
        default:
          return assertUnreachable(toolWrapper.model);
      }
    }

    case "part-msg": {
      const [nextPart] = Part.update(msg.msg, model.parts[msg.partIdx]);
      model.parts[msg.partIdx] = nextPart;
      return [model];
    }

    case "diff-error": {
      // NOTE: nothing to do, should be handled by chat
      return [model];
    }

    case "tool-manager-msg": {
      // NOTE: nothing to do, should be handled by chat
      return [model];
    }

    case "init-edit": {
      const edits = model.edits[msg.filePath];
      if (!edits) {
        throw new Error(
          `Received msg edit request for file ${msg.filePath} but it is not in map of edits.`,
        );
      }
      return [
        model,
        async (dispatch: Dispatch<Msg>) => {
          try {
            await displayDiffs(
              msg.filePath,
              edits.requestIds.map((requestId) => {
                const toolWrapper = toolManager.toolWrappers[requestId];
                if (!toolWrapper) {
                  throw new Error(
                    `Expected a toolWrapper with id ${requestId} but found none.`,
                  );
                }
                if (
                  !(
                    toolWrapper.model.type == "insert" ||
                    toolWrapper.model.type == "replace"
                  )
                ) {
                  throw new Error(
                    `Expected only file edit tools in edits map, but found request ${requestId} of type ${toolWrapper.model.type}`,
                  );
                }

                return toolWrapper.model.request;
              }),
              (err) => {
                dispatch({
                  type: "diff-error",
                  filePath: msg.filePath,
                  error: err.message,
                });
              },
            );
          } catch (error) {
            context.logger.error(error as Error);
            dispatch({
              type: "diff-error",
              filePath: msg.filePath,
              error: (error as Error).message,
            });
          }
        },
      ];
    }
    default:
      assertUnreachable(msg);
  }
  return [model];
};

export const view: View<{
  model: Model;
  toolManager: ToolManager.Model;
  dispatch: Dispatch<Msg>;
}> = ({ model, toolManager, dispatch }) => {
  const fileEdits = [];
  for (const filePath in model.edits) {
    const edit = model.edits[filePath];
    const reviewEdits = withBindings(d`**[👀 review edits ]**`, {
      Enter: () =>
        dispatch({
          type: "init-edit",
          filePath,
        }),
    });

    fileEdits.push(
      d`Edit ${filePath} (${edit.requestIds.length.toString()} edits).${edit.status.status == "error" ? d`\nError applying edit: ${edit.status.message}\n` : ""}
${reviewEdits}
${model.edits[filePath].requestIds.map((requestId) =>
  ToolManager.renderTool(toolManager.toolWrappers[requestId], (msg) =>
    dispatch({
      type: "tool-manager-msg",
      msg,
    }),
  ),
)}\n`,
    );
  }

  return d`# ${model.role}:\n${model.parts.map(
    (part, partIdx) =>
      d`${Part.view({
        model: part,
        toolManager,
        dispatch: (msg) => dispatch({ type: "part-msg", partIdx, msg }),
      })}\n`,
  )}${fileEdits}`;
};
