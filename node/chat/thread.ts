import { Message, type MessageId, type Msg as MessageMsg } from "./message.ts";

import {
  ContextManager,
  type Msg as ContextManagerMsg,
} from "../context/context-manager.ts";
import { type Dispatch } from "../tea/tea.ts";
import { d, type View } from "../tea/view.ts";
import {
  ToolManager,
  type Msg as ToolManagerMsg,
  type ToolRequestId,
} from "../tools/toolManager.ts";
import { Counter } from "../utils/uniqueId.ts";
import { FileSnapshots } from "../tools/file-snapshots.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { Lsp } from "../lsp.ts";
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
import type { UnresolvedFilePath } from "../utils/files.ts";

export type Role = "user" | "assistant";

export type ConversationState =
  | {
      state: "message-in-flight";
      sendDate: Date;
      request: ProviderStreamRequest;
    }
  | {
      state: "stopped";
      stopReason: StopReason;
      usage: Usage;
    }
  | {
      state: "error";
      error: Error;
      lastAssistantMessage?: Message;
    };

export type Msg =
  | { type: "update-profile"; profile: Profile }
  | {
      type: "user-message";
      content: string;
    }
  | {
      type: "stream-event";
      event: ProviderStreamEvent;
    }
  | {
      type: "send-message";
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

export type ThreadId = number & { __threadId: true };

export class Thread {
  public state: {
    lastUserMessageId: MessageId;
    profile: Profile;
    conversation: ConversationState;
    messages: Message[];
  };

  private dispatch: Dispatch<RootMsg>;
  private myDispatch: Dispatch<Msg>;
  public toolManager: ToolManager;
  public contextManager: ContextManager;
  private counter: Counter;
  private nvim: Nvim;
  private lsp: Lsp;
  private options: MagentaOptions;
  public fileSnapshots: FileSnapshots;

  constructor(
    public id: ThreadId,
    {
      dispatch,
      profile,
      nvim,
      contextManager,
      lsp,
      options,
    }: {
      dispatch: Dispatch<RootMsg>;
      profile: Profile;
      nvim: Nvim;
      lsp: Lsp;
      contextManager: ContextManager;
      options: MagentaOptions;
    },
  ) {
    this.dispatch = dispatch;
    this.myDispatch = (msg) =>
      this.dispatch({
        type: "thread-msg",
        id: this.id,
        msg,
      });

    this.nvim = nvim;
    this.lsp = lsp;
    this.counter = new Counter();
    this.contextManager = contextManager;
    this.options = options;
    this.toolManager = new ToolManager(
      (msg) =>
        this.myDispatch({
          type: "tool-manager-msg",
          msg,
        }),
      {
        dispatch: this.dispatch,
        nvim: this.nvim,
        lsp: this.lsp,
        options: this.options,
      },
    );

    this.fileSnapshots = new FileSnapshots(this.nvim);

    this.state = {
      lastUserMessageId: this.counter.last() as MessageId,
      profile,
      conversation: {
        state: "stopped",
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      messages: [],
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
      case "user-message": {
        const message = new Message(
          {
            id: this.counter.get() as MessageId,
            streamingBlock: undefined,
            role: "user",
            content: [
              {
                type: "text",
                text: msg.content,
              },
            ],
            edits: {},
          },
          {
            dispatch: this.dispatch,
            threadId: this.id,
            myDispatch: (msg) =>
              this.myDispatch({
                type: "message-msg",
                id: message.state.id,
                msg,
              }),
            nvim: this.nvim,
            toolManager: this.toolManager,
            fileSnapshots: this.fileSnapshots,
            options: this.options,
          },
        );
        this.state.messages.push(message);

        if (message.state.role == "user") {
          this.state.lastUserMessageId = message.state.id;
        }

        return;
      }

      case "conversation-state": {
        this.state.conversation = msg.conversation;

        switch (msg.conversation.state) {
          case "stopped": {
            const lastMessage =
              this.state.messages[this.state.messages.length - 1];
            lastMessage.update({
              type: "stop",
              stopReason: msg.conversation.stopReason,
              usage: msg.conversation.usage,
            });
            this.maybeAutorespond();
            return;
          }

          case "error": {
            const lastAssistantMessage =
              this.state.messages[this.state.messages.length - 1];
            if (lastAssistantMessage?.state.role == "assistant") {
              this.state.messages.pop();

              // save the last message so we can show a nicer error message.
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

              // dispatch a followup action next tick
              setTimeout(
                () =>
                  this.dispatch({
                    type: "sidebar-setup-resubmit",
                    lastUserMessage: lastUserMessage.state.content
                      .map((p) => (p.type == "text" ? p.text : ""))
                      .join(""),
                  }),
                1,
              );
            }
            break;
          }

          case "message-in-flight":
            break;

          default:
            assertUnreachable(msg.conversation);
        }
        break;
      }

      case "send-message": {
        const lastMessage = this.state.messages[this.state.messages.length - 1];
        if (lastMessage && lastMessage.state.role == "user") {
          this.sendMessage().catch(this.handleSendMessageError.bind(this));
        } else {
          this.nvim.logger?.error(
            `Cannot send when the last message has role ${lastMessage && lastMessage.state.role}`,
          );
        }
        break;
      }

      case "stream-event": {
        const lastMessage = this.state.messages[this.state.messages.length - 1];
        if (lastMessage?.state.role !== "assistant") {
          const message = new Message(
            {
              id: this.counter.get() as MessageId,
              role: "assistant",
              streamingBlock: undefined,
              content: [],
              edits: {},
            },
            {
              threadId: this.id,
              dispatch: this.dispatch,
              myDispatch: (msg) =>
                this.myDispatch({
                  type: "message-msg",
                  id: lastMessage.state.id,
                  msg,
                }),
              nvim: this.nvim,
              toolManager: this.toolManager,
              fileSnapshots: this.fileSnapshots,
              options: this.options,
            },
          );

          this.state.messages.push(message);
        }

        switch (msg.event.type) {
          case "message_start":
          case "message_delta":
            return;
          case "message_stop":
            return;
          case "content_block_start":
          case "content_block_delta":
          case "content_block_stop": {
            const message = this.state.messages[this.state.messages.length - 1];
            message.update({
              type: "stream-event",
              event: msg.event,
            });
            return;
          }
          default:
            return assertUnreachable(msg.event);
        }
      }

      case "clear": {
        this.state = {
          lastUserMessageId: this.counter.last() as MessageId,
          profile: msg.profile,
          conversation: {
            state: "stopped",
            stopReason: "end_turn",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
          messages: [],
        };
        return undefined;
      }

      // case "show-message-debug-info": {
      //   // eslint-disable-next-line @typescript-eslint/no-floating-promises
      //   this.showDebugInfo();
      //   return;
      // }
      //
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
            this.nvim.logger?.error(
              `Failed to take file snapshot: ${e.message}`,
            );
          });
        return;
      }

      case "tool-manager-msg": {
        this.toolManager.update(msg.msg);
        this.maybeAutorespond();
        return;
      }

      case "context-manager-msg": {
        this.contextManager.update(msg.msg);
        return;
      }
      case "abort": {
        if (this.state.conversation.state == "message-in-flight") {
          this.state.conversation.request.abort();
        }

        const lastMessage = this.state.messages[this.state.messages.length - 1];
        for (const content of lastMessage.state.content) {
          if (content.type == "tool_use") {
            this.myDispatch({
              type: "tool-manager-msg",
              msg: {
                type: "abort-tool-use",
                requestId: content.id,
              },
            });
          }
        }

        lastMessage.update({
          type: "stop",
          stopReason: "aborted",
          usage: {
            inputTokens: -1,
            outputTokens: -1,
          },
        });

        this.state.conversation = {
          state: "stopped",
          stopReason: "aborted",
          usage: {
            inputTokens: -1,
            outputTokens: -1,
          },
        };

        return;
      }

      default:
        assertUnreachable(msg);
    }
  }

  /** If the agent is waiting on tool use, check the last message to see if all tools have been resolved. If so,
   * automatically respond.
   */
  maybeAutorespond(): void {
    if (
      !(
        this.state.conversation.state == "stopped" &&
        this.state.conversation.stopReason == "tool_use"
      )
    ) {
      return;
    }

    const lastMessage = this.state.messages[this.state.messages.length - 1];
    if (!(lastMessage && lastMessage.state.role == "assistant")) {
      return;
    }

    const isBlocking = (requestId: ToolRequestId) => {
      const toolWrapper = this.toolManager.state.toolWrappers[requestId];
      return toolWrapper.tool.state.state != "done";
    };

    for (const content of lastMessage.state.content) {
      if (content.type == "tool_use" && content.request.status == "ok") {
        if (isBlocking(content.request.value.id)) {
          return;
        }
      }
    }

    this.sendMessage().catch(this.handleSendMessageError.bind(this));
  }

  private handleSendMessageError = (error: Error): void => {
    if (this.state.conversation.state == "message-in-flight") {
      this.myDispatch({
        type: "conversation-state",
        conversation: {
          state: "error",
          error,
        },
      });
    }
  };

  async sendMessage(): Promise<void> {
    const messages = await this.getMessages();
    const request = getProvider(this.nvim, this.state.profile).sendMessage(
      messages,
      (event) => {
        this.myDispatch({
          type: "stream-event",
          event,
        });
      },
    );

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

  // async showDebugInfo() {
  //   const messages = await this.getMessages();
  //   const provider = getProvider(this.nvim, this.state.profile);
  //   const params = provider.createStreamParameters(messages);
  //   // const nTokens = await provider.countTokens(messages);
  //
  //   // Create a floating window
  //   const bufnr = await this.nvim.call("nvim_create_buf", [false, true]);
  //   await this.nvim.call("nvim_buf_set_option", [bufnr, "bufhidden", "wipe"]);
  //   const [editorWidth, editorHeight] = (await Promise.all([
  //     getOption("columns", this.nvim),
  //     getOption("lines", this.nvim),
  //   ])) as [number, number];
  //   const width = 80;
  //   const height = editorHeight - 20;
  //   await this.nvim.call("nvim_open_win", [
  //     bufnr,
  //     true,
  //     {
  //       relative: "editor",
  //       width,
  //       height,
  //       col: Math.floor((editorWidth - width) / 2),
  //       row: Math.floor((editorHeight - height) / 2),
  //       style: "minimal",
  //       border: "single",
  //     },
  //   ]);
  //
  //   const lines = JSON.stringify(params, null, 2).split("\n");
  //   // lines.push(`nTokens: ${nTokens}`);
  //   await this.nvim.call("nvim_buf_set_lines", [bufnr, 0, -1, false, lines]);
  //
  //   // Set buffer options
  //   await this.nvim.call("nvim_buf_set_option", [bufnr, "modifiable", false]);
  //   await this.nvim.call("nvim_buf_set_option", [bufnr, "filetype", "json"]);
  // }

  async getMessages(): Promise<ProviderMessage[]> {
    const messages = this.state.messages.flatMap((msg) => {
      let messageContent: ProviderMessageContent[] = [];
      const out: ProviderMessage[] = [];

      function commitMessages() {
        if (messageContent.length) {
          out.push({
            role: msg.state.role,
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

      for (const contentBlock of msg.state.content) {
        messageContent.push(contentBlock);

        if (contentBlock.type == "tool_use") {
          if (contentBlock.request.status == "ok") {
            const request = contentBlock.request.value;
            const tool = this.toolManager.state.toolWrappers[request.id].tool;
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
        messageId: msg.state.id,
      }));
    });

    const contextMessages = await this.contextManager.getContextMessages(
      this.counter.last() as MessageId,
    );

    if (contextMessages) {
      this.nvim.logger?.debug(
        `Got context messages: ${JSON.stringify(contextMessages)}`,
      );

      for (const contextMessage of contextMessages) {
        // we want to insert the contextMessage before the corresponding user message
        let idx = messages.findIndex(
          (m) => m.messageId >= contextMessage.messageId,
        );
        if (idx == -1) {
          idx = messages.length;
        }
        messages.splice(idx, 0, contextMessage);
      }
    }

    return messages.map((m) => m.message);
  }
}

export const view: View<{
  thread: Thread;
  dispatch: Dispatch<Msg>;
}> = ({ thread }) => {
  if (
    thread.state.messages.length == 0 &&
    thread.state.conversation.state == "stopped"
  ) {
    return d`${LOGO}\n${thread.contextManager.view()}`;
  }

  return d`${thread.state.messages.map((m) => d`${m.view()}\n`)}${
    thread.state.conversation.state == "message-in-flight"
      ? d`Awaiting response ${
          MESSAGE_ANIMATION[
            Math.floor(
              (new Date().getTime() -
                thread.state.conversation.sendDate.getTime()) /
                333,
            ) % MESSAGE_ANIMATION.length
          ]
        }`
      : thread.state.conversation.state == "stopped"
        ? ""
        : d`Error ${thread.state.conversation.error.message}${thread.state.conversation.error.stack ? "\n" + thread.state.conversation.error.stack : ""}${
            thread.state.conversation.lastAssistantMessage
              ? "\n\nLast assistant message:\n" +
                thread.state.conversation.lastAssistantMessage.toString()
              : ""
          }`
  }${
    thread.state.conversation.state != "message-in-flight" &&
    !thread.contextManager.isContextEmpty()
      ? d`\n${thread.contextManager.view()}`
      : ""
  }`;
};

export const LOGO = `\

   ________
  ╱        ╲
 ╱         ╱
╱         ╱
╲__╱__╱__╱

# magenta.nvim`;

const MESSAGE_ANIMATION = ["⠁", "⠂", "⠄", "⠂"];
