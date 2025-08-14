import { Message, type MessageId, type Msg as MessageMsg } from "./message.ts";

import {
  ContextManager,
  type Msg as ContextManagerMsg,
} from "../context/context-manager.ts";
import { type Dispatch } from "../tea/tea.ts";
import { d, type View, type VDOMNode } from "../tea/view.ts";
import {
  ToolManager,
  type Msg as ToolManagerMsg,
  type StaticToolRequest,
} from "../tools/toolManager.ts";
import { MCPToolManager } from "../tools/mcp/manager.ts";
import { Counter } from "../utils/uniqueId.ts";
import { FileSnapshots } from "../tools/file-snapshots.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { Lsp } from "../lsp.ts";
import { getDiagnostics } from "../utils/diagnostics.ts";
import { getQuickfixList, quickfixListToString } from "../nvim/nvim.ts";
import { getBuffersList } from "../utils/listBuffers.ts";
import {
  getProvider as getProvider,
  type ProviderMessage,
  type ProviderMessageContent,
  type ProviderStreamEvent,
  type ProviderStreamRequest,
  type StopReason,
  type Usage,
} from "../providers/provider.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { type MagentaOptions, type Profile } from "../options.ts";
import type { RootMsg } from "../root-msg.ts";
import type { NvimCwd, UnresolvedFilePath } from "../utils/files.ts";
import type { BufferTracker } from "../buffer-tracker.ts";
import {
  type Input as ThreadTitleInput,
  spec as threadTitleToolSpec,
} from "../tools/thread-title.ts";
import {
  resolveFilePath,
  relativePath,
  detectFileType,
} from "../utils/files.ts";

import type { Chat } from "./chat.ts";
import type { ThreadId, ThreadType } from "./types.ts";
import type { SystemPrompt } from "../providers/system-prompt.ts";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { $, within } from "zx";
import player from "play-sound";

export type StoppedConversationState = {
  state: "stopped";
  stopReason: StopReason;
  usage: Usage;
};

export type ConversationState =
  | {
      state: "message-in-flight";
      sendDate: Date;
      request: ProviderStreamRequest;
    }
  | StoppedConversationState
  | {
      state: "error";
      error: Error;
      lastAssistantMessage?: Message;
    }
  | {
      state: "yielded";
      response: string;
    };

export type InputMessage =
  | {
      type: "user";
      text: string;
    }
  | {
      type: "system";
      text: string;
    };

export type Msg =
  | { type: "set-title"; title: string }
  | { type: "update-profile"; profile: Profile }
  | {
      type: "stream-event";
      event: ProviderStreamEvent;
    }
  | {
      type: "send-message";
      messages: InputMessage[];
    }
  | {
      type: "conversation-state";
      conversation: ConversationState;
    }
  | {
      type: "clear";
      profile: Profile;
    }
  | {
      type: "abort";
    }
  // | {
  //     type: "show-message-debug-info";
  //   }
  | {
      type: "message-msg";
      msg: MessageMsg;
      id: MessageId;
    }
  | {
      type: "take-file-snapshot";
      unresolvedFilePath: UnresolvedFilePath;
      messageId: MessageId;
    }
  | {
      type: "tool-manager-msg";
      msg: ToolManagerMsg;
    }
  | {
      type: "context-manager-msg";
      msg: ContextManagerMsg;
    };

export type ThreadMsg = {
  type: "thread-msg";
  id: ThreadId;
  msg: Msg;
};

export class Thread {
  public state: {
    title?: string | undefined;
    lastUserMessageId: MessageId;
    profile: Profile;
    conversation: ConversationState;
    messages: Message[];
    threadType: ThreadType;
    systemPrompt: SystemPrompt;
    pendingMessages: InputMessage[];
  };

  private myDispatch: Dispatch<Msg>;
  public toolManager: ToolManager;
  private counter: Counter;
  public fileSnapshots: FileSnapshots;
  public contextManager: ContextManager;
  public forkNextPrompt: string | undefined;

