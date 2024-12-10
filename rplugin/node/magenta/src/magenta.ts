import { AnthropicClient } from "./anthropic";
import { NvimPlugin } from "neovim";
import { Sidebar } from "./sidebar";
import { Chat } from "./chat";
import { Logger } from "./logger";
import { Context } from "./types";
import { TOOLS } from "./tools/index";
import { assertUnreachable } from "./utils/assertUnreachable";
import { ToolProcess } from "./tools/types";
import { Moderator } from "./moderator";

class Magenta {
  private anthropicClient: AnthropicClient;
  private sidebar: Sidebar;
  private moderator: Moderator;

  constructor(
    private context: Context,
    private chat: Chat,
  ) {
    this.context.logger.debug(`Initializing plugin`);
    this.anthropicClient = new AnthropicClient(this.context.logger);
    this.sidebar = new Sidebar(this.context.nvim, this.context.logger);
    this.moderator = new Moderator(
      this.context,
      // on tool result
      (req, res) => {
        this.chat
          .addToolResponse(req, res)
          .catch((err) => this.context.logger.error(err as Error));
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
        await this.sidebar.toggle(this.chat.displayBuffer);
        break;
      }

      case "send": {
        const message = await this.sidebar.getMessage();
        this.context.logger.trace(`current message: ${message}`);
        if (!message) return;

        await this.chat.addMessage("user", message);

        await this.sendMessage();
        break;
      }

      case "clear":
        this.chat.clear();
        break;

      default:
        this.context.logger.error(`Unrecognized command ${args[0]}\n`);
    }
  }

  private async sendMessage() {
    const messages = this.chat.getMessages();

    const currentMessage = await this.chat.addMessage("assistant", "");
    const toolRequests = await this.anthropicClient.sendMessage(
      messages,
      async (text) => {
        this.context.logger.trace(`stream received text ${text}`);
        await currentMessage.appendText(text);
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
        await currentMessage.addToolUse(request, process);
      }
    }
  }

  static async init(plugin: NvimPlugin, logger: Logger) {
    const chat = await Chat.init({ nvim: plugin.nvim, logger });
    return new Magenta({ nvim: plugin.nvim, logger }, chat);
  }
}

let init: { magenta: Promise<Magenta>; logger: Logger } | undefined = undefined;

module.exports = (plugin: NvimPlugin) => {
  plugin.setOptions({});

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
