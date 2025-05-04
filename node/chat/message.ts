import { Part, view as partView } from "./part.ts";
import { ToolManager, type ToolRequestId } from "../tools/toolManager.ts";
import { type Role } from "./thread.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, type View, withBindings } from "../tea/view.ts";
import type { Nvim } from "nvim-node";
import { type Dispatch, type Thunk } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";
import type { MagentaOptions } from "../options.ts";
import type { FilePath, FileSnapshots } from "../tools/file-snapshots.ts";
import { displaySnapshotDiff } from "../tools/display-snapshot-diff.ts";
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
      type: "open-edit-file";
      filePath: string;
    }
  | {
      type: "diff-snapshot";
      filePath: string;
    };

export class Message {
  constructor(
    public state: State,
    private context: {
      dispatch: Dispatch<RootMsg>;
      nvim: Nvim;
      toolManager: ToolManager;
      fileSnapshots: FileSnapshots;
      options: MagentaOptions;
    },
  ) {}

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
              toolManager: this.context.toolManager,
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
            toolManager: this.context.toolManager,
          }),
        );
        break;

      case "add-tool-request": {
        const toolWrapper =
          this.context.toolManager.state.toolWrappers[msg.requestId];
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
                toolManager: this.context.toolManager,
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
                toolManager: this.context.toolManager,
              }),
            );
            return;
          default:
            return assertUnreachable(toolWrapper.tool);
        }
      }

      case "open-edit-file": {
        openFileInNonMagentaWindow(msg.filePath, this.context).catch(
          (e: Error) => this.context.nvim.logger?.error(e.message),
        );
        return;
      }

      case "diff-snapshot": {
        displaySnapshotDiff({
          filePath: msg.filePath as FilePath,
          messageId: this.state.id,
          nvim: this.context.nvim,
          fileSnapshots: this.context.fileSnapshots,
        }).catch((e: Error) => this.context.nvim.logger?.error(e.message));
        return;
      }

      default:
        assertUnreachable(msg);
    }
  }
}

export const view: View<{
  message: Message;
  dispatch: Dispatch<Msg>;
}> = ({ message, dispatch }) => {
  const fileEdits = [];
  for (const filePath in message.state.edits) {
    const edit = message.state.edits[filePath];

    const filePathLink = withBindings(d`\`${filePath}\``, {
      "<CR>": () =>
        dispatch({
          type: "open-edit-file",
          filePath,
        }),
    });

    const diffSnapshot = withBindings(d`**[± diff snapshot]**`, {
      "<CR>": () =>
        dispatch({
          type: "diff-snapshot",
          filePath,
        }),
    });

    fileEdits.push(
      d`  ${filePathLink} (${edit.requestIds.length.toString()} edits). ${diffSnapshot}${
        edit.status.status == "error"
          ? d`\nError applying edit: ${edit.status.message}`
          : ""
      }\n`,
    );
  }

  return d`\
# ${message.state.role}:
${message.state.parts.map(
  (part) =>
    d`${partView({
      part,
    })}\n`,
)}${
    fileEdits.length
      ? d`
Edits:
${fileEdits}`
      : ""
  }`;
};
