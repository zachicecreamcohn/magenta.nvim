import { Neovim, NvimPlugin, Buffer, Window } from "neovim";

export class Sidebar {
  private state: {
    state: 'not-loaded'
  } | {
    state: 'loaded';
    visible: boolean;
    mainBuffer: Buffer;
    inputBuffer: Buffer;
    mainWindow: Window;
    inputWindow: Window;
  }

  constructor(private nvim: Neovim ) {
    this.state = { state: 'not-loaded' }
  }

  async toggle(): Promise<Buffer> {
    if (this.state.state == 'not-loaded') {
      const inputBuffer = await this.create();
      return inputBuffer
    } else {
      if (this.state.visible) {
        await this.hide();
      } else {
        await this.show();
      }

      return this.state.inputBuffer;
    }
  }

  private async create(): Promise<Buffer> {
    const totalWidth = await this.nvim.getOption('columns') as number;
    const totalHeight = await this.nvim.getOption('lines') as number;
    const width = 30;
    const mainHeight = Math.floor(totalHeight * 0.8);
    const inputHeight = totalHeight - mainHeight - 2;

    this.nvim.command('vsplit');
    this.nvim.command(`wincmd L`);
    this.nvim.command(`vertical resize ${width}`);

    const mainWindow = await this.nvim.getWindow();
    const mainBuffer = await this.nvim.createBuffer(false, true) as Buffer;


    mainWindow.id
    this.nvim.lua(`vim.api.nvim_win_set_buf(${mainWindow.id}, ${mainBuffer.id})`);
    mainBuffer.setOption('buftype', 'nofile');
    mainBuffer.setOption('swapfile', false);
    mainBuffer.setOption('modifiable', true);
    mainBuffer.setLines([
      'Magenta Sidebar',
      '============',
      ''
    ], {
      start: 0,
      end: -1,
      strictIndexing: false
    })
    mainBuffer.setOption('modifiable', false);

    this.nvim.command('split');
    this.nvim.command(`resize ${inputHeight}`);
    this.nvim.command('wincmd J');

    const inputWindow = await this.nvim.getWindow();
    const inputBuffer = await this.nvim.createBuffer(false, true) as Buffer;

    this.nvim.lua(`vim.api.nvim_win_set_buf(${inputWindow.id}, ${inputBuffer.id})`);
    inputBuffer.setOption('buftype', 'nofile');
    inputBuffer.setOption('swapfile', false);
    inputBuffer.setLines(['Enter text here...'], {
      start: 0,
      end: -1,
      strictIndexing: false
    });

    const winOptions = {
      wrap: true,
      number: false,
      relativenumber: false,
      cursorline: true,
    };

    Object.entries(winOptions).forEach(([key, value]) => {
      mainWindow.setOption(key, value);
      inputWindow.setOption(key, value);
    });

    vim.api.nvim_buf_set_keymap(
      this.inputBuffer,
      'n',
      '<CR>',
      ':MagentaSend<CR>',
      { silent: true, noremap: true }
    );

    this.visible = true;
    return { bufnr: this.inputBuffer };
  }

  async hide() {
    if (!this.visible) {
      log.debug('Sidebar not visible');
      return;
    }

    if (this.mainWindow) {
      vim.api.nvim_win_close(this.mainWindow, true);
      this.mainWindow = null;
    }

    if (this.inputWindow) {
      vim.api.nvim_win_close(this.inputWindow, true);
      this.inputWindow = null;
    }

    if (this.mainBuffer) {
      vim.api.nvim_buf_delete(this.mainBuffer, { force: true });
      this.mainBuffer = null;
    }

    if (this.inputBuffer) {
      vim.api.nvim_buf_delete(this.inputBuffer, { force: true });
      this.inputBuffer = null;
    }

    this.visible = false;
  }

  async appendToMain(opts: { text: string; scrollTop?: boolean }) {
    if (!this.mainBuffer) {
      log.error('Cannot append to main area - not initialized');
      return;
    }

    const lines = opts.text.split('\n');
    if (lines.length === 0) return;

    const topLine = vim.api.nvim_buf_line_count(this.mainBuffer);
    const lastLine = (vim.api.nvim_buf_get_lines(this.mainBuffer, -2, -1, false)[0] || '');

    vim.api.nvim_buf_set_option(this.mainBuffer, 'modifiable', true);

    // Append first line to the last line of buffer
    vim.api.nvim_buf_set_lines(this.mainBuffer, -2, -1, false, [lastLine + lines[0]]);

    // Add remaining lines
    if (lines.length > 1) {
      vim.api.nvim_buf_set_lines(this.mainBuffer, -1, -1, false, lines.slice(1));
    }

    vim.api.nvim_buf_set_option(this.mainBuffer, 'modifiable', false);

    if (opts.scrollTop) {
      const offset = lines.length > 1 ? 1 : 0;
      if (this.mainWindow) {
        vim.api.nvim_win_set_cursor(this.mainWindow, [topLine + offset, 0]);
      }
    } else {
      const finalLine = vim.api.nvim_buf_line_count(this.mainBuffer);
      if (this.mainWindow) {
        vim.api.nvim_win_set_cursor(this.mainWindow, [finalLine, 0]);
      }
    }
  }

  async getMessage(): Promise<string> {
    if (!this.inputBuffer) {
      return '';
    }

    const lines = vim.api.nvim_buf_get_lines(this.inputBuffer, 0, -1, false);
    const message = lines.join('\n');

    log.debug('Message content:', message);

    // Clear input area
    vim.api.nvim_buf_set_lines(this.inputBuffer, 0, -1, false, ['']);

    return message;
  }
}
