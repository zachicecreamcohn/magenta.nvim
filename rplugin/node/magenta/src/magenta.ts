import { AnthropicClient } from './anthropic';
import { NvimPlugin } from 'neovim';
import { Sidebar } from './sidebar';
import { Chat } from './chat';
import { Logger } from './logger'
import { Context } from './types';

class Magenta {
  private anthropicClient: AnthropicClient;
  private sidebar: Sidebar;

  constructor(private context: Context, plugin: NvimPlugin, private chat: Chat) {
    this.context.logger.debug(`Initializing plugin`)
    this.anthropicClient = new AnthropicClient(this.context.logger);
    this.sidebar = new Sidebar(this.context.nvim, this.context.logger);

    plugin.registerCommand('Magenta', (args: string[]) => this.command(args).catch((err: Error) => {
      this.context.logger.error(err)
    }), {
      nargs: '1'
    })
  }

  async command(args: string[]): Promise<void> {
    this.context.logger.debug(`Received command ${args[0]}`)
    switch (args[0]) {
      case 'toggle': {
        await this.sidebar.toggle(this.chat.displayBuffer);
        break;
      }

      case 'send':
        await this.sendMessage();
        break;

      case 'clear':
        this.chat.clear();
        break;

      default:
        this.context.logger.error(`Unrecognized command ${args[0]}\n`);
    }
  }

  private async sendMessage() {
    const message = await this.sidebar.getMessage();
    this.context.logger.trace(`current message: ${message}`)
    if (!message) return;

    await this.chat.addMessage('user', message);
    const currentMessage = await this.chat.addMessage('assistant', '');

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.anthropicClient.sendMessage(this.chat.getMessages(), async (text) => {
      this.context.logger.trace(`stream received text ${text}`)
      await currentMessage.append(text);
    });
  }

  static async init(plugin: NvimPlugin, logger: Logger) {
    const chat = await Chat.init({ nvim: plugin.nvim, logger })
    return new Magenta({ nvim: plugin.nvim, logger }, plugin, chat)
  }
}

let singletonPromise: Promise<Magenta> | undefined = undefined;

module.exports = (plugin: NvimPlugin) => {
  plugin.setOptions({
    // dev: true,
    // alwaysInit: true
  })

  if (!singletonPromise) {
    const logger = new Logger(plugin.nvim, { level: 'trace' });
    process.on('uncaughtException', (error) => {
      logger.error(error);
      process.exit(1);
    });

    singletonPromise = Magenta.init(plugin, logger)
  }
}
