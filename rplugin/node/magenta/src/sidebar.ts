import { Buffer, Window } from "neovim";
import { context } from "./context.ts";

/** This will mostly manage the window toggle
 */
export class Sidebar {
  private state:
    | {
        state: "hidden";
        displayBuffer?: Buffer;
        inputBuffer?: Buffer;
      }
    | {
        state: "visible";
        displayBuffer: Buffer;
        inputBuffer: Buffer;
        displayWindow: Window;
        inputWindow: Window;
      };

  constructor() {
    this.state = { state: "hidden" };
  }

  async onWinClosed() {
    if (this.state.state == "visible") {
      const [displayWindowValid, inputWindowValid] = await Promise.all([
        this.state.displayWindow.valid,
        this.state.inputWindow.valid,
      ]);

      if (!(displayWindowValid && inputWindowValid)) {
        await this.hide();
      }
    }
  }

  /** returns buffers when they are visible
   */
  async toggle(): Promise<
    { displayBuffer: Buffer; inputBuffer: Buffer } | undefined
  > {
    if (this.state.state == "hidden") {
      return await this.show();
    } else {
      await this.hide();
    }
  }

  private async show(): Promise<{
    displayBuffer: Buffer;
    inputBuffer: Buffer;
  }> {
    const { nvim, logger } = context;
    const {
      displayBuffer: existingDisplayBuffer,
      inputBuffer: existingInputBuffer,
    } = this.state;
    logger.trace(`sidebar.show`);
    const totalHeight = (await nvim.getOption("lines")) as number;
    const cmdHeight = (await nvim.getOption("cmdheight")) as number;
    const width = 80;
    const displayHeight = Math.floor((totalHeight - cmdHeight) * 0.8);
    const inputHeight = totalHeight - displayHeight - 2;

    await nvim.command("leftabove vsplit");
    await nvim.command("clearjumps");
    const displayWindow = await nvim.window;
    displayWindow.width = width;

    let displayBuffer;
    if (existingDisplayBuffer) {
      displayBuffer = existingDisplayBuffer;
    } else {
      displayBuffer = (await nvim.createBuffer(false, true)) as Buffer;
      await displayBuffer.setOption("bufhidden", "hide");
      await displayBuffer.setOption("buftype", "nofile");
      await displayBuffer.setOption("swapfile", false);
      await displayBuffer.setOption("filetype", "markdown");
    }
    await nvim.lua(
      `vim.api.nvim_win_set_buf(${displayWindow.id}, ${displayBuffer.id})`,
    );
    let inputBuffer;
    if (existingInputBuffer) {
      inputBuffer = existingInputBuffer;
    } else {
      inputBuffer = (await nvim.createBuffer(false, true)) as Buffer;
      await inputBuffer.setOption("bufhidden", "hide");
      await inputBuffer.setOption("buftype", "nofile");
      await inputBuffer.setOption("swapfile", false);
      await inputBuffer.setOption("filetype", "markdown");
    }

    await nvim.command("below split");
    await nvim.command("clearjumps");
    const inputWindow = await nvim.window;
    inputWindow.height = inputHeight;
    await nvim.lua(
      `vim.api.nvim_win_set_buf(${inputWindow.id}, ${inputBuffer.id})`,
    );

    await inputBuffer.setLines([""], {
      start: 0,
      end: -1,
      strictIndexing: false,
    });

    const winOptions = {
      wrap: true,
      linebreak: true,
      number: false,
      relativenumber: false,
      cursorline: true,
    };

    for (const [key, value] of Object.entries(winOptions)) {
      await displayWindow.setOption(key, value);
      await inputWindow.setOption(key, value);
    }
    await displayWindow.setOption("winbar", "Magenta Chat");
    await inputWindow.setOption("winbar", "Magenta Input");

    await inputBuffer.request("nvim_buf_set_keymap", [
      inputBuffer,
      "n",
      "<CR>",
      ":Magenta send<CR>",
      { silent: true, noremap: true },
    ]);

    logger.trace(`sidebar.create setting state`);
    this.state = {
      state: "visible",
      displayBuffer,
      inputBuffer,
      displayWindow,
      inputWindow,
    };

    return { displayBuffer, inputBuffer };
  }

  async hide() {
    if (this.state.state == "visible") {
      const { displayWindow, inputWindow, displayBuffer, inputBuffer } =
        this.state;
      try {
        await Promise.all([displayWindow.close(), inputWindow.close()]);
      } catch {
        // windows may fail to close if they're already closed
      }
      this.state = {
        state: "hidden",
        displayBuffer,
        inputBuffer,
      };
    }
  }

  async scrollToLastUserMessage() {
    const { displayWindow } = await this.getWindowIfVisible();
    if (displayWindow) {
      const displayBuffer = await displayWindow.buffer;
      const lines = await displayBuffer.getLines();
      let pos: [number, number] | undefined = undefined;
      for (let lineIdx = lines.length - 1; lineIdx >= 0; lineIdx -= 1) {
        const line = lines[lineIdx];
        if (line.startsWith("### user:")) {
          // nvim_buf_set_cursor is 1-indexed in the row coordinate
          pos = [lineIdx + 1, 0];
          break;
        }
      }

      if (pos) {
        displayWindow.cursor = pos;
        // execute zt in the target window
        await context.nvim.lua(`\
vim.api.nvim_win_call(${displayWindow.id}, function()
  vim.cmd('normal! zt')
end)`);
      }
    }
  }

  async getWindowIfVisible(): Promise<{
    displayWindow?: Window;
    inputWindow?: Window;
  }> {
    if (this.state.state != "visible") {
      return {};
    }

    const { displayWindow, inputWindow } = this.state;
    const displayWindowValid = await displayWindow.valid;
    const inputWindowValid = await inputWindow.valid;

    return {
      displayWindow: displayWindowValid ? displayWindow : undefined,
      inputWindow: inputWindowValid ? inputWindow : undefined,
    };
  }

  async getMessage(): Promise<string> {
    if (this.state.state != "visible") {
      context.logger.trace(
        `sidebar state is ${this.state.state} in getMessage`,
      );
      return "";
    }

    const { inputBuffer } = this.state;

    const lines = await inputBuffer.getLines({
      start: 0,
      end: -1,
      strictIndexing: false,
    });

    context.logger.trace(
      `sidebar got lines ${JSON.stringify(lines)} from inputBuffer`,
    );
    const message = lines.join("\n");
    await inputBuffer.setLines([""], {
      start: 0,
      end: -1,
      strictIndexing: false,
    });

    return message;
  }
}
