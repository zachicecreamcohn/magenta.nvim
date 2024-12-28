import { Sidebar } from "./sidebar.ts";
import * as Chat from "./chat/chat.ts";
import * as TEA from "./tea/tea.ts";
import { context } from "./context.ts";
import { BINDING_KEYS, type BindingKey } from "./tea/bindings.ts";
import { pos } from "./tea/view.ts";
import type { Nvim } from "bunvim";

// import { delay } from "./utils/async.ts";
// these should match lua/magenta/init.lua
const MAGENTA_COMMAND = "magentaCommand";
const MAGENTA_ON_WINDOW_CLOSED = "magentaWindowClosed";
const MAGENTA_KEY = "magentaKey";
const MAGENTA_LSP_RESPONSE = "magentaLspResponse";

export class Magenta {
  public sidebar: Sidebar;
  public chatApp: TEA.App<Chat.Msg, Chat.Model>;
  public mountedChatApp: TEA.MountedApp | undefined;

  constructor() {
    this.sidebar = new Sidebar();

    this.chatApp = TEA.createApp({
      initialModel: Chat.initModel(),
      // sub: {
      //   subscriptions: (model) => {
      //     if (model.messageInFlight) {
      //       return [{ id: "ticker" } as const];
      //     }
      //     return [];
      //   },
      //   subscriptionManager: {
      //     ticker: {
      //       subscribe(dispatch) {
      //         let running = true;
      //         const tick = async () => {
      //           while (running) {
      //             dispatch({ type: "tick" });
      //             await delay(100);
      //           }
      //         };
      //
      //         // eslint-disable-next-line @typescript-eslint/no-floating-promises
      //         tick();
      //
      //         return () => {
      //           running = false;
      //         };
      //       },
      //     },
      //   },
      // },
      update: Chat.update,
      View: Chat.view,
    });
  }

  async command(command: string): Promise<void> {
    context.nvim.logger?.debug(`Received command ${command}`);
    switch (command) {
      case "toggle": {
        const buffers = await this.sidebar.toggle();
        if (buffers && !this.mountedChatApp) {
          this.mountedChatApp = await this.chatApp.mount({
            buffer: buffers.displayBuffer,
            startPos: pos(0, 0),
            endPos: pos(-1, -1),
          });
          context.nvim.logger?.debug(`Chat mounted.`);
        }
        break;
      }

      case "send": {
        const message = await this.sidebar.getMessage();
        context.nvim.logger?.debug(`current message: ${message}`);
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
        context.nvim.logger?.error(`Unrecognized command ${command}\n`);
    }
  }

  onKey(args: string[]) {
    const key = args[0];
    if (this.mountedChatApp) {
      if (BINDING_KEYS.indexOf(key as BindingKey) > -1) {
        this.mountedChatApp.onKey(key as BindingKey);
      } else {
        context.nvim.logger?.error(
          `Unexpected MagentaKey ${JSON.stringify(key)}`,
        );
      }
    }
  }

  async onWinClosed() {
    await this.sidebar.onWinClosed();
  }

  static async start(nvim: Nvim) {
    const magenta = new Magenta();
    nvim.onNotification(MAGENTA_COMMAND, async (args: unknown[]) => {
      try {
        await magenta.command(args[0] as string);
      } catch (err) {
        nvim.logger?.error(err as Error);
      }
    });

    nvim.onNotification(MAGENTA_ON_WINDOW_CLOSED, async () => {
      try {
        await magenta.onWinClosed();
      } catch (err) {
        nvim.logger?.error(err as Error);
      }
    });

    nvim.onNotification(MAGENTA_KEY, (args) => {
      try {
        magenta.onKey(args as string[]);
      } catch (err) {
        nvim.logger?.error(err as Error);
      }
    });

    nvim.onNotification(MAGENTA_LSP_RESPONSE, (args) => {
      try {
        context.lsp.onLspResponse(args[0]);
      } catch (err) {
        nvim.logger?.error(err as Error);
      }
    });

    await nvim.call("nvim_exec_lua", [
      `\
require('magenta').bridge(${nvim.channelId})
`,
      [],
    ]);
    nvim.logger?.info(`Magenta initialized.`);
    return magenta;
  }
}
