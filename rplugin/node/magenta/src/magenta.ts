import { AnthropicClient } from "./anthropic.ts";
import { NvimPlugin } from "neovim";
import { Sidebar } from "./sidebar.ts";
import * as Chat from "./chat/chat.ts";
import { Logger } from "./logger.ts";
import { App, createApp } from "./tea/tea.ts";
import * as ToolManager from "./tools/toolManager.ts";
import { d } from "./tea/view.ts";
import { setContext, context } from "./context.ts";
import { BindingKey } from "./tea/mappings.ts";

class Magenta {
  private anthropicClient: AnthropicClient;
  private sidebar: Sidebar;
  private chat: App<Chat.Msg, Chat.Model>;
  private chatRoot: { onKey(key: BindingKey): void } | undefined;
  private toolManager: App<ToolManager.Msg, ToolManager.Model>;

  constructor() {
    context.logger.debug(`Initializing plugin`);
    this.anthropicClient = new AnthropicClient();
    this.sidebar = new Sidebar();

    this.chat = createApp({
      initialModel: { messages: [] },
      update: Chat.update,
      View: Chat.view,
    });

    this.toolManager = createApp({
      initialModel: ToolManager.initModel(),
      update: ToolManager.update,
      View: () => d``,
      onUpdate: (msg, model) => {
        if (msg.type == "tool-msg") {
          const toolModel = model.toolModels[msg.id];

          // sync toolModel state w/ all the messages where it appears
          this.chat.dispatch({
            type: "tool-model-update",
            toolModel,
          });

          if (msg.msg.msg.type == "finish") {
            const toolModel = model.toolModels[msg.id];
            const response = msg.msg.msg.result;
            this.chat.dispatch({
              type: "add-tool-response",
              toolModel,
              response,
            });

            if (toolModel.autoRespond) {
              let shouldRespond = true;
              for (const tool of Object.values(model.toolModels)) {
                if (tool.state.state != "done") {
                  shouldRespond = false;
                  break;
                }
              }

              if (shouldRespond) {
                this.sendMessage().catch((err) =>
                  context.logger.error(err as Error),
                );
              }
            }
          }
        }
      },
    });
  }

  async command(args: string[]): Promise<void> {
    context.logger.debug(`Received command ${args[0]}`);
    switch (args[0]) {
      case "toggle": {
        const buffers = await this.sidebar.toggle();
        if (buffers) {
          this.chatRoot = await this.chat.mount({
            buffer: buffers.displayBuffer,
            startPos: { row: 0, col: 0 },
            endPos: { row: 0, col: 0 },
          });
          context.logger.trace(`Chat rendered.`);
        } else {
          // TODO: maybe set this.chatRoot to undefined?
        }

        break;
      }

      case "send": {
        const message = await this.sidebar.getMessage();
        context.logger.trace(`current message: ${message}`);
        if (!message) return;

        this.chat.dispatch({
          type: "add-message",
          role: "user",
          content: message,
        });

        await this.sendMessage();
        break;
      }

      case "clear":
        this.chat.dispatch({ type: "clear" });
        break;

      default:
        context.logger.error(`Unrecognized command ${args[0]}\n`);
    }
  }

  private async sendMessage() {
    const state = this.chat.getState();
    if (state.status != "running") {
      context.logger.error(`chat is not running.`);
      return;
    }

    const messages = Chat.getMessages(state.model);

    const toolRequests = await this.anthropicClient.sendMessage(
      messages,
      (text) => {
        context.logger.trace(`stream received text ${text}`);
        this.chat.dispatch({
          type: "stream-response",
          text,
        });
      },
    );

    if (toolRequests.length) {
      for (const request of toolRequests) {
        this.toolManager.dispatch({
          type: "init-tool-use",
          request,
        });
        const toolManagerModel = this.toolManager.getState();
        if (toolManagerModel.status == "running") {
          this.chat.dispatch({
            type: "add-tool-use",
            toolModel: toolManagerModel.model.toolModels[request.id],
          });
        }
      }
    }
  }

  onKey(key: BindingKey) {
    if (this.chatRoot) {
      this.chatRoot.onKey(key);
    }
  }
}

let init: { magenta: Magenta; logger: Logger } | undefined = undefined;

module.exports = (plugin: NvimPlugin) => {
  plugin.setOptions({});

  if (!init) {
    const logger = new Logger(plugin.nvim, { level: "trace" });
    setContext({
      plugin,
      nvim: plugin.nvim,
      logger,
    });

    process.on("uncaughtException", (error) => {
      logger.error(error);
      process.exit(1);
    });

    init = {
      magenta: new Magenta(),
      logger,
    };

    logger.log(`Magenta initialized.`);
  }

  plugin.registerCommand(
    "Magenta",
    async (args: string[]) => {
      try {
        const magenta = init!.magenta;
        await magenta.command(args);
      } catch (err) {
        init!.logger.error(err as Error);
      }
    },
    {
      nargs: "1",
    },
  );

  context.plugin.registerFunction("MagentaOnEnter", () => {
    init?.magenta.onKey("Enter");
  });
};
