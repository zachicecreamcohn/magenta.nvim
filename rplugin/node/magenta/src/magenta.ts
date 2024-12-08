import { AnthropicClient } from "./anthropic";
import { NvimPlugin } from "neovim";
import { Sidebar } from "./sidebar";
import { Chat } from "./chat";
import { Logger } from "./logger";
import { Context } from "./types";
import { TOOLS } from "./tools";

class Magenta {
  private anthropicClient: AnthropicClient;
  private sidebar: Sidebar;

  constructor(
    private context: Context,
    private chat: Chat,
  ) {
    this.context.logger.debug(`Initializing plugin`);
    this.anthropicClient = new AnthropicClient(this.context.logger);
    this.sidebar = new Sidebar(this.context.nvim, this.context.logger);
  }

  async command(args: string[]): Promise<void> {
    this.context.logger.debug(`Received command ${args[0]}`);
    switch (args[0]) {
      case "toggle": {
        await this.sidebar.toggle(this.chat.displayBuffer);
        break;
      }

      case "send":
        await this.sendMessage();
        break;

      case "clear":
        this.chat.clear();
        break;

      default:
        this.context.logger.error(`Unrecognized command ${args[0]}\n`);
    }
  }

  private async sendMessage() {
    const message = await this.sidebar.getMessage();
    this.context.logger.trace(`current message: ${message}`);
    if (!message) return;

    await this.chat.addMessage("user", message);
    const currentMessage = await this.chat.addMessage("assistant", "");

    const toolRequests = await this.anthropicClient.sendMessage(
      this.chat.getMessages(),
      async (text) => {
        this.context.logger.trace(`stream received text ${text}`);
        await currentMessage.appendText(text);
      },
    );

    if (toolRequests.length) {
      for (const request of toolRequests) {
        await currentMessage.addToolUse(request);
      }

      await Promise.all(
        toolRequests.map(async (req) => {
          const response = await TOOLS.get_file.execRequest(req, this.context);
          await this.chat.updateToolUse(req, response);
        }),
      );
    }
  }

  static async init(plugin: NvimPlugin, logger: Logger) {
    const chat = await Chat.init({ nvim: plugin.nvim, logger });
    return new Magenta({ nvim: plugin.nvim, logger }, chat);
  }
}

let init: { magenta: Promise<Magenta>; logger: Logger } | undefined = undefined;

module.exports = (plugin: NvimPlugin) => {
  plugin.setOptions({
    // dev: true,
    // alwaysInit: true
  });

  if (!init) {
    const logger = new Logger(plugin.nvim, { level: "trace" });
    process.on("uncaughtException", (error) => {
      logger.error(error);
      process.exit(1);
    });

    init = {
      magenta: Magenta.init(plugin, logger),
      logger,
    };
  }

  plugin.registerCommand(
    "Magenta",
    async (args: string[]) => {
      try {
        const magenta = await init!.magenta;
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
