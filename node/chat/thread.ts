import * as Part from "./part.ts";
import {
  Message,
  view as messageView,
  update as messageUpdate,
  type MessageId,
  type Msg as MessageMsg,
} from "./message.ts";
import * as ContextManager from "../context/context-manager.ts";
import {
  type Dispatch,
  parallelThunks,
  type Thunk,
  wrapThunk,
} from "../tea/tea.ts";
import { d, withBindings, type View } from "../tea/view.ts";
import * as ToolManager from "../tools/toolManager.ts";
import { type Result } from "../utils/result.ts";
import { Counter } from "../utils/uniqueId.ts";
import type { Nvim } from "nvim-node";
import type { Lsp } from "../lsp.ts";
import {
  getProvider as getProvider,
  type ProviderMessage,
  type ProviderMessageContent,
  type StopReason,
  type Usage,
} from "../providers/provider.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { getOption } from "../nvim/nvim.ts";
import { type MagentaOptions, type Profile } from "../options.ts";

export type Role = "user" | "assistant";

export type ConversationState =
  | {
      state: "message-in-flight";
      sendDate: Date;
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

type WrappedMessageMsg = {
  type: "message-msg";
  msg: MessageMsg;
  idx: number;
};

export type Msg =
  | WrappedMessageMsg
  | { type: "update-profile"; profile: Profile }
  | {
      type: "context-manager-msg";
      msg: ContextManager.Msg;
    }
  | {
      type: "add-file-context";
      absFilePath: string;
      relFilePath: string;
    }
  | {
      type: "add-message";
      role: Role;
      content?: string;
    }
  | {
      type: "stream-response";
      text: string;
    }
  | {
      type: "init-tool-use";
      request: Result<ToolManager.ToolRequest, { rawRequest: unknown }>;
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
      type: "tool-manager-msg";
      msg: ToolManager.Msg;
    }
  | {
      type: "show-message-debug-info";
    }
  | {
      type: "sidebar-setup-resubmit";
      lastUserMessage: string;
    };

export class Thread {
  public state: {
    lastUserMessageId: MessageId;
    profile: Profile;
    conversation: ConversationState;
    messages: Message[];
    toolManager: ToolManager.Model;
  };
  public contextManager: ContextManager.ContextManager;
  private counter: Counter;
  private partModel: ReturnType<typeof Part.init>;
  private toolManagerModel: ReturnType<typeof ToolManager.init>;
  private nvim: Nvim;
  private lsp: Lsp;
  private options: MagentaOptions;

  public static async create({
    profile,
    nvim,
    lsp,
    options,
  }: {
    profile: Profile;
    nvim: Nvim;
    lsp: Lsp;
    options: MagentaOptions;
  }): Promise<Thread> {
    const contextManager = await ContextManager.ContextManager.create({
      nvim,
      options,
    });
    return new Thread({
      profile,
      nvim,
      contextManager,
      lsp,
      options,
    });
  }

  private constructor({
    profile,
    nvim,
    contextManager,
    lsp,
    options,
  }: {
    profile: Profile;
    nvim: Nvim;
    lsp: Lsp;
    contextManager: ContextManager.ContextManager;
    options: MagentaOptions;
  }) {
    this.nvim = nvim;
    this.lsp = lsp;
    this.counter = new Counter();
    this.partModel = Part.init({ nvim, lsp, options });
    this.toolManagerModel = ToolManager.init({ nvim, lsp, options });
    this.contextManager = contextManager;
    this.options = options;

    this.state = {
      lastUserMessageId: this.counter.last() as MessageId,
      profile,
      conversation: {
        state: "stopped",
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      messages: [],
      toolManager: this.toolManagerModel.initModel(),
    };
  }

  wrapMessageThunk(
    messageIdx: number,
    thunk: Thunk<MessageMsg> | undefined,
  ): Thunk<WrappedMessageMsg> | undefined {
    if (!thunk) {
      return undefined;
    }
    return (dispatch: Dispatch<WrappedMessageMsg>) =>
      thunk((msg: MessageMsg) =>
        dispatch({ type: "message-msg", idx: messageIdx, msg }),
      );
  }

  update(msg: Msg): Thunk<Msg> | undefined {
    switch (msg.type) {
      case "update-profile":
        this.state.profile = msg.profile;
        break;
      case "add-message": {
        const message = new Message({
          state: {
            id: this.counter.get() as MessageId,
            role: msg.role,
            parts: [],
            edits: {},
          },
          nvim: this.nvim,
          lsp: this.lsp,
          toolManager: this.state.toolManager,
          options: this.options,
        });

        if (message.state.role == "user") {
          this.state.lastUserMessageId = message.state.id;
        }

        let messageThunk;
        if (msg.content) {
          const thunk = message.update({
            type: "append-text",
            text: msg.content,
          });
          messageThunk = thunk;
        }
        this.state.messages.push(message);

        return this.wrapMessageThunk(
          this.state.messages.length - 1,
          messageThunk,
        );
      }

      case "conversation-state": {
        this.state.conversation = msg.conversation;

        switch (msg.conversation.state) {
          case "stopped": {
            const lastMessage =
              this.state.messages[this.state.messages.length - 1];
            if (lastMessage?.state.role === "assistant") {
              lastMessage.state.parts.push({
                type: "stop-msg",
                stopReason: msg.conversation.stopReason,
                usage: msg.conversation.usage,
              });
            }
            return this.maybeAutorespond();
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
              const sidebarResubmitSetupThunk: Thunk<Msg> = (dispatch) =>
                new Promise((resolve) => {
                  dispatch({
                    type: "sidebar-setup-resubmit",
                    lastUserMessage: lastUserMessage.state.parts
                      .map((p) => (p.type == "text" ? p.text : ""))
                      .join(""),
                  });
                  resolve();
                });

              return sidebarResubmitSetupThunk;
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

      case "sidebar-setup-resubmit":
        // this action is really just there so the parent (magenta app) can observe it and manipulate the sidebar
        // accordingly
        break;

      case "send-message": {
        const lastMessage = this.state.messages[this.state.messages.length - 1];
        if (lastMessage && lastMessage.state.role == "user") {
          return this.sendMessage();
        } else {
          this.nvim.logger?.error(
            `Cannot send when the last message has role ${lastMessage && lastMessage.state.role}`,
          );
        }
        break;
      }

      case "message-msg": {
        const [nextMessage, messageThunk] = messageUpdate(
          msg.msg,
          this.state.messages[msg.idx].state,
          this.state.toolManager,
          { nvim: this.nvim, lsp: this.lsp, options: this.options },
        );
        this.state.messages[msg.idx] = new Message({
          state: nextMessage,
          nvim: this.nvim,
          lsp: this.lsp,
          toolManager: this.state.toolManager,
          options: this.options,
        });

        let toolManagerMsg;
        if (msg.msg.type == "tool-manager-msg") {
          toolManagerMsg = msg.msg.msg;
        }

        if (
          msg.msg.type == "part-msg" &&
          msg.msg.msg.type == "tool-manager-msg"
        ) {
          toolManagerMsg = msg.msg.msg.msg;
        }

        if (toolManagerMsg) {
          const [nextToolManager, toolManagerThunk] =
            this.toolManagerModel.update(
              toolManagerMsg,
              this.state.toolManager,
              { nvim: this.nvim, options: this.options },
            );
          this.state.toolManager = nextToolManager;

          const wrappedMessageThunk: Thunk<Msg> | undefined =
            this.wrapMessageThunk(msg.idx, messageThunk);

          const wrappedToolThunk = wrapThunk(
            "tool-manager-msg",
            toolManagerThunk,
          );

          return parallelThunks(wrappedMessageThunk, wrappedToolThunk);
        }

        if (msg.msg.type == "diff-error") {
          if (msg.msg.requestId) {
            const toolWrapper =
              this.state.toolManager.toolWrappers[msg.msg.requestId];
            if (toolWrapper) {
              toolWrapper.model.state = {
                state: "done",
                result: {
                  type: "tool_result",
                  id: msg.msg.requestId,
                  result: {
                    status: "error",
                    error: msg.msg.message,
                  },
                },
              };
            }
          } else {
            const message = this.state.messages[msg.idx];
            const edit = message.state.edits[msg.msg.filePath];
            edit.status = {
              status: "error",
              message: msg.msg.message,
            };
          }
          break;
        }

        return this.wrapMessageThunk(msg.idx, messageThunk);
      }

      case "stream-response": {
        const lastMessage = this.state.messages[this.state.messages.length - 1];
        if (lastMessage?.state.role !== "assistant") {
          this.state.messages.push(
            new Message({
              state: {
                id: this.counter.get() as MessageId,
                role: "assistant",
                parts: [],
                edits: {},
              },
              nvim: this.nvim,
              lsp: this.lsp,
              toolManager: this.state.toolManager,
              options: this.options,
            }),
          );
        }

        const [nextMessage, messageThunk] = messageUpdate(
          { type: "append-text", text: msg.text },
          this.state.messages[this.state.messages.length - 1].state,
          this.state.toolManager,
          { nvim: this.nvim, lsp: this.lsp, options: this.options },
        );
        this.state.messages[this.state.messages.length - 1] = new Message({
          state: nextMessage,
          nvim: this.nvim,
          lsp: this.lsp,
          toolManager: this.state.toolManager,
          options: this.options,
        });

        return this.wrapMessageThunk(
          this.state.messages.length - 1,
          messageThunk,
        );
      }

      case "init-tool-use": {
        const lastMessage = this.state.messages[this.state.messages.length - 1];
        if (lastMessage?.state.role !== "assistant") {
          this.state.messages.push(
            new Message({
              state: {
                id: this.counter.get() as MessageId,
                role: "assistant",
                parts: [],
                edits: {},
              },
              nvim: this.nvim,
              lsp: this.lsp,
              toolManager: this.state.toolManager,
              options: this.options,
            }),
          );
        }

        if (msg.request.status == "error") {
          const [nextMessage, messageThunk] = messageUpdate(
            {
              type: "add-malformed-tool-reqeust",
              error: msg.request.error,
              rawRequest: msg.request.rawRequest,
            },
            this.state.messages[this.state.messages.length - 1].state,
            this.state.toolManager,
            { nvim: this.nvim, lsp: this.lsp, options: this.options },
          );
          this.state.messages[this.state.messages.length - 1] = new Message({
            state: nextMessage,
            nvim: this.nvim,
            lsp: this.lsp,
            toolManager: this.state.toolManager,
            options: this.options,
          });

          return this.wrapMessageThunk(
            this.state.messages.length - 1,
            messageThunk,
          );
        } else {
          const [nextToolManager, toolManagerThunk] =
            this.toolManagerModel.update(
              { type: "init-tool-use", request: msg.request.value },
              this.state.toolManager,
              { nvim: this.nvim, options: this.options },
            );
          this.state.toolManager = nextToolManager;

          const [nextMessage, messageThunk] = messageUpdate(
            {
              type: "add-tool-request",
              requestId: msg.request.value.id,
            },
            this.state.messages[this.state.messages.length - 1].state,
            this.state.toolManager,
            { nvim: this.nvim, lsp: this.lsp, options: this.options },
          );
          this.state.messages[this.state.messages.length - 1] = new Message({
            state: nextMessage,
            nvim: this.nvim,
            lsp: this.lsp,
            toolManager: this.state.toolManager,
            options: this.options,
          });

          const wrappedMessageThunk: Thunk<Msg> | undefined =
            this.wrapMessageThunk(this.state.messages.length - 1, messageThunk);

          const wrappedToolThunk = wrapThunk(
            "tool-manager-msg",
            toolManagerThunk,
          );
          return parallelThunks(wrappedMessageThunk, wrappedToolThunk);
        }
      }

      case "tool-manager-msg": {
        const [nextToolManager, toolManagerThunk] =
          this.toolManagerModel.update(msg.msg, this.state.toolManager, {
            nvim: this.nvim,
            options: this.options,
          });
        this.state.toolManager = nextToolManager;

        const wrappedToolThunk = toolManagerThunk
          ? wrapThunk("tool-manager-msg", toolManagerThunk)
          : undefined;

        const respondThunk = this.maybeAutorespond();

        return parallelThunks(wrappedToolThunk, respondThunk);
      }

      case "context-manager-msg": {
        const contextManagerThunk = this.contextManager.update(msg.msg);
        return wrapThunk("context-manager-msg", contextManagerThunk);
      }

      case "add-file-context": {
        const contextManagerThunk = this.contextManager.update({
          type: "add-file-context",
          absFilePath: msg.absFilePath,
          relFilePath: msg.relFilePath,
          messageId: this.state.lastUserMessageId,
        });
        return wrapThunk("context-manager-msg", contextManagerThunk);
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
          toolManager: this.toolManagerModel.initModel(),
        };
        return undefined;
      }

      case "show-message-debug-info": {
        return async () => this.showDebugInfo();
      }

      default:
        assertUnreachable(msg);
    }
  }

  /** If the agent is waiting on tool use, check the last message to see if all tools have been resolved. If so,
   * automatically respond.
   */
  maybeAutorespond(): Thunk<Msg> | undefined {
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

    const isBlocking = (requestId: ToolManager.ToolRequestId) => {
      const toolWrapper = this.state.toolManager.toolWrappers[requestId];
      return toolWrapper.model.state.state != "done";
    };

    for (const part of lastMessage.state.parts) {
      if (part.type == "tool-request") {
        if (isBlocking(part.requestId)) {
          return;
        }
      }
    }

    // all edits will also appear in the parts, so we don't need to check those twice.

    return this.sendMessage();
  }

  sendMessage(): Thunk<Msg> {
    return async (dispatch: Dispatch<Msg>) => {
      const messages = await this.getMessages();

      dispatch({
        type: "conversation-state",
        conversation: {
          state: "message-in-flight",
          sendDate: new Date(),
        },
      });
      let res;
      try {
        res = await getProvider(this.nvim, this.state.profile).sendMessage(
          messages,
          (text) => {
            dispatch({
              type: "stream-response",
              text,
            });
          },
        );

        if (res.toolRequests?.length) {
          for (const request of res.toolRequests) {
            dispatch({
              type: "init-tool-use",
              request,
            });
          }
        }
        dispatch({
          type: "conversation-state",
          conversation: {
            state: "stopped",
            stopReason: res?.stopReason || "end_turn",
            usage: res?.usage || { inputTokens: 0, outputTokens: 0 },
          },
        });
      } catch (error) {
        dispatch({
          type: "conversation-state",
          conversation: {
            state: "error",
            error: error as Error,
          },
        });
      }
    };
  }

  async showDebugInfo() {
    const messages = await this.getMessages();
    const provider = getProvider(this.nvim, this.state.profile);
    const params = provider.createStreamParameters(messages);
    const nTokens = await provider.countTokens(messages);

    // Create a floating window
    const bufnr = await this.nvim.call("nvim_create_buf", [false, true]);
    await this.nvim.call("nvim_buf_set_option", [bufnr, "bufhidden", "wipe"]);
    const [editorWidth, editorHeight] = (await Promise.all([
      getOption("columns", this.nvim),
      getOption("lines", this.nvim),
    ])) as [number, number];
    const width = 80;
    const height = editorHeight - 20;
    await this.nvim.call("nvim_open_win", [
      bufnr,
      true,
      {
        relative: "editor",
        width,
        height,
        col: Math.floor((editorWidth - width) / 2),
        row: Math.floor((editorHeight - height) / 2),
        style: "minimal",
        border: "single",
      },
    ]);

    const lines = JSON.stringify(params, null, 2).split("\n");
    lines.push(`nTokens: ${nTokens}`);
    await this.nvim.call("nvim_buf_set_lines", [bufnr, 0, -1, false, lines]);

    // Set buffer options
    await this.nvim.call("nvim_buf_set_option", [bufnr, "modifiable", false]);
    await this.nvim.call("nvim_buf_set_option", [bufnr, "filetype", "json"]);
  }

  async getMessages(): Promise<ProviderMessage[]> {
    const messages = this.state.messages.flatMap((msg) => {
      let messageContent: ProviderMessageContent[] = [];
      const out: ProviderMessage[] = [];

      for (const part of msg.state.parts) {
        const { content, result } = this.partModel.toMessageParam(
          part,
          this.state.toolManager,
        );

        if (content) {
          messageContent.push(content);
        }

        if (result) {
          if (messageContent.length) {
            out.push({
              role: msg.state.role,
              content: messageContent,
            });
            messageContent = [];
          }

          out.push({
            role: "user",
            content: [result],
          });
        }
      }

      if (messageContent.length) {
        out.push({
          role: msg.state.role,
          content: messageContent,
        });
      }

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
  model: { thread: Thread };
  dispatch: Dispatch<Msg>;
}> = ({ model, dispatch }) => {
  const thread = model.thread;
  if (
    thread.state.messages.length == 0 &&
    Object.keys(thread.contextManager.files).length == 0 &&
    thread.state.conversation.state == "stopped"
  ) {
    return d`${LOGO}`;
  }

  return d`${thread.state.messages.map(
    (m, idx) =>
      d`${messageView({
        message: m,
        dispatch: (msg) => {
          dispatch({ type: "message-msg", msg, idx });
        },
      })}\n`,
  )}${
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
        ? withBindings(d`Stopped (${thread.state.conversation.stopReason})`, {
            "<CR>": () => dispatch({ type: "show-message-debug-info" }),
          })
        : d`Error ${thread.state.conversation.error.message}${thread.state.conversation.error.stack ? "\n" + thread.state.conversation.error.stack : ""}${
            thread.state.conversation.lastAssistantMessage
              ? "\n\nLast assistant message:\n" +
                JSON.stringify(
                  thread.state.conversation.lastAssistantMessage,
                  null,
                  2,
                )
              : ""
          }`
  }${
    thread.state.conversation.state != "message-in-flight" &&
    !thread.contextManager.isContextEmpty()
      ? d`\n${ContextManager.view({
          contextManager: thread.contextManager,
          dispatch: (msg) => dispatch({ type: "context-manager-msg", msg }),
        })}`
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
