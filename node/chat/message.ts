import { ToolManager, type ToolRequestId } from "../tools/toolManager.ts";
import { type Role, type ThreadId } from "./thread.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, withBindings } from "../tea/view.ts";
import type { Nvim } from "nvim-node";
import { type Dispatch, type Thunk } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";
import type { MagentaOptions } from "../options.ts";
import type { FileSnapshots } from "../tools/file-snapshots.ts";
import { displaySnapshotDiff } from "../tools/display-snapshot-diff.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type {
  ProviderMessageContent,
  ProviderStreamEvent,
  StopReason,
  Usage,
} from "../providers/provider.ts";
import {
  applyDelta,
  finalizeStreamingBLock as finalizeStreamingBlock,
  type StreamingBlock,
} from "../providers/helpers.ts";
import type { WebSearchResultBlock } from "@anthropic-ai/sdk/resources.mjs";
import { renderStreamdedTool } from "../tools/helpers.ts";
export type MessageId = number & { __messageId: true };

type State = {
  id: MessageId;
  role: Role;
  streamingBlock: StreamingBlock | undefined;
  content: ProviderMessageContent[];
  stopped?: {
    stopReason: StopReason;
    usage: Usage;
  };
  edits: {
    [filePath: UnresolvedFilePath]: {
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
      type: "stream-event";
      event: Extract<
        ProviderStreamEvent,
        {
          type:
            | "content_block_start"
            | "content_block_delta"
            | "content_block_stop";
        }
      >;
    }
  | {
      type: "open-edit-file";
      filePath: UnresolvedFilePath;
    }
  | {
      type: "diff-snapshot";
      filePath: string;
    }
  | {
      type: "stop";
      stopReason: StopReason;
      usage: Usage;
    };

export class Message {
  constructor(
    public state: State,
    private context: {
      dispatch: Dispatch<RootMsg>;
      myDispatch: Dispatch<Msg>;
      threadId: ThreadId;
      nvim: Nvim;
      toolManager: ToolManager;
      fileSnapshots: FileSnapshots;
      options: MagentaOptions;
    },
  ) {}

  update(msg: Msg): Thunk<Msg> | undefined {
    switch (msg.type) {
      case "stream-event": {
        switch (msg.event.type) {
          case "content_block_start": {
            if (this.state.streamingBlock) {
              throw new Error(
                `Unexpected block start while previous streaming block not closed.`,
              );
            }

            this.state.streamingBlock = {
              ...msg.event.content_block,
              streamed: "",
            };
            return;
          }
          case "content_block_delta":
            if (!this.state.streamingBlock) {
              throw new Error(
                `Received delta when streaming block not initialized.`,
              );
            }
            applyDelta(this.state.streamingBlock, msg.event);
            return;
          case "content_block_stop": {
            if (!this.state.streamingBlock) {
              throw new Error(
                `Received block stop when streaming block not initialized.`,
              );
            }
            const block = finalizeStreamingBlock(this.state.streamingBlock);
            this.state.content.push(block);
            this.state.streamingBlock = undefined;

            if (block.type == "tool_use" && block.request.status == "ok") {
              const request = block.request.value;

              this.context.toolManager.update({
                type: "init-tool-use",
                request,
                messageId: this.state.id,
                threadId: this.context.threadId,
              });

              const toolWrapper =
                this.context.toolManager.state.toolWrappers[request.id];
              if (!toolWrapper) {
                throw new Error(
                  `Tool request did not initialize successfully: ${request.id}`,
                );
              }

              if (
                toolWrapper.tool.toolName == "insert" ||
                toolWrapper.tool.toolName == "replace"
              ) {
                const filePath = toolWrapper.tool.request.input.filePath;

                if (!this.state.edits[filePath]) {
                  this.state.edits[filePath] = {
                    status: { status: "pending" },
                    requestIds: [],
                  };
                }

                this.state.edits[filePath].requestIds.push(request.id);
              }
            }
            return;
          }
          default:
            return assertUnreachable(msg.event);
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
          unresolvedFilePath: msg.filePath as UnresolvedFilePath,
          messageId: this.state.id,
          nvim: this.context.nvim,
          fileSnapshots: this.context.fileSnapshots,
        }).catch((e: Error) => this.context.nvim.logger?.error(e.message));
        return;
      }

      case "stop": {
        this.state.stopped = {
          stopReason: msg.stopReason,
          usage: msg.usage,
        };
        return;
      }

      default:
        assertUnreachable(msg);
    }
  }

  toString() {
    // Basic message info
    let result = `Message(id=${this.state.id}, role=${this.state.role}):\n`;

    // Parts info
    result += `  Content: ${this.state.content.length}\n`;

    // List all parts with their toString representation
    if (this.state.content.length > 0) {
      result += "  Content details:\n";
      this.state.content.forEach((content, index) => {
        result += `    ${index}: ${JSON.stringify(content)}\n`;
      });
    }

    // File edits info
    const editCount = Object.keys(this.state.edits).length;
    if (editCount > 0) {
      result += `  Edits: ${editCount} files\n`;
      for (const [filePath, edit] of Object.entries(this.state.edits)) {
        result += `    - ${filePath}: ${edit.requestIds.length} edits (${edit.status.status})\n`;
      }
    } else {
      result += "  Edits: none\n";
    }

    return result;
  }

  view() {
    const fileEdits = [];
    for (const filePath in this.state.edits) {
      const edit = this.state.edits[filePath as UnresolvedFilePath];

      const filePathLink = withBindings(d`\`${filePath}\``, {
        "<CR>": () =>
          this.context.myDispatch({
            type: "open-edit-file",
            filePath: filePath as UnresolvedFilePath,
          }),
      });

      const diffSnapshot = withBindings(d`**[± diff snapshot]**`, {
        "<CR>": () =>
          this.context.myDispatch({
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
# ${this.state.role}:
${this.state.content.map((content) => d`${this.renderContent(content)}\n`)}${this.renderStreamingBlock()}${
      fileEdits.length
        ? d`
Edits:
${fileEdits}`
        : ""
    }${this.renderStopped()}`;
  }

  renderStopped() {
    if (!this.state.stopped) {
      return "";
    }
    const { stopReason, usage } = this.state.stopped;

    return d`\nStopped (${stopReason}) [input: ${usage.inputTokens.toString()}, output: ${usage.outputTokens.toString()}${
      usage.cacheHits !== undefined
        ? d`, cache hits: ${usage.cacheHits.toString()}`
        : ""
    }${
      usage.cacheMisses !== undefined
        ? d`, cache misses: ${usage.cacheMisses.toString()}`
        : ""
    }]`;
  }

  renderStreamingBlock() {
    if (!this.state.streamingBlock) {
      return "";
    }

    const block = this.state.streamingBlock;
    switch (block.type) {
      case "text":
        return block.streamed;
      case "server_tool_use":
        return block.streamed;
      case "web_search_tool_result":
        return block.streamed;
      case "tool_use": {
        return renderStreamdedTool(block);
      }
      case "thinking":
      case "redacted_thinking":
        throw new Error(`NOT IMPLEMENTED`);
      default:
        return assertUnreachable(block);
    }
  }

  renderContent(content: ProviderMessageContent) {
    switch (content.type) {
      case "text":
        return d`${content.text}`;

      case "server_tool_use":
        return d`🔍 Searching ${content.input.query}...`;

      case "web_search_tool_result": {
        if (
          "type" in content.content &&
          content.content.type === "web_search_tool_result_error"
        ) {
          return d`🌐 Search error: ${content.content.error_code}`;
        } else {
          const results = content.content as Array<WebSearchResultBlock>;
          return d`\
🌐 Search results: ${results.map(
            (result) => d`\
- [${result.title}](${result.url})${result.page_age ? ` (${result.page_age})` : ""}\n`,
          )}`;
        }
      }

      case "tool_result":
        return "";

      case "tool_use": {
        if (content.request.status == "error") {
          return d`Malformed request: ${content.request.error}`;
        } else {
          const toolWrapper =
            this.context.toolManager.state.toolWrappers[
              content.request.value.id
            ];
          if (!toolWrapper) {
            throw new Error(
              `Unable to find model with requestId ${content.request.value.id}`,
            );
          }
          return this.context.toolManager.renderTool(toolWrapper);
        }
      }

      default:
        assertUnreachable(content);
    }
  }
}
