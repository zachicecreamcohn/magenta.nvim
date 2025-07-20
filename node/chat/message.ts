import { ToolManager, type ToolRequestId } from "../tools/toolManager.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, withBindings, withExtmark, withInlineCode } from "../tea/view.ts";
import type { Nvim } from "../nvim/nvim-node";
import { type Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";
import type { MagentaOptions } from "../options.ts";
import type { FileSnapshots } from "../tools/file-snapshots.ts";
import { displaySnapshotDiff } from "../tools/display-snapshot-diff.ts";
import {
  relativePath,
  type AbsFilePath,
  type NvimCwd,
  type RelFilePath,
  type UnresolvedFilePath,
} from "../utils/files.ts";
import type {
  ProviderMessageContent,
  ProviderStreamEvent,
  StopReason,
  Usage,
} from "../providers/provider.ts";
import {
  applyDelta,
  finalizeStreamingBlock,
  renderContentValue,
  type StreamingBlock,
} from "../providers/helpers.ts";
import { renderStreamdedTool } from "../tools/helpers.ts";
import type { WebSearchResultBlock } from "@anthropic-ai/sdk/resources.mjs";
import {
  type FileUpdates,
  ContextManager,
} from "../context/context-manager.ts";
export type MessageId = number & { __messageId: true };
import type { Input as GetFileInput } from "../tools/getFile.ts";
import type { Input as ReplaceInput } from "../tools/replace.ts";
import type { Role, ThreadId } from "./types.ts";
import open from "open";

type State = {
  id: MessageId;
  role: Role;
  streamingBlock: StreamingBlock | undefined;
  content: ProviderMessageContent[];
  stops: {
    [contentIdx: number]: {
      stopReason: StopReason;
      usage: Usage;
    };
  };
  contextUpdates?: FileUpdates | undefined;
  expandedUpdates?: {
    [absFilePath: string]: boolean;
  };
  expandedThinking?: {
    [contentIdx: number]: boolean;
  };
  edits: {
    [filePath: RelFilePath]: {
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
  toolMeta: {
    [requestId: ToolRequestId]: {
      details: boolean;
      stop?: {
        stopReason: StopReason;
        usage: Usage;
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
      filePath: UnresolvedFilePath | AbsFilePath;
    }
  | {
      type: "diff-snapshot";
      filePath: string;
    }
  | {
      type: "toggle-expand-update";
      filePath: AbsFilePath;
    }
  | {
      type: "toggle-tool-details";
      requestId: ToolRequestId;
    }
  | {
      type: "toggle-expand-thinking-block";
      contentIdx: number;
    }
  | {
      type: "stop";
      stopReason: StopReason;
      usage: Usage;
    };

export class Message {
  public state: State;
  constructor(
    initialState: {
      id: State["id"];
      role: State["role"];
      content?: State["content"];
      contextUpdates?: State["contextUpdates"];
    },
    private context: {
      dispatch: Dispatch<RootMsg>;
      myDispatch: Dispatch<Msg>;
      threadId: ThreadId;
      cwd: NvimCwd;
      nvim: Nvim;
      toolManager: ToolManager;
      fileSnapshots: FileSnapshots;
      options: MagentaOptions;
      contextManager: ContextManager;
    },
  ) {
    this.state = {
      streamingBlock: undefined,
      content: [],
      stops: {},
      edits: {},
      toolMeta: {},
      ...initialState,
    };
  }

  update(msg: Msg) {
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

              const tool = this.context.toolManager.getTool(request.id);
              if (!tool) {
                throw new Error(
                  `Tool request did not initialize successfully: ${request.id}`,
                );
              }

              if (tool.toolName == "insert" || tool.toolName == "replace") {
                const input = tool.request.input as GetFileInput | ReplaceInput;
                const filePath = relativePath(this.context.cwd, input.filePath);

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
          (e: Error) => this.context.nvim.logger.error(e.message),
        );
        return;
      }

      case "diff-snapshot": {
        displaySnapshotDiff({
          unresolvedFilePath: msg.filePath as UnresolvedFilePath,
          messageId: this.state.id,
          nvim: this.context.nvim,
          fileSnapshots: this.context.fileSnapshots,
        }).catch((e: Error) => this.context.nvim.logger.error(e.message));
        return;
      }

      case "toggle-expand-update": {
        this.state.expandedUpdates = this.state.expandedUpdates || {};
        this.state.expandedUpdates[msg.filePath] =
          !this.state.expandedUpdates[msg.filePath];
        return;
      }

      case "toggle-tool-details": {
        if (!this.state.toolMeta[msg.requestId]) {
          this.state.toolMeta[msg.requestId] = { details: false };
        }
        this.state.toolMeta[msg.requestId].details =
          !this.state.toolMeta[msg.requestId].details;
        return;
      }

      case "toggle-expand-thinking-block": {
        this.state.expandedThinking = this.state.expandedThinking || {};
        this.state.expandedThinking[msg.contentIdx] =
          !this.state.expandedThinking[msg.contentIdx];
        return;
      }

      case "stop": {
        // Check if this stop corresponds to a tool request
        const lastContent = this.state.content[this.state.content.length - 1];
        if (
          lastContent &&
          lastContent.type === "tool_use" &&
          lastContent.request.status === "ok"
        ) {
          const toolRequestId = lastContent.request.value.id;
          if (!this.state.toolMeta[toolRequestId]) {
            this.state.toolMeta[toolRequestId] = { details: false };
          }
          this.state.toolMeta[toolRequestId].stop = {
            stopReason: msg.stopReason,
            usage: msg.usage,
          };
        } else {
          this.state.stops[this.state.content.length - 1] = {
            stopReason: msg.stopReason,
            usage: msg.usage,
          };
        }
        return;
      }

      default:
        assertUnreachable(msg);
    }
  }

  setContext(updates: FileUpdates) {
    this.state.contextUpdates = updates;
  }

  private withUrlBinding(node: ReturnType<typeof withExtmark>, url: string) {
    return withBindings(node, {
      "<CR>": () => {
        open(url).catch((error: Error) => {
          this.context.nvim.logger.error(
            `Failed to open URL: ${error.message}`,
          );
        });
      },
    });
  }

  renderToolResult(id: ToolRequestId) {
    const tool = this.context.toolManager.getTool(id);
    if (!tool) {
      return "";
    }

    if (tool.isDone()) {
      const result = tool.getToolResult();
      if (result.result.status === "error") {
        return `\nerror: ${result.result.error}`;
      } else {
        return `\nresult:\n${result.result.value.map(renderContentValue).join("\n")}\n`;
      }
    } else {
      return "";
    }
  }

  renderTool(tool: ReturnType<ToolManager["getTool"]>) {
    if (!tool) {
      return "";
    }

    const toolMeta = this.state.toolMeta[tool.request.id];
    const showDetails = toolMeta?.details || false;

    return withBindings(
      d`${tool.renderSummary()}${
        showDetails
          ? d`\n${tool.toolName}: ${tool.renderDetail ? tool.renderDetail() : JSON.stringify(tool.request.input, null, 2)}${
              toolMeta?.stop
                ? d`\n${this.renderStopInfo(toolMeta.stop.stopReason, toolMeta.stop.usage)}`
                : ""
            }\n${this.renderToolResult(tool.request.id)}`
          : tool.renderPreview
            ? d`\n${tool.renderPreview()}`
            : ""
      }`,
      {
        "<CR>": () =>
          this.context.myDispatch({
            type: "toggle-tool-details",
            requestId: tool.request.id,
          }),
      },
    );
  }

  renderThinking(
    content: Extract<ProviderMessageContent, { type: "thinking" }>,
    contentIdx: number,
  ) {
    const isExpanded = this.state.expandedThinking?.[contentIdx] || false;

    if (isExpanded) {
      return withBindings(
        withExtmark(d`💭 [Thinking]\n${content.thinking}`, {
          hl_group: "@comment",
        }),
        {
          "<CR>": () => {
            console.log(`toggle-thinking`);
            this.context.myDispatch({
              type: "toggle-expand-thinking-block",
              contentIdx,
            });
          },
        },
      );
    } else {
      return withBindings(
        withExtmark(d`💭 [Thinking]`, {
          hl_group: "@comment",
        }),
        {
          "<CR>": () =>
            this.context.myDispatch({
              type: "toggle-expand-thinking-block",
              contentIdx,
            }),
        },
      );
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
    const renderContentWithStop = (
      content: ProviderMessageContent,
      contentIdx: number,
    ) => {
      let stopView;
      if (this.state.stops[contentIdx]) {
        stopView = this.renderStop(contentIdx);
      }

      return d`${this.renderContent(content, contentIdx)}\n${stopView ?? ""}`;
    };

    return d`\
${withExtmark(d`# ${this.state.role}:`, { hl_group: "@markup.heading.1.markdown" })}
${this.context.contextManager.renderContextUpdate(this.state.contextUpdates)}${this.state.content.map(renderContentWithStop)}${this.renderStreamingBlock()}${this.renderEdits()}`;
  }

  renderStopInfo(stopReason: StopReason, usage: Usage) {
    return d`Stopped (${stopReason}) [input: ${usage.inputTokens.toString()}, output: ${usage.outputTokens.toString()}${
      usage.cacheHits !== undefined
        ? d`, cache hits: ${usage.cacheHits.toString()}`
        : ""
    }${
      usage.cacheMisses !== undefined
        ? d`, cache misses: ${usage.cacheMisses.toString()}`
        : ""
    }]`;
  }

  renderStop(contentIdx: number) {
    const stop = this.state.stops[contentIdx];
    if (!stop) {
      return "";
    }

    return d`\n${this.renderStopInfo(stop.stopReason, stop.usage)}\n`;
  }

  renderContent(content: ProviderMessageContent, contentIdx: number) {
    switch (content.type) {
      case "text": {
        return d`${content.text}${content.citations ? content.citations.map((c) => this.withUrlBinding(withExtmark(d`[${c.title}](${c.url})`, { hl_group: "@markup.link.markdown", url: c.url }), c.url)) : ""}`;
      }

      case "server_tool_use":
        return d`🔍 Searching ${withExtmark(d`${content.input.query}`, { hl_group: "@string" })}...`;

      case "web_search_tool_result": {
        if (
          "type" in content.content &&
          content.content.type === "web_search_tool_result_error"
        ) {
          return d`🌐 Search error: ${withExtmark(d`${content.content.error_code}`, { hl_group: "ErrorMsg" })}`;
        } else {
          const results = content.content as Array<WebSearchResultBlock>;
          return d`\
🌐 Search results:\n${results.map(
            (result) => d`\
- ${this.withUrlBinding(withExtmark(d`[${result.title}](${result.url})`, { hl_group: "@markup.link.markdown", url: result.url }), result.url)}${result.page_age ? withExtmark(d` (${result.page_age})`, { hl_group: "@markup.emphasis.markdown" }) : ""}\n`,
          )}`;
        }
      }

      case "tool_result":
        return "";

      case "tool_use": {
        if (content.request.status == "error") {
          return d`Malformed request: ${content.request.error}`;
        } else {
          const tool = this.context.toolManager.getTool(
            content.request.value.id,
          );
          if (!tool) {
            this.context.nvim.logger.error(
              `Unable to find tool with requestId ${content.request.value.id}`,
            );
            throw new Error(
              `Unable to find tool with requestId ${content.request.value.id}`,
            );
          }
          return this.renderTool(tool);
        }
      }

      case "image":
      case "document":
        return renderContentValue(content);

      case "thinking":
        return this.renderThinking(content, contentIdx);
      case "redacted_thinking":
        return withExtmark(d`💭 [Redacted Thinking]`, {
          hl_group: "@comment",
        });

      default:
        assertUnreachable(content);
    }
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
      case "thinking": {
        const lastLine = block.thinking.slice(
          block.thinking.lastIndexOf("\n") + 1,
        );
        return withExtmark(d`💭 [Thinking] ${lastLine}`, {
          hl_group: "@comment",
        });
      }
      case "redacted_thinking":
        return withExtmark(d`💭 [Redacted Thinking]`, { hl_group: "@comment" });
      default:
        return assertUnreachable(block);
    }
  }

  renderEdits() {
    const fileEdits = [];
    for (const filePath in this.state.edits) {
      const edit = this.state.edits[filePath as RelFilePath];

      const filePathLink = withBindings(withInlineCode(d`\`${filePath}\``), {
        "<CR>": () =>
          this.context.myDispatch({
            type: "open-edit-file",
            filePath: filePath as UnresolvedFilePath,
          }),
      });

      const diffSnapshot = withBindings(
        withExtmark(d`[± diff snapshot]`, {
          hl_group: ["@markup.link.markdown", "@markup.strong.markdown"],
        }),
        {
          "<CR>": () =>
            this.context.myDispatch({
              type: "diff-snapshot",
              filePath,
            }),
        },
      );

      fileEdits.push(
        d`  ${filePathLink} (${edit.requestIds.length.toString()} edits). ${diffSnapshot}${
          edit.status.status == "error"
            ? d`\nError applying edit: ${edit.status.message}`
            : ""
        }\n`,
      );
    }

    // NOTE: we need the newline before the ## Edits: here
    return fileEdits.length
      ? d`
${withExtmark(d`## Edits:`, { hl_group: "@markup.heading.2.markdown" })}
${fileEdits}`
      : "";
  }
}
