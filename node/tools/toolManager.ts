import * as GetFile from "./getFile.ts";
import * as Insert from "./insert.ts";
import * as Replace from "./replace.ts";
import * as ListBuffers from "./listBuffers.ts";
import * as ListDirectory from "./listDirectory.ts";
import * as Hover from "./hover.ts";
import * as FindReferences from "./findReferences.ts";
import * as Diagnostics from "./diagnostics.ts";
import * as BashCommand from "./bashCommand.ts";
import * as InlineEdit from "./inline-edit-tool.ts";
import * as ReplaceSelection from "./replace-selection-tool.ts";
import * as ThreadTitle from "./thread-title.ts";
import * as CompactThread from "./compact-thread.ts";
import * as SpawnSubagent from "./spawn-subagent.ts";
import * as WaitForSubagents from "./wait-for-subagents.ts";
import * as YieldToParent from "./yield-to-parent.ts";

import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { type Dispatch, type Thunk } from "../tea/tea.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { Lsp } from "../lsp.ts";
import type { MagentaOptions } from "../options.ts";
import type { RootMsg } from "../root-msg.ts";
import type { MessageId } from "../chat/message.ts";
import type { ThreadId } from "../chat/thread.ts";
import type { BufferTracker } from "../buffer-tracker.ts";
import type { Chat } from "../chat/chat.ts";
import type { ToolMsg, ToolName, ToolRequestId } from "./types.ts";
import type { ProviderToolSpec } from "../providers/provider-types.ts";
import type { StaticToolName } from "./tool-registry.ts";
export type { ToolRequestId } from "./types.ts";

export type StaticToolMap = {
  get_file: {
    controller: GetFile.GetFileTool;
    input: GetFile.Input;
    msg: GetFile.Msg;
    spec: typeof GetFile.spec;
  };
  insert: {
    controller: Insert.InsertTool;
    input: Insert.Input;
    msg: Insert.Msg;
    spec: typeof Insert.spec;
  };
  replace: {
    controller: Replace.ReplaceTool;
    input: Replace.Input;
    msg: Replace.Msg;
    spec: typeof Replace.spec;
  };
  list_buffers: {
    controller: ListBuffers.ListBuffersTool;
    input: ListBuffers.Input;
    msg: ListBuffers.Msg;
    spec: typeof ListBuffers.spec;
  };
  list_directory: {
    controller: ListDirectory.ListDirectoryTool;
    input: ListDirectory.Input;
    msg: ListDirectory.Msg;
    spec: typeof ListDirectory.spec;
  };
  hover: {
    controller: Hover.HoverTool;
    input: Hover.Input;
    msg: Hover.Msg;
    spec: typeof Hover.spec;
  };
  find_references: {
    controller: FindReferences.FindReferencesTool;
    input: FindReferences.Input;
    msg: FindReferences.Msg;
    spec: typeof FindReferences.spec;
  };
  diagnostics: {
    controller: Diagnostics.DiagnosticsTool;
    input: Diagnostics.Input;
    msg: Diagnostics.Msg;
    spec: typeof Diagnostics.spec;
  };
  bash_command: {
    controller: BashCommand.BashCommandTool;
    input: BashCommand.Input;
    msg: BashCommand.Msg;
    spec: typeof BashCommand.spec;
  };
  inline_edit: {
    controller: InlineEdit.InlineEditTool;
    input: InlineEdit.Input;
    msg: InlineEdit.Msg;
    spec: typeof InlineEdit.spec;
  };
  replace_selection: {
    controller: ReplaceSelection.ReplaceSelectionTool;
    input: ReplaceSelection.Input;
    msg: ReplaceSelection.Msg;
    spec: typeof ReplaceSelection.spec;
  };
  thread_title: {
    controller: ThreadTitle.ThreadTitleTool;
    input: ThreadTitle.Input;
    msg: ThreadTitle.Msg;
    spec: typeof ThreadTitle.spec;
  };
  compact_thread: {
    controller: CompactThread.CompactThreadTool;
    input: CompactThread.Input;
    msg: never;
    spec: typeof CompactThread.spec;
  };
  spawn_subagent: {
    controller: SpawnSubagent.SpawnSubagentTool;
    input: SpawnSubagent.Input;
    msg: SpawnSubagent.Msg;
    spec: typeof SpawnSubagent.spec;
  };
  wait_for_subagents: {
    controller: WaitForSubagents.WaitForSubagentsTool;
    input: WaitForSubagents.Input;
    msg: WaitForSubagents.Msg;
    spec: typeof WaitForSubagents.spec;
  };
  yield_to_parent: {
    controller: YieldToParent.YieldToParentTool;
    input: YieldToParent.Input;
    msg: YieldToParent.Msg;
    spec: typeof YieldToParent.spec;
  };
};

