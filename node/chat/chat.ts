import type { Nvim } from "../nvim/nvim-node";
import type { MagentaOptions, Profile } from "../options";
import type { RootMsg } from "../root-msg";
import type { Dispatch } from "../tea/tea";
import { Thread, view as threadView, type ThreadId } from "./thread";
import { CHAT_TOOL_NAMES, type ToolName } from "../tools/tool-registry.ts";
import type { Lsp } from "../lsp";
import { assertUnreachable } from "../utils/assertUnreachable";
import { d, withBindings, type VDOMNode } from "../tea/view";
import { Counter } from "../utils/uniqueId.ts";
import { ContextManager } from "../context/context-manager.ts";
import type { BufferTracker } from "../buffer-tracker.ts";
import {
  relativePath,
  resolveFilePath,
  type UnresolvedFilePath,
} from "../utils/files.ts";
import { getcwd } from "../nvim/nvim.ts";
import type { MessageId } from "./message.ts";
import type { Result } from "../utils/result.ts";
import type { ToolRequestId } from "../tools/toolManager.ts";
import type { SubagentSystemPrompt } from "../providers/system-prompt.ts";

type ThreadWrapper = (
  | {
      state: "pending";
    }
  | {
      state: "initialized";
      thread: Thread;
    }
  | {
      state: "error";
      error: Error;
    }
) & {
  parentThreadId: ThreadId | undefined;
};

type ChatState =
  | {
      state: "thread-overview";
      activeThreadId: ThreadId | undefined;
    }
  | {
      state: "thread-selected";
      activeThreadId: ThreadId;
    };

export type Msg =
  | {
      type: "thread-initialized";
      thread: Thread;
    }
  | {
      type: "thread-error";
      id: ThreadId;
      error: Error;
    }
  | {
      type: "new-thread";
    }
  | {
      type: "compact-thread";
      threadId: ThreadId;
      contextFilePaths: UnresolvedFilePath[];
      initialMessage: string;
    }
  | {
      type: "spawn-subagent-thread";
      parentThreadId: ThreadId;
      spawnToolRequestId: ToolRequestId;
      allowedTools: ToolName[];
      initialPrompt: string;
      systemPrompt: SubagentSystemPrompt | undefined;
      contextFiles?: UnresolvedFilePath[];
    }
  | {
      type: "select-thread";
      id: ThreadId;
    }
  | {
      type: "threads-overview";
    };

export type ChatMsg = {
  type: "chat-msg";
  msg: Msg;
};

export class Chat {
  private threadCounter = new Counter();
  state: ChatState;
  public threadWrappers: { [id: ThreadId]: ThreadWrapper };

  constructor(
    private context: {
      dispatch: Dispatch<RootMsg>;
      bufferTracker: BufferTracker;
      options: MagentaOptions;
      nvim: Nvim;
      lsp: Lsp;
    },
  ) {
    this.threadWrappers = {};
    this.state = {
      state: "thread-overview",
      activeThreadId: undefined,
    };

    setTimeout(() => {
      this.createNewThread().catch((e: Error) => {
        this.context.nvim.logger?.error(
          "Failed to create thread: " + e.message + "\n" + e.stack,
        );
      });
    });
  }

  update(msg: RootMsg) {
    if (msg.type == "chat-msg") {
      this.myUpdate(msg.msg);
      return;
    }

    if (msg.type == "thread-msg" && msg.id in this.threadWrappers) {
      const threadState = this.threadWrappers[msg.id];
      if (threadState.state === "initialized") {
        const thread = threadState.thread;
        thread.update(msg);

        if (
          threadState.parentThreadId &&
          (thread.state.conversation.state == "yielded" ||
            thread.state.conversation.state == "error")
        ) {
          this.notifyParent({
            parentThreadId: threadState.parentThreadId,
          });
        }
      }
    }
  }

