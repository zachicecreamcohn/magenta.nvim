import { Part, type Msg as PartMsg, view as partView } from "./part.ts";
import {
  ToolManager,
  type ToolRequestId,
  type Msg as ToolManagerMsg,
} from "../tools/toolManager.ts";
import { type Role } from "./thread.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, type View, withBindings } from "../tea/view.ts";
import { displayDiffs } from "../tools/diff.ts";
import type { Nvim } from "nvim-node";
import { wrapThunk, type Dispatch, type Thunk } from "../tea/tea.ts";

export type MessageId = number & { __messageId: true };
type State = {
  id: MessageId;
  role: Role;
  parts: Part[];
  edits: {
    [filePath: string]: {
      requestIds: ToolRequestId[];
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
      requestId: ToolRequestId;
    }
  | {
      type: "add-malformed-tool-reqeust";
      error: string;
      rawRequest: unknown;
    }
  | {
      type: "init-edit";
      filePath: string;
    }
  | {
      type: "tool-manager-msg";
      msg: ToolManagerMsg;
    }
  | {
      type: "part-msg";
      partIdx: number;
      msg: PartMsg;
    };

export class Message {
  public state: State;
  public toolManager: ToolManager;
  private nvim: Nvim;

  constructor({
    state,
    nvim,
    toolManager,
  }: {
    state: State;
    nvim: Nvim;
    toolManager: ToolManager;
  }) {
    this.state = state;
    this.nvim = nvim;
    this.toolManager = toolManager;
  }

  update(msg: Msg): Thunk<Msg> | undefined {
    switch (msg.type) {
      case "append-text": {
        const lastPart = this.state.parts[this.state.parts.length - 1];
        if (lastPart && lastPart.state.type == "text") {
          lastPart.state.text += msg.text;
        } else {
          this.state.parts.push(
            new Part({
              state: {
                type: "text",
                text: msg.text,
              },
              toolManager: this.toolManager,
            }),
          );
        }
        break;
      }

      case "add-malformed-tool-reqeust":
        this.state.parts.push(
          new Part({
            state: {
              type: "malformed-tool-request",
              error: msg.error,
              rawRequest: msg.rawRequest,
            },
            toolManager: this.toolManager,
          }),
        );
        break;

      case "add-tool-request": {
        const toolWrapper = this.toolManager.state.toolWrappers[msg.requestId];
        if (!toolWrapper) {
          throw new Error(`Tool request not found: ${msg.requestId}`);
        }

        switch (toolWrapper.tool.toolName) {
          case "insert":
          case "replace": {
            const filePath = toolWrapper.tool.request.input.filePath;
            if (!this.state.edits[filePath]) {
              this.state.edits[filePath] = {
                status: { status: "pending" },
                requestIds: [],
              };
            }

            this.state.edits[filePath].requestIds.push(msg.requestId);

            this.state.parts.push(
              new Part({
                state: {
                  type: "tool-request",
                  requestId: msg.requestId,
                },
                toolManager: this.toolManager,
              }),
            );

            return;
          }

          case "get_file":
          case "list_buffers":
          case "hover":
          case "find_references":
          case "list_directory":
          case "diagnostics":
          case "bash_command":
            this.state.parts.push(
              new Part({
                state: {
                  type: "tool-request",
                  requestId: msg.requestId,
                },
                toolManager: this.toolManager,
              }),
            );
            return;
          default:
            return assertUnreachable(toolWrapper.tool);
        }
      }

      case "init-edit": {
        return this.displayDiffs(msg.filePath);
      }

      case "tool-manager-msg": {
        const thunk = this.toolManager.update(msg.msg);
        return wrapThunk("tool-manager-msg", thunk);
      }

      case "part-msg": {
        const partIdx = msg.partIdx;
        const part = this.state.parts[msg.partIdx];
        const thunk = part.update(msg.msg);
        return (
          thunk &&
          ((dispatch: Dispatch<Msg>) =>
            thunk((msg) => dispatch({ type: "part-msg", partIdx, msg })))
        );
      }

      default:
        assertUnreachable(msg);
    }
  }

  displayDiffs(filePath: string): Thunk<Msg> {
    return async (dispatch: Dispatch<Msg>) => {
      const edits = this.state.edits[filePath];
      if (!edits) {
        throw new Error(
          `Received msg edit request for file ${filePath} but it is not in map of edits.`,
        );
      }

      await displayDiffs({
        context: { nvim: this.nvim },
        filePath,
        toolManager: this.toolManager,
        diffId: `message_${this.state.id}`,
        edits: edits.requestIds.map((requestId) => {
          const toolWrapper = this.toolManager.state.toolWrappers[requestId];
          if (!toolWrapper) {
            throw new Error(
              `Expected a toolWrapper with id ${requestId} but found none.`,
            );
          }
          if (
            !(
              toolWrapper.tool.toolName == "insert" ||
              toolWrapper.tool.toolName == "replace"
            )
          ) {
            throw new Error(
              `Expected only file edit tools in edits map, but found request ${requestId} of type ${toolWrapper.tool.toolName}`,
            );
          }

          return toolWrapper.tool.request;
        }),
        dispatch: (msg) => dispatch({ type: "tool-manager-msg", msg }),
      });
    };
  }
}

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
    d`${partView({
      part,
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
