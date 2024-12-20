import { NvimPlugin } from "neovim";
import { Sidebar } from "./sidebar.ts";
import * as Chat from "./chat/chat.ts";
import { Logger } from "./logger.ts";
import { App, createApp, MountedApp } from "./tea/tea.ts";
import { setContext, context } from "./context.ts";
import { BindingKey } from "./tea/bindings.ts";
import { pos } from "./tea/view.ts";

class Magenta {
  private sidebar: Sidebar;
  private chatApp: App<Chat.Msg, Chat.Model>;
  private mountedChatApp: MountedApp | undefined;

  constructor() {
    context.logger.debug(`Initializing plugin`);
    this.sidebar = new Sidebar();

    this.chatApp = createApp({
      initialModel: Chat.initModel(),
      update: Chat.update,
      View: Chat.view,
    });
  }

  async command(args: string[]): Promise<void> {
    context.logger.debug(`Received command ${args[0]}`);
    switch (args[0]) {
      case "toggle": {
        const buffers = await this.sidebar.toggle();
        if (buffers && !this.mountedChatApp) {
          this.mountedChatApp = await this.chatApp.mount({
            buffer: buffers.displayBuffer,
            startPos: pos(0, 0),
            endPos: pos(-1, -1),
          });
          context.logger.trace(`Chat mounted.`);
        }
        break;
      }

      case "send": {
        const message = await this.sidebar.getMessage();
        context.logger.trace(`current message: ${message}`);
        if (!message) return;

        this.chatApp.dispatch({
          type: "add-message",
          role: "user",
          content: message,
        });

        this.chatApp.dispatch({
          type: "send-message",
        });

        if (this.mountedChatApp) {
          await this.mountedChatApp.waitForRender();
        }
        await this.sidebar.scrollToLastUserMessage();

        break;
      }

      case "clear":
        this.chatApp.dispatch({ type: "clear" });
        break;

      default:
        context.logger.error(`Unrecognized command ${args[0]}\n`);
    }
  }

  onKey(key: BindingKey) {
    if (this.mountedChatApp) {
      this.mountedChatApp.onKey(key);
    }
  }

  async onWinClosed() {
    await this.sidebar.onWinClosed();
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

  plugin.registerAutocmd(
    "WinClosed",
    () => {
      init!.magenta
        .onWinClosed()
        .catch((err: Error) => context.logger.error(err));
    },
    {
      pattern: "*",
    },
  );

  context.plugin.registerFunction("MagentaOnEnter", () => {
    init?.magenta.onKey("Enter");
  });
};