export type StaticToolRequest = {
  [K in keyof StaticToolMap]: {
    id: ToolRequestId;
    toolName: K;
    input: StaticToolMap[K]["input"];
  };
}[keyof StaticToolMap];

export type StaticToolMsg = {
  [K in keyof StaticToolMap]: {
    id: ToolRequestId;
    toolName: K;
    msg: StaticToolMap[K]["msg"];
  };
}[keyof StaticToolMap];

type StaticTool = {
  [K in keyof StaticToolMap]: StaticToolMap[K]["controller"];
}[keyof StaticToolMap];

export type Msg =
  | {
      type: "init-tool-use";
      threadId: ThreadId;
      messageId: MessageId;
      request: StaticToolRequest;
    }
  | {
      type: "tool-msg";
      msg: ToolMsg;
    };

export class ToolManager {
  tools: {
    [id: ToolRequestId]: StaticTool;
  };

  constructor(
    public myDispatch: (msg: Msg) => void,
    private context: {
      dispatch: Dispatch<RootMsg>;
      bufferTracker: BufferTracker;
      threadId: ThreadId;
      nvim: Nvim;
      lsp: Lsp;
      options: MagentaOptions;
      chat: Chat;
    },
  ) {
    this.tools = {};
  }
  private static readonly TOOL_SPEC_MAP: {
    [K in StaticToolName]: ProviderToolSpec;
  } = {
    get_file: GetFile.spec,
    insert: Insert.spec,
    replace: Replace.spec,
    list_buffers: ListBuffers.spec,
    list_directory: ListDirectory.spec,
    hover: Hover.spec,
    find_references: FindReferences.spec,
    diagnostics: Diagnostics.spec,
    bash_command: BashCommand.spec,
    inline_edit: InlineEdit.spec,
    replace_selection: ReplaceSelection.spec,
    thread_title: ThreadTitle.spec,
    compact_thread: CompactThread.spec,
    spawn_subagent: SpawnSubagent.spec,
    yield_to_parent: YieldToParent.spec,
    wait_for_subagents: WaitForSubagents.spec,
  };

  getToolSpecs(toolNames: ToolName[]): ProviderToolSpec[] {
    return toolNames.map(
      (toolName) => ToolManager.TOOL_SPEC_MAP[toolName as StaticToolName],
    );
  }

  getTool(id: ToolRequestId): StaticTool | undefined {
    return this.tools[id];
  }

  renderToolResult(id: ToolRequestId) {
    const tool = this.tools[id];
    if (!tool) {
      return "";
    }

    if (tool.state.state === "done") {
      const result = tool.state.result;
      if (result.result.status === "error") {
        return `\nError: ${result.result.error}`;
      } else {
        return `\nResult:\n${JSON.stringify(result.result.value, null, 2)}\n`;
      }
    } else {
      return "";
    }
  }

