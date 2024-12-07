import { AnthropicClient } from './anthropic';
import { Neovim, NvimPlugin } from 'neovim';
import { Sidebar } from './sidebar';
import { Chat } from './chat';

class Magenta {
  private anthropicClient: AnthropicClient;
  private sidebar: Sidebar;
  private chat: Chat;

  constructor(private nvim: Neovim, plugin: NvimPlugin) {
    console.error('Hello from magenta')
    this.anthropicClient = new AnthropicClient();
    this.sidebar = new Sidebar(this.nvim);
    this.chat = new Chat(this.nvim);

    plugin.registerCommand('Magenta', (args: string[]) => this.command(args), {
      nargs: '1'
    })
  }

  async command(args: string[]): Promise<void> {
    switch (args[0]) {
      case 'toggle':
        const inputBuffer = await this.sidebar.toggle();
        this.nvim.lua(`vim.keymap.set('n', '<leader>x', ':Magenta send<CR>', { buffer = ${inputBuffer.id} })`);
        break;

      case 'send':
        await this.sendMessage();
        break;

      case 'clear':
        this.chat.clear();
        break;

      default:
        await this.nvim.outWrite(`Unrecognized command ${args[0]}\n`);
    }
  }

  private async sendMessage() {
    const message = await this.sidebar.getMessage();
    if (!message) return;

    // Add user message to chat and display
    this.chat.addMessage('user', message);
    await this.sidebar.appendToMain({
      text: `\nUser: ${message}\n\nAssistant: `,
      scrollTop: false
    });

    // Stream the assistant's response
    this.anthropicClient.sendMessage(this.chat.getMessages(), (text) => {
      this.chat.appendToCurrentMessage(text);
      this.sidebar.appendToMain({
        text,
        scrollTop: false
      });
    });
  }
}

module.exports = (plugin: NvimPlugin) => {
  console.log('registering plugin')
  new Magenta(plugin.nvim, plugin)
}