  private myUpdate(msg: Msg) {
    switch (msg.type) {
      case "thread-initialized": {
        this.threadWrappers[msg.thread.id] = {
          state: "initialized",
          thread: msg.thread,
          parentThreadId: this.threadWrappers[msg.thread.id].parentThreadId,
        };

        if (!this.state.activeThreadId) {
          this.state = {
            state: "thread-selected",
            activeThreadId: msg.thread.id,
          };
        }

        return;
      }

      case "thread-error": {
        const prev = this.threadWrappers[msg.id];
        this.threadWrappers[msg.id] = {
          state: "error",
          error: msg.error,
          parentThreadId: prev.parentThreadId,
        };

        if (this.state.state === "thread-selected") {
          this.state = {
            state: "thread-overview",
            activeThreadId: msg.id,
          };
        }

        if (prev) {
          if (prev.parentThreadId) {
            this.notifyParent({
              parentThreadId: prev.parentThreadId,
            });
          }
        }

        return;
      }

      case "new-thread":
        // wrap in setTimeout to force new eventloop frame, to avoid dispatch-in-dispatch
        setTimeout(() => {
          this.createNewThread().catch((e: Error) => {
            this.context.nvim.logger?.error(
              "Failed to create new thread: " + e.message + "\n" + e.stack,
            );
          });
        });
        return;

      case "select-thread":
        if (msg.id in this.threadWrappers) {
          this.state = {
            state: "thread-selected",
            activeThreadId: msg.id,
          };
        }
        return;

      case "threads-overview":
        this.state = {
          state: "thread-overview",
          activeThreadId: this.state.activeThreadId,
        };
        return;

      case "compact-thread": {
        this.handleCompactThread(msg).catch((e: Error) => {
          this.context.nvim.logger?.error(
            "Failed to handle thread compaction: " + e.message + "\n" + e.stack,
          );
        });
        return;
      }

      case "spawn-subagent-thread": {
        this.handleSpawnSubagentThread(msg).catch((e: Error) => {
          this.context.nvim.logger?.error(
            `Failed to spawn sub-agent thread: ${e.message} ${e.stack}`,
          );
        });
        return;
      }

      default:
        assertUnreachable(msg);
    }
  }

  getMessages() {
    if (
      this.state.state === "thread-selected" &&
      this.state.activeThreadId in this.threadWrappers
    ) {
      const threadState = this.threadWrappers[this.state.activeThreadId];
      if (threadState.state === "initialized") {
        return threadState.thread.getMessages();
      }
    }
    return [];
  }

  private async createThreadWithContext({
    threadId,
    profile,
    allowedTools,
    contextFiles = [],
    parent,
    switchToThread,
    initialMessage,
    systemPrompt,
  }: {
    threadId: ThreadId;
    profile: Profile;
    allowedTools: ToolName[];
    contextFiles?: UnresolvedFilePath[];
    parent?: ThreadId;
    switchToThread: boolean;
    initialMessage?: string;
    systemPrompt?: SubagentSystemPrompt | undefined;
  }) {
    this.threadWrappers[threadId] = {
      state: "pending",
      parentThreadId: parent,
    };

    const contextManager = await ContextManager.create(
      (msg) =>
        this.context.dispatch({
          type: "thread-msg",
          id: threadId,
          msg: {
            type: "context-manager-msg",
            msg,
          },
        }),
      {
        dispatch: this.context.dispatch,
        bufferTracker: this.context.bufferTracker,
        nvim: this.context.nvim,
        options: this.context.options,
      },
    );

    if (contextFiles.length > 0) {
      for (const filePath of contextFiles) {
        const cwd = await getcwd(this.context.nvim);
        const absFilePath = resolveFilePath(cwd, filePath);
        const relFilePath = relativePath(cwd, absFilePath);
        contextManager.update({
          type: "add-file-context",
          absFilePath,
          relFilePath,
          messageId: 0 as MessageId,
        });
      }
    }

    const thread = new Thread(
      threadId,
      {
        systemPrompt,
        allowedTools,
      },
      {
        ...this.context,
        contextManager,
        profile,
        chat: this,
      },
    );

    this.context.dispatch({
      type: "chat-msg",
      msg: {
        type: "thread-initialized",
        thread,
      },
    });

    if (switchToThread) {
      this.context.dispatch({
        type: "chat-msg",
        msg: {
          type: "select-thread",
          id: threadId,
        },
      });
    }

    if (initialMessage) {
      this.context.dispatch({
        type: "thread-msg",
        id: threadId,
        msg: {
          type: "send-message",
          content: initialMessage,
        },
      });
    }

    return thread;
  }

  async createNewThread() {
    const id = this.threadCounter.get() as ThreadId;

    await this.createThreadWithContext({
      threadId: id,
      profile: getActiveProfile(
        this.context.options.profiles,
        this.context.options.activeProfile,
      ),
      switchToThread: true,
      allowedTools: CHAT_TOOL_NAMES,
    });
  }

