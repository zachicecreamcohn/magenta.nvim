import { Neovim, Buffer, Window } from "neovim";
import { Logger } from "./logger";

export class Sidebar {
  private state: {
    state: 'not-loaded'
  } | {
    state: 'loaded';
    visible: boolean;
    displayBuffer: Buffer;
    inputBuffer: Buffer;
    displayWindow: Window;
    inputWindow: Window;
  }

  constructor(private nvim: Neovim, private logger: Logger) {
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
    const { nvim, logger } = this;
    logger.trace(`sidebar.create`)
    const totalHeight = await nvim.getOption('lines') as number;
    const cmdHeight = await nvim.getOption('cmdheight') as number;
    const width = 80;
    const displayHeight = Math.floor((totalHeight - cmdHeight) * 0.8);
    const inputHeight = totalHeight - displayHeight - 2;

    const displayBuffer = await nvim.createBuffer(false, true) as Buffer;
    const displayWindow = await nvim.openWindow(displayBuffer, true, {
      relative: "editor",
      width,
      height: displayHeight,
      col: 0,
      row: 1,
      border: 'single'
    }) as Window;

    await displayBuffer.setOption('buftype', 'nofile');
    await displayBuffer.setOption('swapfile', false);
    await displayBuffer.setOption('modifiable', true);
    await displayBuffer.setLines([
      'Magenta Sidebar',
      '============',
      ''
    ], {
      start: 0,
      end: -1,
      strictIndexing: false
    })
    await displayBuffer.setOption('modifiable', false);

    const inputBuffer = await this.nvim.createBuffer(false, true) as Buffer;
    const inputWindow = await nvim.openWindow(inputBuffer, true, {
      relative: "editor",
      width,
      height: inputHeight,
      col: 0,
      row: displayHeight + 1,
      border: 'single'
    }) as Window;

    await inputBuffer.setOption('buftype', 'nofile');
    await inputBuffer.setOption('swapfile', false);
    await inputBuffer.setLines(['> '], {
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

    for (const [key, value] of Object.entries(winOptions)) {
      await displayWindow.setOption(key, value);
      await inputWindow.setOption(key, value);
    }

    await inputBuffer.request('nvim_buf_set_keymap', [inputBuffer,
      'n',
      '<CR>',
      ':Magenta send<CR>',
      { silent: true, noremap: true }
    ]);

    logger.trace(`sidebar.create setting state`)
    this.state = {
      state: 'loaded',
      visible: true,
      displayBuffer,
      inputBuffer,
      displayWindow,
      inputWindow
    }


    return inputBuffer;
  }

  async hide() { }

  async show() { }

  async appendToDisplayBuffer(opts: { text: string; scrollTop?: boolean }) {
    if (this.state.state != 'loaded') {
      console.error('Cannot append to display buffer - not initialized');
      return;
    }

    const lines = opts.text.split('\n');
    if (lines.length === 0) return;

    const { displayBuffer } = this.state
    const topLine = await displayBuffer.length;
    const lastLines = await displayBuffer.getLines({
      start: -2,
      end: -1,
      strictIndexing: false
    });
    const lastLine = lastLines.length ? lastLines[0] : ''

    await displayBuffer.setOption('modifiable', true);

    await displayBuffer.setLines(lastLine + lines[0], {
      start: -2,
      end: -1,
      strictIndexing: false
    })

    if (lines.length > 1) {
      await displayBuffer.setLines(lines.slice(1), {
        start: -1,
        end: -1,
        strictIndexing: false
      })
    }

    await displayBuffer.setOption('modifiable', false);

    const { displayWindow } = await this.getWindowIfVisible();
    if (displayWindow) {
      if (opts.scrollTop) {
        const offset = lines.length > 1 ? 1 : 0;
        displayWindow.cursor = [topLine + offset, 0]
      } else {
        const finalLine = await this.state.displayBuffer.length;
        displayWindow.cursor = [finalLine, 0]
      }
    }
  }

  async getWindowIfVisible(): Promise<{ displayWindow?: Window, inputWindow?: Window }> {
    if (this.state.state != 'loaded') {
      return {};
    }

    const { displayWindow, inputWindow } = this.state;
    const displayWindowValid = await displayWindow.valid
    const inputWindowValid = await inputWindow.valid

    return {
      displayWindow: displayWindowValid ? displayWindow : undefined,
      inputWindow: inputWindowValid ? inputWindow : undefined
    }
  }

  async getMessage(): Promise<string> {
    if (this.state.state != 'loaded') {
      this.logger.trace(`sidebar state is ${this.state.state} in getMessage`)
      return '';
    }

    const { inputBuffer } = this.state

    const lines = await inputBuffer.getLines({
      start: 0,
      end: -1,
      strictIndexing: false
    })

    this.logger.trace(`sidebar got lines ${JSON.stringify(lines)} in getMessage`)
    const message = lines.join('\n');
    await inputBuffer.setLines([''], {
      start: 0,
      end: -1,
      strictIndexing: false
    })

    return message;
  }
}
