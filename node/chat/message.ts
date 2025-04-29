import * as Part from "./part.ts";
import * as ToolManager from "../tools/toolManager.ts";
import { type Role } from "./thread.ts";
import { type Dispatch, type Thunk } from "../tea/tea.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, type View, withBindings } from "../tea/view.ts";
import { displayDiffs } from "../tools/diff.ts";
import type { Lsp } from "../lsp.ts";
import type { Nvim } from "nvim-node";
import type { MagentaOptions } from "../options.ts";

export type MessageId = number & { __messageId: true };
type State = {
  id: MessageId;
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
      requestId?: ToolManager.ToolRequestId;
      message: string;
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

export class Message {
  public state: State;
  public partModel: ReturnType<typeof Part.init>;
  public toolManager: ToolManager.Model;
  private nvim: Nvim;
  private lsp: Lsp;
  private options: MagentaOptions;

  constructor({
    state,
    nvim,
    lsp,
    toolManager,
    options,
  }: {
    state: State;
    nvim: Nvim;
    lsp: Lsp;
    toolManager: ToolManager.Model;
    options: MagentaOptions;
  }) {
    this.state = state;
    this.nvim = nvim;
    this.lsp = lsp;
    this.toolManager = toolManager;
    this.options = options;
    this.partModel = Part.init({ nvim, lsp, options });
  }

  update(msg: Msg): Thunk<Msg> | undefined {
    switch (msg.type) {
      case "append-text": {
        const lastPart = this.state.parts[this.state.parts.length - 1];
        if (lastPart && lastPart.type == "text") {
          lastPart.text += msg.text;
        } else {
          this.state.parts.push({
            type: "text",
            text: msg.text,
          });
        }
        break;
      }

      case "add-malformed-tool-reqeust":
        this.state.parts.push({
          type: "malformed-tool-request",
          error: msg.error,
          rawRequest: msg.rawRequest,
        });
        break;

      case "add-tool-request": {
        const toolWrapper = this.toolManager.toolWrappers[msg.requestId];
        if (!toolWrapper) {
          throw new Error(`Tool request not found: ${msg.requestId}`);
        }

        switch (toolWrapper.model.type) {
          case "insert":
          case "replace": {
            const filePath = toolWrapper.model.request.input.filePath;
            if (!this.state.edits[filePath]) {
              this.state.edits[filePath] = {
                status: { status: "pending" },
                requestIds: [],
              };
            }

            this.state.edits[filePath].requestIds.push(msg.requestId);

            this.state.parts.push({
              type: "tool-request",
              requestId: msg.requestId,
            });

            return;
          }

          case "get_file":
          case "list_buffers":
          case "hover":
          case "find_references":
          case "list_directory":
          case "diagnostics":
          case "bash_command":
            this.state.parts.push({
              type: "tool-request",
              requestId: msg.requestId,
            });
            return;
          default:
            return assertUnreachable(toolWrapper.model);
        }
      }

      case "part-msg": {
        const [nextPart] = this.partModel.update(
          msg.msg,
          this.state.parts[msg.partIdx],
        );
        this.state.parts[msg.partIdx] = nextPart;
        return;
      }

      case "diff-error":
      case "tool-manager-msg":
        // NOTE: nothing to do, should be handled by parent (chat)
        return;

      case "init-edit": {
        const edits = this.state.edits[msg.filePath];
        if (!edits) {
          throw new Error(
            `Received msg edit request for file ${msg.filePath} but it is not in map of edits.`,
          );
        }

        return async (dispatch: Dispatch<Msg>) => {
          try {
            await displayDiffs({
              context: { nvim: this.nvim },
              filePath: msg.filePath,
              diffId: `message_${this.state.id}`,
              edits: edits.requestIds.map((requestId) => {
                const toolWrapper = this.toolManager.toolWrappers[requestId];
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
              dispatch: (msg) => dispatch(msg),
            });
          } catch (error) {
            this.nvim.logger?.error(
              new Error(`diff-error: ${JSON.stringify(error)}`),
            );

            dispatch({
              type: "diff-error",
              filePath: msg.filePath,
              message: JSON.stringify(error),
            });
          }
        };
      }
      default:
        assertUnreachable(msg);
    }
  }
}

export const update = (
  msg: Msg,
  model: State,
  toolManager: ToolManager.Model,
  { nvim, lsp, options }: { nvim: Nvim; lsp: Lsp; options: MagentaOptions },
): [State, Thunk<Msg> | undefined] | [State] => {
  const message = new Message({
    state: model,
    nvim,
    lsp,
    toolManager,
    options,
  });
  const thunk = message.update(msg);
  return thunk ? [message.state, thunk] : [message.state];
};

export const view: View<{
  message: Message;
  dispatch: Dispatch<Msg>;
}> = ({ message, dispatch }) => {
  const fileEdits = [];
  for (const filePath in message.state.edits) {
    const edit = message.state.edits[filePath];
    const reviewEdit = withBindings(d`**[👀 review edits ]**`, {
      "<CR>": () =>
        dispatch({
          type: "init-edit",
          filePath,
        }),
    });

    fileEdits.push(
      d`  ${filePath} (${edit.requestIds.length.toString()} edits). ${reviewEdit}${
        edit.status.status == "error"
          ? d`\nError applying edit: ${edit.status.message}`
          : ""
      }\n`,
    );
  }

  return d`\
# ${message.state.role}:
${message.state.parts.map(
  (part, partIdx) =>
    d`${message.partModel.view({
      model: part,
      toolManager: message.toolManager,
      dispatch: (msg) => dispatch({ type: "part-msg", partIdx, msg }),
    })}\n`,
)}${
    fileEdits.length
      ? d`
Edits:
${fileEdits}`
      : ""
  }`;
};