  update(msg: Msg): void {
    switch (msg.type) {
      case "init-tool-use": {
        const request = msg.request;

        switch (request.toolName) {
          case "get_file": {
            const threadWrapper =
              this.context.chat.threadWrappers[msg.threadId];
            if (threadWrapper.state != "initialized") {
              throw new Error(
                `Expected thread ${msg.threadId} to be initialized for get_file tool.`,
              );
            }

            const getFileTool = new GetFile.GetFileTool(request, {
              nvim: this.context.nvim,
              contextManager: threadWrapper.thread.contextManager,
              threadDispatch: (msg) =>
                this.context.dispatch({
                  type: "thread-msg",
                  id: this.context.threadId,
                  msg,
                }),
              myDispatch: (msg) =>
                this.myDispatch({
                  type: "tool-msg",
                  msg: {
                    id: request.id,
                    toolName: request.toolName,
                    msg,
                  } as unknown as ToolMsg,
                }),
            });

            this.tools[request.id] = getFileTool;

            return;
          }

          case "list_buffers": {
            const [listBuffersTool, thunk] = ListBuffers.ListBuffersTool.create(
              request,
              { nvim: this.context.nvim },
            );

            this.tools[request.id] = listBuffersTool;

            return this.acceptThunk(listBuffersTool, thunk);
          }

          case "insert": {
            const insertTool = new Insert.InsertTool(
              request,
              msg.threadId,
              msg.messageId,
              {
                ...this.context,
                myDispatch: (msg) =>
                  this.myDispatch({
                    type: "tool-msg",
                    msg: {
                      id: request.id,
                      toolName: request.toolName,
                      msg,
                    } as unknown as ToolMsg,
                  }),
              },
            );

            this.tools[request.id] = insertTool;
            return;
          }

          case "replace": {
            const replaceTool = new Replace.ReplaceTool(
              request,
              msg.threadId,
              msg.messageId,
              {
                ...this.context,
                myDispatch: (msg) =>
                  this.myDispatch({
                    type: "tool-msg",
                    msg: {
                      id: request.id,
                      toolName: request.toolName,
                      msg,
                    } as unknown as ToolMsg,
                  }),
              },
            );

            this.tools[request.id] = replaceTool;

            return;
          }

          case "list_directory": {
            const [listDirTool, thunk] = ListDirectory.ListDirectoryTool.create(
              request,
              { nvim: this.context.nvim },
            );

            this.tools[request.id] = listDirTool;

            return this.acceptThunk(listDirTool, thunk);
          }

          case "hover": {
            const [hoverTool, thunk] = Hover.HoverTool.create(request, {
              nvim: this.context.nvim,
              lsp: this.context.lsp,
            });

            this.tools[request.id] = hoverTool;

            return this.acceptThunk(hoverTool, thunk);
          }

          case "find_references": {
            const [findReferencesTool, thunk] =
              FindReferences.FindReferencesTool.create(request, {
                nvim: this.context.nvim,
                lsp: this.context.lsp,
              });

            this.tools[request.id] = findReferencesTool;

            return this.acceptThunk(findReferencesTool, thunk);
          }

          case "diagnostics": {
            const [diagnosticsTool, thunk] = Diagnostics.DiagnosticsTool.create(
              request,
              { nvim: this.context.nvim },
            );

            this.tools[request.id] = diagnosticsTool;

            return this.acceptThunk(diagnosticsTool, thunk);
          }

          case "bash_command": {
            const bashCommandTool = new BashCommand.BashCommandTool(request, {
              nvim: this.context.nvim,
              myDispatch: (msg) =>
                this.myDispatch({
                  type: "tool-msg",
                  msg: {
                    id: request.id,
                    toolName: "bash_command",
                    msg,
                  } as unknown as ToolMsg,
                }),
              options: this.context.options,
              rememberedCommands: this.context.chat.rememberedCommands,
            });

            this.tools[request.id] = bashCommandTool;
            return;
          }

          case "inline_edit": {
            throw new Error(`Not supported.`);
          }
          case "replace_selection": {
            throw new Error(`Not supported.`);
          }

          case "thread_title": {
            const threadTitleTool = new ThreadTitle.ThreadTitleTool(request, {
              nvim: this.context.nvim,
              myDispatch: (msg) =>
                this.myDispatch({
                  type: "tool-msg",
                  msg: {
                    id: request.id,
                    toolName: "thread_title",
                    msg,
                  } as unknown as ToolMsg,
                }),
            });

            this.tools[request.id] = threadTitleTool;
            return;
          }

          case "compact_thread": {
            const compactThreadTool = new CompactThread.CompactThreadTool(
              request,
              {
                nvim: this.context.nvim,
              },
            );

            this.tools[request.id] = compactThreadTool;
            return;
          }

          case "spawn_subagent": {
            const spawnSubagentTool = new SpawnSubagent.SpawnSubagentTool(
              request,
              {
                nvim: this.context.nvim,
                dispatch: this.context.dispatch,
                threadId: this.context.threadId,
                myDispatch: (msg) =>
                  this.myDispatch({
                    type: "tool-msg",
                    msg: {
                      id: request.id,
                      toolName: "spawn_subagent",
                      msg,
                    } as unknown as ToolMsg,
                  }),
              },
            );

            this.tools[request.id] = spawnSubagentTool;
            return;
          }

          case "wait_for_subagents": {
            const waitForSubagentsTool =
              new WaitForSubagents.WaitForSubagentsTool(request, {
                nvim: this.context.nvim,
                dispatch: this.context.dispatch,
                threadId: this.context.threadId,
                chat: this.context.chat,
                myDispatch: (msg) =>
                  this.myDispatch({
                    type: "tool-msg",
                    msg: {
                      id: request.id,
                      toolName: "wait_for_subagents",
                      msg,
                    } as unknown as ToolMsg,
                  }),
              });

            this.tools[request.id] = waitForSubagentsTool;
            return;
          }

          case "yield_to_parent": {
            const yieldToParentTool = new YieldToParent.YieldToParentTool(
              request,
              {
                nvim: this.context.nvim,
                dispatch: this.context.dispatch,
                threadId: this.context.threadId,
                myDispatch: (msg) =>
                  this.myDispatch({
                    type: "tool-msg",
                    msg: {
                      id: request.id,
                      toolName: "yield_to_parent",
                      msg,
                    } as unknown as ToolMsg,
                  }),
              },
            );

            this.tools[request.id] = yieldToParentTool;
            return;
          }

          default:
            return assertUnreachable(request);
        }
      }

      case "tool-msg": {
        const staticToolMsg = msg.msg as unknown as StaticToolMsg;
        const tool = this.tools[staticToolMsg.id];
        if (!tool) {
          throw new Error(
            `Could not find tool with request id ${staticToolMsg.id}`,
          );
        }

        // any is safe here since we have correspondence between tool & msg type
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
        const thunk = tool.update(staticToolMsg.msg as any);

        if (staticToolMsg.toolName == "bash_command") {
          const toolMsg = staticToolMsg.msg;
          if (
            toolMsg.type == "user-approval" &&
            toolMsg.approved &&
            toolMsg.remember
          ) {
            this.context.chat.rememberedCommands.add(
              (tool as BashCommand.BashCommandTool).request.input.command,
            );
          }
        }
        return thunk ? this.acceptThunk(tool, thunk) : undefined;
      }
      default:
        return assertUnreachable(msg);
    }
  }

  /** Placeholder while I refactor the architecture. I'd like to stop passing thunks around, as I think it will make
   * things simpler to understand.
   */
  acceptThunk(tool: StaticTool, thunk: Thunk<StaticToolMsg["msg"]>): void {
    // wrap in setTimeout to force a new eventloop frame, to avoid dispatch-in-dispatch
    setTimeout(() => {
      thunk((msg) =>
        this.myDispatch({
          type: "tool-msg",
          msg: {
            id: tool.request.id,
            toolName: tool.toolName,
            msg,
          } as unknown as ToolMsg,
        }),
      ).catch((e: Error) =>
        this.myDispatch({
          type: "tool-msg",
          msg: {
            id: tool.request.id,
            toolName: tool.toolName,
            msg: {
              type: "finish",
              result: {
                status: "error",
                error: e.message,
              },
            },
          } as unknown as ToolMsg,
        }),
      );
    });
  }
}