  renderThreadOverview() {
    const threadViews = Object.entries(this.threadWrappers).map(
      ([idStr, threadState]) => {
        const id = Number(idStr) as ThreadId;
        let status = "";
        const marker = id == this.state.activeThreadId ? "*" : "-";
        switch (threadState.state) {
          case "pending":
            status = `${marker} ${id} - loading...\n`;
            break;
          case "initialized": {
            status = `${marker} ${id} ${threadState.thread.state.title ?? "[Untitled]"}\n`;
            break;
          }
          case "error":
            status = `${marker} ${id} - error: ${threadState.error.message}\n`;
            break;
        }

        return withBindings(d`${status}`, {
          "<CR>": () =>
            this.context.dispatch({
              type: "chat-msg",
              msg: { type: "select-thread", id },
            }),
        });
      },
    );

    return d`\
# Threads

${threadViews.length ? threadViews : "No threads yet"}`;
  }

  getActiveThread(): Thread {
    if (!this.state.activeThreadId) {
      throw new Error(`Chat is not initialized yet... no active thread`);
    }
    const threadWrapper = this.threadWrappers[this.state.activeThreadId];
    if (!(threadWrapper && threadWrapper.state == "initialized")) {
      throw new Error(
        `Thread ${this.state.activeThreadId} not initialized yet...`,
      );
    }
    return threadWrapper.thread;
  }

  async handleCompactThread({
    threadId,
    contextFilePaths,
    initialMessage,
  }: {
    threadId: ThreadId;
    contextFilePaths: UnresolvedFilePath[];
    initialMessage: string;
  }) {
    const sourceThreadWrapper = this.threadWrappers[threadId];
    if (!sourceThreadWrapper || sourceThreadWrapper.state !== "initialized") {
      throw new Error(`Thread ${threadId} not available for compaction`);
    }

    const sourceThread = sourceThreadWrapper.thread;
    const newThreadId = this.threadCounter.get() as ThreadId;

    await this.createThreadWithContext({
      threadId: newThreadId,
      profile: sourceThread.state.profile,
      allowedTools: CHAT_TOOL_NAMES,
      contextFiles: contextFilePaths,
      switchToThread: true,
      initialMessage: initialMessage,
    });
  }

  async handleSpawnSubagentThread({
    parentThreadId,
    spawnToolRequestId,
    allowedTools,
    initialPrompt,
    contextFiles,
    systemPrompt,
  }: {
    parentThreadId: ThreadId;
    spawnToolRequestId: ToolRequestId;
    allowedTools: ToolName[];
    initialPrompt: string;
    contextFiles?: UnresolvedFilePath[];
    systemPrompt?: SubagentSystemPrompt | undefined;
  }) {
    const parentThreadWrapper = this.threadWrappers[parentThreadId];
    if (!parentThreadWrapper || parentThreadWrapper.state !== "initialized") {
      throw new Error(`Parent thread ${parentThreadId} not available`);
    }

    const parentThread = parentThreadWrapper.thread;
    const subagentThreadId = this.threadCounter.get() as ThreadId;

    const subagentAllowedTools: ToolName[] = allowedTools.includes(
      "yield_to_parent",
    )
      ? allowedTools
      : [...allowedTools, "yield_to_parent"];

    try {
      const thread = await this.createThreadWithContext({
        threadId: subagentThreadId,
        profile: parentThread.state.profile,
        allowedTools: subagentAllowedTools,
        contextFiles: contextFiles || [],
        parent: parentThreadId,
        switchToThread: false,
        initialMessage: initialPrompt,
        systemPrompt,
      });

      // Notify parent spawn call of successful thread spawn
      this.context.dispatch({
        type: "thread-msg",
        id: parentThreadId,
        msg: {
          type: "tool-manager-msg",
          msg: {
            type: "tool-msg",
            msg: {
              id: spawnToolRequestId,
              toolName: "spawn_subagent",
              msg: {
                type: "subagent-created",
                result: {
                  status: "ok",
                  value: thread.id,
                },
              },
            },
          },
        },
      });
    } catch (e) {
      // Notify parent spawn call of failure to spawn
      this.context.dispatch({
        type: "thread-msg",
        id: parentThreadId,
        msg: {
          type: "tool-manager-msg",
          msg: {
            type: "tool-msg",
            msg: {
              id: spawnToolRequestId,
              toolName: "spawn_subagent",
              msg: {
                type: "subagent-created",
                result: {
                  status: "error",
                  error:
                    e instanceof Error ? e.message + "\n" + e.stack : String(e),
                },
              },
            },
          },
        },
      });
    }
  }