  constructor(
    public id: ThreadId,
    threadType: ThreadType,
    systemPrompt: SystemPrompt,
    public context: {
      dispatch: Dispatch<RootMsg>;
      chat: Chat;
      mcpToolManager: MCPToolManager;
      bufferTracker: BufferTracker;
      profile: Profile;
      nvim: Nvim;
      cwd: NvimCwd;
      lsp: Lsp;
      contextManager: ContextManager;
      options: MagentaOptions;
      getDisplayWidth: () => number;
    },
  ) {
    this.myDispatch = (msg) =>
      this.context.dispatch({
        type: "thread-msg",
        id: this.id,
        msg,
      });

    this.counter = new Counter();
    this.toolManager = new ToolManager(
      (msg) =>
        this.myDispatch({
          type: "tool-manager-msg",
          msg,
        }),
      {
        ...this.context,
        threadId: this.id,
      },
    );

    this.fileSnapshots = new FileSnapshots(this.context.nvim, this.context.cwd);
    this.contextManager = this.context.contextManager;

    this.state = {
      lastUserMessageId: this.counter.last() as MessageId,
      profile: this.context.profile,
      conversation: {
        state: "stopped",
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      messages: [],
      threadType: threadType,
      systemPrompt: systemPrompt,
      pendingMessages: [],
    };
  }

  update(msg: RootMsg): void {
    if (msg.type == "thread-msg" && msg.id == this.id) {
      this.myUpdate(msg.msg);
    }
  }

  private myUpdate(msg: Msg): void {
    switch (msg.type) {
      case "update-profile":
        this.state.profile = msg.profile;
        break;

      case "conversation-state": {
        this.state.conversation = msg.conversation;

        switch (msg.conversation.state) {
          case "stopped": {
            this.handleConversationStop(msg.conversation);
            break;
          }

          case "error": {
            if (
              this.state.conversation.state == "stopped" &&
              this.state.conversation.stopReason == "aborted"
            ) {
              break;
            }
            const lastAssistantMessage =
              this.state.messages[this.state.messages.length - 1];
            if (lastAssistantMessage?.state.role == "assistant") {
              this.state.messages.pop();

              (
                this.state.conversation as Extract<
                  ConversationState,
                  { state: "error" }
                >
              ).lastAssistantMessage = lastAssistantMessage;
            }

            const lastUserMessage =
              this.state.messages[this.state.messages.length - 1];
            if (lastUserMessage?.state.role == "user") {
              this.state.messages.pop();

              setTimeout(
                () =>
                  this.context.dispatch({
                    type: "sidebar-msg",
                    msg: {
                      type: "setup-resubmit",
                      lastUserMessage: lastUserMessage.state.content
                        .map((p) => (p.type == "text" ? p.text : ""))
                        .join(""),
                    },
                  }),
                1,
              );
            }
            break;
          }

          case "yielded":
          case "message-in-flight":
            break;

          default:
            assertUnreachable(msg.conversation);
        }

        break;
      }

      case "send-message": {
        // Check if any message starts with @async
        const isAsync = msg.messages.some(
          (m) => m.type === "user" && m.text.trim().startsWith("@async"),
        );
        const messages = msg.messages.map((m) => ({
          ...m,
          text: m.text.replace(/^\s*@async\s*/, ""),
        }));

        if (
          this.state.conversation.state == "message-in-flight" ||
          (this.state.conversation.state == "stopped" &&
            this.state.conversation.stopReason == "tool_use")
        ) {
          if (isAsync) {
            this.state.pendingMessages.push(...messages);

            // this break should terminate the send-message case
            break;
          } else {
            this.abortInProgressOperations();
          }
        }

        this.sendMessage(messages).catch(
          this.handleSendMessageError.bind(this),
        );

        if (!this.state.title) {
          this.setThreadTitle(msg.messages.map((m) => m.text).join("\n")).catch(
            (err: Error) =>
              this.context.nvim.logger.error(
                "Error getting thread title: " + err.message + "\n" + err.stack,
              ),
          );
        }

        if (msg.messages.length) {
          // NOTE: this is a bit hacky. We want to scroll after the user message has been populated in the display
          // buffer. the 100ms timeout is not the most precise way to do that, but it works for now
          setTimeout(() => {
            this.context.dispatch({
              type: "sidebar-msg",
              msg: {
                type: "scroll-to-last-user-message",
              },
            });
          }, 100);
        }
        break;
      }

      case "stream-event": {
        const lastMessage = this.state.messages[this.state.messages.length - 1];
        if (lastMessage?.state.role !== "assistant") {
          const messageId = this.counter.get() as MessageId;
          const message = new Message(
            {
              id: messageId,
              role: "assistant",
            },
            {
              ...this.context,
              threadId: this.id,
              myDispatch: (msg) =>
                this.myDispatch({
                  type: "message-msg",
                  id: messageId,
                  msg,
                }),
              toolManager: this.toolManager,
              fileSnapshots: this.fileSnapshots,
              contextManager: this.contextManager,
            },
          );

          this.state.messages.push(message);
        }

        const message = this.state.messages[this.state.messages.length - 1];
        message.update({
          type: "stream-event",
          event: msg.event,
        });

        return;
      }

      case "clear": {
        this.abortInProgressOperations();

        this.state = {
          lastUserMessageId: this.counter.last() as MessageId,
          profile: msg.profile,
          conversation: {
            state: "stopped",
            stopReason: "end_turn",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
          messages: [],
          threadType: this.state.threadType,
          systemPrompt: this.state.systemPrompt,
          pendingMessages: [],
        };
        this.contextManager.reset();

        // Scroll to bottom after clearing
        setTimeout(() => {
          this.context.dispatch({
            type: "sidebar-msg",
            msg: {
              type: "scroll-to-bottom",
            },
          });
        }, 100);

        return undefined;
      }

      case "message-msg": {
        const message = this.state.messages.find((m) => m.state.id == msg.id);
        if (!message) {
          throw new Error(`Unable to find message with id ${msg.id}`);
        }
        message.update(msg.msg);
        return;
      }

      case "take-file-snapshot": {
        this.fileSnapshots
          .willEditFile(msg.unresolvedFilePath, msg.messageId)
          .catch((e: Error) => {
            this.context.nvim.logger.error(
              `Failed to take file snapshot: ${e.message}`,
            );
          });
        return;
      }

      case "tool-manager-msg": {
        this.toolManager.update(msg.msg);
        this.maybeAutoRespond();
        return;
      }

      case "context-manager-msg": {
        this.contextManager.update(msg.msg);
        return;
      }

      case "abort": {
        this.abortInProgressOperations();
        return;
      }

      case "set-title": {
        this.state.title = msg.title;
        return;
      }

      default:
        assertUnreachable(msg);
    }
  }

  private handleConversationStop(stoppedState: StoppedConversationState) {
    const lastMessage = this.state.messages[this.state.messages.length - 1];
    if (lastMessage) {
      lastMessage.update({
        type: "stop",
        stopReason: stoppedState.stopReason,
        usage: stoppedState.usage,
      });
    }

    if (lastMessage && lastMessage.state.role == "assistant") {
      const lastContentBlock =
        lastMessage.state.content[lastMessage.state.content.length - 1];
      if (
        lastContentBlock.type == "tool_use" &&
        lastContentBlock.request.status == "ok"
      ) {
        const request = lastContentBlock.request.value;
        if (request.toolName == "yield_to_parent") {
          const yieldRequest = request as Extract<
            StaticToolRequest,
            { toolName: "yield_to_parent" }
          >;
          this.myUpdate({
            type: "conversation-state",
            conversation: {
              state: "yielded",
              response: yieldRequest.input.result,
            },
          });
          return;
        }
      }
    }

    this.state.conversation = stoppedState;

    const didAutoRespond = this.maybeAutoRespond();
    if (!didAutoRespond) {
      this.playChimeIfNeeded();
    }
  }

  private abortInProgressOperations(): void {
    if (this.state.conversation.state === "message-in-flight") {
      this.state.conversation.request.abort();
    }

    const lastMessage = this.state.messages[this.state.messages.length - 1];
    if (lastMessage) {
      for (const content of lastMessage.state.content) {
        if (content.type === "tool_use") {
          const tool = this.toolManager.getTool(content.id);
          if (!tool.isDone()) {
            tool.abort();
          }
        }
      }

      // Remove server_tool_use content that doesn't have corresponding results
      if (lastMessage.state.role === "assistant") {
        const serverToolUseIds = new Set<string>();
        const toolResultIds = new Set<string>();

        // Collect server tool use IDs and tool result IDs
        for (const content of lastMessage.state.content) {
          if (content.type === "server_tool_use") {
            serverToolUseIds.add(content.id);
          } else if (content.type === "web_search_tool_result") {
            toolResultIds.add(content.tool_use_id);
          }
        }

        // Remove server_tool_use content that has no corresponding result
        lastMessage.state.content = lastMessage.state.content.filter(
          (content) => {
            if (content.type === "server_tool_use") {
              return toolResultIds.has(content.id);
            }
            return true;
          },
        );
      }
    }

    this.handleConversationStop({
      state: "stopped",
      stopReason: "aborted",
      usage: {
        inputTokens: -1,
        outputTokens: -1,
      },
    });
  }

  maybeAutoRespond(): boolean {
    if (
      this.state.conversation.state == "stopped" &&
      this.state.conversation.stopReason == "tool_use"
    ) {
      const lastMessage = this.state.messages[this.state.messages.length - 1];
      if (lastMessage && lastMessage.state.role == "assistant") {
        for (const content of lastMessage.state.content) {
          if (content.type == "tool_use" && content.request.status == "ok") {
            const request = content.request.value;
            const tool = this.toolManager.getTool(request.id);

            if (tool.request.toolName == "yield_to_parent" || !tool.isDone()) {
              // terminate early if we have a blocking tool use. This will not send a reply message
              return false;
            }
          }
        }

        const messages = this.state.pendingMessages;
        this.state.pendingMessages = [];
        this.sendMessage(messages).catch(
          this.handleSendMessageError.bind(this),
        );
        return true;
      }
    } else if (
      this.state.conversation.state == "stopped" &&
      this.state.conversation.stopReason == "end_turn" &&
      this.state.pendingMessages.length
    ) {
      const messages = this.state.pendingMessages;
      this.state.pendingMessages = [];
      this.sendMessage(messages).catch(this.handleSendMessageError.bind(this));
      return true;
    }
    return false;
  }

  private handleSendMessageError = (error: Error): void => {
    if (this.state.conversation.state == "message-in-flight") {
      this.context.nvim.logger.error(error);
      this.myDispatch({
        type: "conversation-state",
        conversation: {
          state: "error",
          error,
        },
      });
    }
  };

  private playChimeIfNeeded(): void {
    // Play chime when we need the user to do something:
    // 1. Agent stopped with end_turn (user needs to respond)
    // 2. We're blocked on a tool use that requires user action
    if (this.state.conversation.state != "stopped") {
      return;
    }
    const stopReason = this.state.conversation.stopReason;
    if (stopReason === "end_turn") {
      this.playChimeSound();
      return;
    }

    if (stopReason === "tool_use") {
      const lastMessage = this.state.messages[this.state.messages.length - 1];
      if (lastMessage && lastMessage.state.role === "assistant") {
        for (const content of lastMessage.state.content) {
          if (content.type === "tool_use" && content.request.status === "ok") {
            const request = content.request.value;
            const tool = this.toolManager.getTool(request.id);

            if (tool.isPendingUserAction()) {
              this.playChimeSound();
              return;
            }
          }
        }
      }
    }
  }

  private playChimeSound(): void {
    const actualVolume = this.context.options.chimeVolume;

    if (!actualVolume) {
      return;
    }

    try {
      const play = player();
      const chimeFile = join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "chime.wav",
      );

      // Play sound with volume control (platform-specific options)
      const playOptions = {
        // For macOS afplay: volume range is 0-1, where 1 is full volume
        afplay: ["-v", actualVolume.toString()],
        // For Linux aplay: volume range is 0-100%
        aplay: ["-v", Math.round(actualVolume * 100).toString() + "%"],
        // For mpg123: volume range is 0-32768
        mpg123: ["-f", Math.round(actualVolume * 32768).toString()],
      };

      play.play(chimeFile, playOptions, (err: Error | null) => {
        if (err) {
          this.context.nvim.logger.error(
            `Failed to play chime sound: ${err.message}`,
          );
        }
      });
    } catch (error) {
      this.context.nvim.logger.error(
        `Error setting up chime sound: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async prepareUserMessage(
    messages?: InputMessage[],
  ): Promise<{ messageId: MessageId; addedMessage: boolean }> {
    const messageId = this.counter.get() as MessageId;

    // Process messages first to handle @file commands
    const messageContent: ProviderMessageContent[] = [];
    for (const m of messages || []) {
      // Check for @fork command in user messages
      if (m.type === "user" && m.text.includes("@fork")) {
        // Extract the text after @fork and remove @fork from the original text
        const forkText = m.text.replace(/@fork\s*/g, "").trim();

        // Append diagnostics as a separate content block
        messageContent.push({
          type: "text",
          text: `\
My next prompt will be:
${forkText}

Use the fork_thread tool to start a new thread for this prompt.

- Carefully analyze the prompt
- Identify key concepts, patterns, files and decisions that may be relevant
- Include higly relevant files as contextFiles
- Name less relevant files that may be useful in the summary, but leave them out of contextFiles.
- Summarize ONLY information that directly supports addressing the next prompt, especially previous user instructions and observations that cannot be directly observable in the codebase.
- Prefer including files in contextFiles to copying code from those files into the summary. Do not repeat anything in the summary that can be learned directly from contextFiles.

You must use the fork_thread tool immediately, with only the information you already have. Do not use any other tools.`,
        });
        this.forkNextPrompt = forkText;
      } else {
        messageContent.push({
          type: "text",
          text: m.text,
        });
      }

      // Check for diagnostics keywords in user messages
      if (
        m.type === "user" &&
        (m.text.includes("@diag") || m.text.includes("@diagnostics"))
      ) {
        try {
          const diagnostics = await getDiagnostics(this.context.nvim);

          // Append diagnostics as a separate content block
          messageContent.push({
            type: "text",
            text: `Current diagnostics:\n${diagnostics}`,
          });
        } catch (error) {
          this.context.nvim.logger.error(
            `Failed to fetch diagnostics for message: ${error instanceof Error ? error.message : String(error)}`,
          );
          // Append error message as a separate content block
          messageContent.push({
            type: "text",
            text: `Error fetching diagnostics: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      // Check for quickfix keywords in user messages
      if (
        m.type === "user" &&
        (m.text.includes("@qf") || m.text.includes("@quickfix"))
      ) {
        try {
          const qflist = await getQuickfixList(this.context.nvim);
          const quickfixStr = await quickfixListToString(
            qflist,
            this.context.nvim,
          );

          // Append quickfix as a separate content block
          messageContent.push({
            type: "text",
            text: `Current quickfix list:\n${quickfixStr}`,
          });
        } catch (error) {
          this.context.nvim.logger.error(
            `Failed to fetch quickfix list for message: ${error instanceof Error ? error.message : String(error)}`,
          );
          // Append error message as a separate content block
          messageContent.push({
            type: "text",
            text: `Error fetching quickfix list: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      // Check for buffer keywords in user messages
      if (
        m.type === "user" &&
        (m.text.includes("@buf") || m.text.includes("@buffers"))
      ) {
        try {
          const buffersList = await getBuffersList(this.context.nvim);

          // Append buffers list as a separate content block
          messageContent.push({
            type: "text",
            text: `Current buffers list:\n${buffersList}`,
          });
        } catch (error) {
          this.context.nvim.logger.error(
            `Failed to fetch buffers list for message: ${error instanceof Error ? error.message : String(error)}`,
          );
          // Append error message as a separate content block
          messageContent.push({
            type: "text",
            text: `Error fetching buffers list: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      // Check for file commands in user messages
      if (m.type === "user") {
        const fileMatches = m.text.matchAll(/@file:(\S+)/g);
        for (const match of fileMatches) {
          const filePath = match[1] as UnresolvedFilePath;
          try {
            const absFilePath = resolveFilePath(this.context.cwd, filePath);
            const relFilePath = relativePath(this.context.cwd, absFilePath);
            const fileTypeInfo = await detectFileType(absFilePath);

            if (!fileTypeInfo) {
              throw new Error(`File ${filePath} does not exist`);
            }

            this.contextManager.update({
              type: "add-file-context",
              relFilePath,
              absFilePath,
              fileTypeInfo,
            });
          } catch (error) {
            this.context.nvim.logger.error(
              `Failed to add file to context for ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
            );
            messageContent.push({
              type: "text",
              text: `Error adding file to context for ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }

        const diffMatches = m.text.matchAll(/@diff:(\S+)/g);
        for (const match of diffMatches) {
          const filePath = match[1] as UnresolvedFilePath;
          try {
            const diffContent = await getGitDiff(filePath, this.context.cwd);
            messageContent.push({
              type: "text",
              text: `Git diff for \`${filePath}\`:\n\`\`\`diff\n${diffContent}\n\`\`\``,
            });
          } catch (error) {
            this.context.nvim.logger.error(
              `Failed to fetch git diff for \`${filePath}\`: ${error instanceof Error ? error.message : String(error)}`,
            );
            messageContent.push({
              type: "text",
              text: `Error fetching git diff for \`${filePath}\`: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }

        const stagedMatches = m.text.matchAll(/@staged:(\S+)/g);
        for (const match of stagedMatches) {
          const filePath = match[1] as UnresolvedFilePath;
          try {
            const stagedContent = await getStagedDiff(
              filePath,
              this.context.cwd,
            );
            messageContent.push({
              type: "text",
              text: `Staged diff for \`${filePath}\`:\n\`\`\`diff\n${stagedContent}\n\`\`\``,
            });
          } catch (error) {
            this.context.nvim.logger.error(
              `Failed to fetch staged diff for \`${filePath}\`: ${error instanceof Error ? error.message : String(error)}`,
            );
            messageContent.push({
              type: "text",
              text: `Error fetching staged diff for \`${filePath}\`: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
      }
    }

    // Now get context updates after all @file commands have been processed
    const contextUpdates = await this.contextManager.getContextUpdate();

    if (messages?.length || Object.keys(contextUpdates).length) {
      const message = new Message(
        {
          id: messageId,
          role: "user",
          content: messageContent,
          contextUpdates: Object.keys(contextUpdates).length
            ? contextUpdates
            : undefined,
        },
        {
          dispatch: this.context.dispatch,
          threadId: this.id,
          myDispatch: (msg) =>
            this.myDispatch({
              type: "message-msg",
              id: messageId,
              msg,
            }),
          nvim: this.context.nvim,
          cwd: this.context.cwd,
          toolManager: this.toolManager,
          fileSnapshots: this.fileSnapshots,
          options: this.context.options,
          contextManager: this.contextManager,
          getDisplayWidth: this.context.getDisplayWidth,
        },
      );

      this.state.messages.push(message);
      this.state.lastUserMessageId = message.state.id;
      return { messageId, addedMessage: true };
    }

    return { messageId, addedMessage: false };
  }

  async sendMessage(inputMessages?: InputMessage[]): Promise<void> {
    await this.prepareUserMessage(inputMessages);
    const messages = this.getMessages();

    const provider = getProvider(this.context.nvim, this.state.profile);
    const request = provider.sendMessage({
      model: this.state.profile.model,
      messages,
      onStreamEvent: (event) => {
        if (!request.aborted) {
          this.myDispatch({
            type: "stream-event",
            event,
          });
        }
      },
      tools: this.toolManager.getToolSpecs(this.state.threadType),
      systemPrompt: this.state.systemPrompt,
      ...(this.state.profile.thinking &&
        this.state.profile.provider === "anthropic" && {
          thinking: this.state.profile.thinking,
        }),
      ...(this.state.profile.reasoning &&
        this.state.profile.provider === "openai" && {
          reasoning: this.state.profile.reasoning,
        }),
    });

    this.myDispatch({
      type: "conversation-state",
      conversation: {
        state: "message-in-flight",
        sendDate: new Date(),
        request,
      },
    });

    const res = await request.promise;
    this.myDispatch({
      type: "conversation-state",
      conversation: {
        state: "stopped",
        stopReason: res?.stopReason || "end_turn",
        usage: res?.usage || { inputTokens: 0, outputTokens: 0 },
      },
    });
  }

  getMessages(): ProviderMessage[] {
    const messages = this.state.messages.flatMap((message) => {
      let messageContent: ProviderMessageContent[] = [];
      const out: ProviderMessage[] = [];

      function commitMessages() {
        if (messageContent.length) {
          out.push({
            role: message.state.role,
            content: messageContent,
          });
          messageContent = [];
        }
      }

      /** result blocks must go into user messages
       */
      function pushResponseMessage(content: ProviderMessageContent) {
        commitMessages();
        out.push({
          role: "user",
          content: [content],
        });
      }

      if (message.state.contextUpdates) {
        const contextContent = this.contextManager.contextUpdatesToContent(
          message.state.contextUpdates,
        );
        messageContent.push(...contextContent);
      }

      for (const contentBlock of message.state.content) {
        messageContent.push(contentBlock);

        if (contentBlock.type == "tool_use") {
          if (contentBlock.request.status == "ok") {
            const request = contentBlock.request.value;
            const tool = this.toolManager.getTool(request.id);
            pushResponseMessage(tool.getToolResult());
          } else {
            pushResponseMessage({
              type: "tool_result",
              id: contentBlock.id,
              result: contentBlock.request,
            });
          }
        }
      }

      commitMessages();

      return out.map((m) => ({
        message: m,
        messageId: message.state.id,
      }));
    });

    return messages.map((m) => m.message);
  }

  async setThreadTitle(userMessage: string) {
    const request = getProvider(
      this.context.nvim,
      this.context.profile,
    ).forceToolUse({
      model: this.context.profile.fastModel,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `\
The user has provided the following prompt:
${userMessage}

Come up with a succinct thread title for this prompt. It should be less than 80 characters long.
`,
            },
          ],
        },
      ],
      spec: threadTitleToolSpec,
      systemPrompt: this.state.systemPrompt,
      disableCaching: true,
    });
    const result = await request.promise;
    if (result.toolRequest.status == "ok") {
      this.myDispatch({
        type: "set-title",
        title: (result.toolRequest.value.input as ThreadTitleInput).title,
      });
    }
  }

  getLastStopTokenCount(): number {
    for (
      let msgIdx = this.state.messages.length - 1;
      msgIdx >= 0;
      msgIdx -= 1
    ) {
      const message = this.state.messages[msgIdx];

      if (
        message.state.stop &&
        // aborted requests and errors don't have usage so we should probably skip those
        message.state.stop.usage.inputTokens +
          message.state.stop.usage.outputTokens >
          0
      ) {
        const stopInfo = message.state.stop;

        return (
          stopInfo.usage.inputTokens +
          stopInfo.usage.outputTokens +
          (stopInfo.usage.cacheHits || 0) +
          (stopInfo.usage.cacheMisses || 0)
        );
      }

      // Find the most recent stop event by iterating content in reverse order
      for (
        let contentIdx = message.state.content.length - 1;
        contentIdx >= 0;
        contentIdx--
      ) {
        const content = message.state.content[contentIdx];
        if (content.type === "tool_use" && content.request.status === "ok") {
          // For tool use content, check toolMeta
          const toolMeta = message.state.toolMeta[content.request.value.id];
          if (toolMeta?.stop) {
            const stopInfo = toolMeta.stop;

            return (
              stopInfo.usage.inputTokens +
              stopInfo.usage.outputTokens +
              (stopInfo.usage.cacheHits || 0) +
              (stopInfo.usage.cacheMisses || 0)
            );
          }
        }
      }
    }

    return 0;
  }
}

/**
 * Helper function to render the animation frame for in-progress operations
 */
const getAnimationFrame = (sendDate: Date): string => {
  const frameIndex =
    Math.floor((new Date().getTime() - sendDate.getTime()) / 333) %
    MESSAGE_ANIMATION.length;

  return MESSAGE_ANIMATION[frameIndex];
};

/**
 * Helper function to render the conversation state message
 */
const renderConversationState = (conversation: ConversationState): VDOMNode => {
  switch (conversation.state) {
    case "message-in-flight":
      return d`Streaming response ${getAnimationFrame(conversation.sendDate)}`;
    case "stopped":
      return d``; // will be rendered by the last message
    case "yielded":
      return d`↗️ yielded to parent: ${conversation.response}`;
    case "error":
      return d`Error ${conversation.error.message}${
        conversation.error.stack ? "\n" + conversation.error.stack : ""
      }${
        conversation.lastAssistantMessage
          ? "\n\nLast assistant message:\n" +
            conversation.lastAssistantMessage.toString()
          : ""
      }`;
    default:
      assertUnreachable(conversation);
  }
};

/**
 * Helper function to determine if context manager view should be shown
 */
const shouldShowContextManager = (
  conversation: ConversationState,
  contextManager: ContextManager,
): boolean => {
  return (
    conversation.state !== "message-in-flight" &&
    !contextManager.isContextEmpty()
  );
};

export const view: View<{
  thread: Thread;
  dispatch: Dispatch<Msg>;
}> = ({ thread }) => {
  const titleView = thread.state.title
    ? d`# ${thread.state.title}`
    : d`# [ Untitled ]`;

  if (
    thread.state.messages.length == 0 &&
    thread.state.conversation.state == "stopped" &&
    thread.state.conversation.stopReason == "end_turn"
  ) {
    return d`\
${titleView}
${LOGO}

magenta is for agentic flow

${thread.context.contextManager.view()}`;
  }

  const conversationStateView = renderConversationState(
    thread.state.conversation,
  );

  const contextManagerView = shouldShowContextManager(
    thread.state.conversation,
    thread.context.contextManager,
  )
    ? d`\n${thread.context.contextManager.view()}`
    : d``;

  const pendingMessagesView =
    thread.state.pendingMessages.length > 0
      ? d`\n✉️  ${thread.state.pendingMessages.length.toString()} pending message${thread.state.pendingMessages.length === 1 ? "" : "s"}`
      : d``;

  return d`\
${titleView}
${thread.state.messages.map((m) => d`${m.view()}\n`)}\
${contextManagerView}\
${pendingMessagesView}\
${conversationStateView}`;
};

export const LOGO = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "logo.txt"),
  "utf-8",
);

const MESSAGE_ANIMATION = ["⠁", "⠂", "⠄", "⠂"];

/**
 * Helper functions for new @ commands
 */
async function getGitDiff(
  filePath: UnresolvedFilePath,
  cwd: NvimCwd,
): Promise<string> {
  try {
    const result = await within(async () => {
      $.cwd = cwd;
      return await $`git diff ${filePath}`;
    });
    return result.stdout || "(no unstaged changes)";
  } catch (error) {
    throw new Error(
      `Failed to get git diff: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function getStagedDiff(
  filePath: UnresolvedFilePath,
  cwd: NvimCwd,
): Promise<string> {
  try {
    const result = await within(async () => {
      $.cwd = cwd;
      return await $`git diff --staged ${filePath}`;
    });
    return result.stdout || "(no staged changes)";
  } catch (error) {
    throw new Error(
      `Failed to get staged diff: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
