import { AnthropicClient } from "./anthropic.js";
import { NvimPlugin } from "neovim";
import { Sidebar } from "./sidebar.js";
import {
  Model as ChatModel,
  Msg as ChatMsg,
  getMessages,
  view as chatView,
  update as chatUpdate,
} from "./chat/chat.js";
import { Logger } from "./logger.js";
import { Context } from "./types.js";
import { TOOLS } from "./tools/index.js";
import { assertUnreachable } from "./utils/assertUnreachable.js";
import { ToolProcess } from "./tools/types.js";
import { Moderator } from "./moderator.js";
import { App, createApp } from "./tea/tea.js";

class Magenta {
  private anthropicClient: AnthropicClient;
  private sidebar: Sidebar;
  private moderator: Moderator;
  private chat: App<ChatMsg, ChatModel>;

  constructor(private context: Context) {
    this.context.logger.debug(`Initializing plugin`);
    this.anthropicClient = new AnthropicClient(this.context.logger);
    this.sidebar = new Sidebar(this.context.nvim, this.context.logger);
    this.chat = createApp({
      initialModel: { messages: [] },
      update: chatUpdate,
      View: chatView,
    });
    this.moderator = new Moderator(
      this.context,
      // on tool result
      (request, response) => {
        this.chat.dispatch({
          type: "add-tool-response",
          request,
          response,
        });
      },
      // autorespond
      () => {
        this.sendMessage().catch((err) =>
          this.context.logger.error(err as Error),
        );
      },
    );
  }

  async command(args: string[]): Promise<void> {
    this.context.logger.debug(`Received command ${args[0]}`);
    switch (args[0]) {
      case "toggle": {
        const buffers = await this.sidebar.toggle();
        if (buffers) {
          await this.chat.mount({
            nvim: this.context.nvim,
            buffer: buffers.displayBuffer,
            startPos: { row: 0, col: 0 },
            endPos: { row: 0, col: 0 },
          });
        }
        break;
      }

      case "send": {
        const message = await this.sidebar.getMessage();
        this.context.logger.trace(`current message: ${message}`);
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
        this.context.logger.error(`Unrecognized command ${args[0]}\n`);
    }
  }

  private async sendMessage() {
    const state = this.chat.getState();
    if (state.status != "running") {
      this.context.logger.error(`chat is not running.`);
      return;
    }

    const messages = getMessages(state.model);

    const toolRequests = await this.anthropicClient.sendMessage(
      messages,
      (text) => {
        this.context.logger.trace(`stream received text ${text}`);
        this.chat.dispatch({
          type: "stream-response",
          text,
        });
      },
    );

    if (toolRequests.length) {
      for (const request of toolRequests) {
        let process: ToolProcess;
        switch (request.name) {
          case "get_file": {
            process = TOOLS[request.name].execRequest(request, this.context);
            break;
          }
          case "insert": {
            process = TOOLS[request.name].execRequest(request, this.context);
            break;
          }
          default:
            assertUnreachable(request);
        }

        this.moderator.registerProcess(process);
        this.chat.dispatch({
          type: "add-tool-use",
          request,
          process,
        });
      }
    }
  }
}

let init: { magenta: Magenta; logger: Logger } | undefined = undefined;

module.exports = (plugin: NvimPlugin) => {
  plugin.setOptions({});

  if (!init) {
    const logger = new Logger(plugin.nvim, { level: "trace" });
    process.on("uncaughtException", (error) => {
      logger.error(error);
      process.exit(1);
    });

    init = {
      magenta: new Magenta({ nvim: plugin.nvim, logger }),
      logger,
    };
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
};