  getThreadResult(
    threadId: ThreadId,
  ): { status: "done"; result: Result<string> } | { status: "pending" } {
    const threadWrapper = this.threadWrappers[threadId];
    if (!threadWrapper) {
      return {
        status: "pending",
      };
    }

    switch (threadWrapper.state) {
      case "pending":
        return { status: "pending" };

      case "error":
        return {
          status: "done",
          result: {
            status: "error",
            error: threadWrapper.error.message,
          },
        };

      case "initialized": {
        const thread = threadWrapper.thread;
        const conversation = thread.state.conversation;

        switch (conversation.state) {
          case "yielded":
            return {
              status: "done",
              result: {
                status: "ok",
                value: conversation.response,
              },
            };

          case "error":
            return {
              status: "done",
              result: {
                status: "error",
                error: conversation.error.message,
              },
            };

          case "stopped":
            if (conversation.stopReason === "aborted") {
              return {
                status: "done",
                result: {
                  status: "error",
                  error: "Thread was aborted",
                },
              };
            }

            // If stopped normally but not yielded, consider it pending
            return { status: "pending" };

          case "message-in-flight":
          case "compacting":
            return { status: "pending" };

          default:
            return assertUnreachable(conversation);
        }
      }

      default:
        return assertUnreachable(threadWrapper);
    }
  }

  notifyParent({ parentThreadId }: { parentThreadId: ThreadId }) {
    const parentThreadWrapper = this.threadWrappers[parentThreadId];
    if (parentThreadWrapper && parentThreadWrapper.state === "initialized") {
      const parentThread = parentThreadWrapper.thread;

      const lastMessage =
        parentThread.state.messages[parentThread.state.messages.length - 1];
      if (!lastMessage || lastMessage.state.role !== "assistant") {
        return;
      }

      for (const content of lastMessage.state.content) {
        if (content.type === "tool_use" && content.request.status === "ok") {
          const request = content.request.value;
          if (request.toolName === "wait_for_subagents") {
            const toolWrapper =
              parentThread.toolManager.state.toolWrappers[request.id];
            if (toolWrapper && toolWrapper.tool.state.state === "waiting") {
              setTimeout(() =>
                this.context.dispatch({
                  type: "thread-msg",
                  id: parentThread.id,
                  msg: {
                    type: "tool-manager-msg",
                    msg: {
                      type: "tool-msg",
                      msg: {
                        id: toolWrapper.tool.request.id,
                        toolName: "wait_for_subagents",
                        msg: {
                          type: "check-threads",
                        },
                      },
                    },
                  },
                }),
              );
            }
          }
        }
      }
    }
  }

  renderActiveThread() {
    const threadWrapper =
      this.state.activeThreadId &&
      this.threadWrappers[this.state.activeThreadId];

    if (!threadWrapper) {
      throw new Error(`no active thread`);
    }

    switch (threadWrapper.state) {
      case "pending":
        return d`Initializing thread...`;
      case "initialized": {
        const thread = threadWrapper.thread;
        let parentView: string | VDOMNode;

        if (threadWrapper.parentThreadId) {
          const parent = threadWrapper.parentThreadId;
          parentView = withBindings(d`Parent thread: ${parent.toString()}\n`, {
            "<CR>": () =>
              this.context.dispatch({
                type: "chat-msg",
                msg: {
                  type: "select-thread",
                  id: parent,
                },
              }),
          });
        } else {
          parentView = "";
        }

        return d`${parentView}${threadView({
          thread,
          dispatch: (msg) =>
            this.context.dispatch({
              type: "thread-msg",
              id: thread.id,
              msg,
            }),
        })}`;
      }
      case "error":
        return d`Error: ${threadWrapper.error.message}`;
      default:
        assertUnreachable(threadWrapper);
    }
  }

  view() {
    if (this.state.state === "thread-overview") {
      return this.renderThreadOverview();
    } else {
      return this.renderActiveThread();
    }
  }
}

function getActiveProfile(profiles: Profile[], activeProfile: string) {
  const profile = profiles.find((p) => p.name == activeProfile);
  if (!profile) {
    throw new Error(`Profile ${activeProfile} not found.`);
  }
  return profile;
}
