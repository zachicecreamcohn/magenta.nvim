import { AnthropicClient } from './anthropic';
import { Neovim, NvimPlugin } from 'neovim';
import { Sidebar } from './sidebar';
import { Chat } from './chat';
import { Logger } from './logger'

class Magenta {
  private anthropicClient: AnthropicClient;
  private sidebar: Sidebar;
  private chat: Chat;
  private logger: Logger;

  constructor(private nvim: Neovim, plugin: NvimPlugin) {
    this.logger = new Logger(this.nvim, { level: 'trace' });
    this.logger.debug(`Initializing plugin`)
    this.anthropicClient = new AnthropicClient(this.logger);
    this.sidebar = new Sidebar(this.nvim, this.logger);
    this.chat = new Chat();

    plugin.registerCommand('Magenta', (args: string[]) => this.command(args), {
      nargs: '1'
    })
  }

  async command(args: string[]): Promise<void> {
    this.logger.debug(`Received command ${args[0]}`)
    switch (args[0]) {
      case 'toggle': {
        const inputBuffer = await this.sidebar.toggle();
        await this.nvim.lua(`vim.keymap.set('n', '<leader>x', ':Magenta send<CR>', { buffer = ${inputBuffer.id} })`);
        break;
      }

      case 'send':
        await this.sendMessage();
        break;

      case 'clear':
        this.chat.clear();
        break;

      default:
        this.logger.error(`Unrecognized command ${args[0]}\n`);
    }
  }

  private async sendMessage() {
    const message = await this.sidebar.getMessage();
    this.logger.trace(`current message: ${message}`)
    if (!message) return;

    this.chat.addMessage('user', message);
    const currentMessage = this.chat.addMessage('assistant', '');
    await this.sidebar.appendToDisplayBuffer({
      text: `\nUser: ${message}\n\nAssistant: `,
      scrollTop: false
    });

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.anthropicClient.sendMessage(this.chat.getMessages(), async (text) => {
      this.logger.trace(`stream received text ${text}`)
      currentMessage.append(text);
      await this.sidebar.appendToDisplayBuffer({
        text,
        scrollTop: false
      });
    });
  }
}

let singleton: Magenta | undefined = undefined;

module.exports = (plugin: NvimPlugin) => {
  plugin.setOptions({
    // dev: true,
    // alwaysInit: true
  })
  if (!singleton) {
    singleton = new Magenta(plugin.nvim, plugin)
  }
}
