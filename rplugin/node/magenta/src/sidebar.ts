import { Neovim, Buffer, Window } from "neovim";
import { Logger } from "./logger.ts";

/** This will mostly manage the window toggle
 */
export class Sidebar {
  private state:
    | {
        state: "hidden";
      }
    | {
        state: "visible";
        displayBuffer: Buffer;
        inputBuffer: Buffer;
        displayWindow: Window;
        inputWindow: Window;
      };

  constructor(
    private nvim: Neovim,
    private logger: Logger,
  ) {
    this.state = { state: "hidden" };
    // TODO: also probably need to set up some autocommands to detect if the user closes the scratch buffers
  }

  /** returns buffers when they are visible
   */
  async toggle(): Promise<
    { displayBuffer: Buffer; inputBuffer: Buffer } | undefined
  > {
    if (this.state.state == "hidden") {
      return await this.create();
    } else {
      await this.destroy();
    }
  }

  private async create(): Promise<{
    displayBuffer: Buffer;
    inputBuffer: Buffer;
  }> {
    const { nvim, logger } = this;
    logger.trace(`sidebar.create`);
    const totalHeight = (await nvim.getOption("lines")) as number;
    const cmdHeight = (await nvim.getOption("cmdheight")) as number;
    const width = 80;
    const displayHeight = Math.floor((totalHeight - cmdHeight) * 0.8);
    const inputHeight = totalHeight - displayHeight - 2;

    await nvim.command("leftabove vsplit");
    const displayWindow = await nvim.window;
    const displayBuffer = (await this.nvim.createBuffer(false, true)) as Buffer;
    displayWindow.width = width;
    await nvim.lua(
      `vim.api.nvim_win_set_buf(${displayWindow.id}, ${displayBuffer.id})`,
    );

    const inputBuffer = (await this.nvim.createBuffer(false, true)) as Buffer;

    await nvim.command("below split");
    const inputWindow = await nvim.window;
    inputWindow.height = inputHeight;
    await nvim.lua(
      `vim.api.nvim_win_set_buf(${inputWindow.id}, ${inputBuffer.id})`,
    );

    await inputBuffer.setOption("buftype", "nofile");
    await inputBuffer.setOption("swapfile", false);
    await inputBuffer.setLines(["> "], {
      start: 0,
      end: -1,
      strictIndexing: false,
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

  async destroy() {
    this.state = {
      state: "hidden",
    };

    // TODO: clean up buffers
  }

  async scrollTop() {
    // const { displayWindow } = await this.getWindowIfVisible();
    // if (displayWindow) {
    //   if (opts.scrollTop) {
    //     const offset = lines.length > 1 ? 1 : 0;
    //     displayWindow.cursor = [topLine + offset, 0]
    //   } else {
    //     const finalLine = await this.state.displayBuffer.length;
    //     displayWindow.cursor = [finalLine, 0]
    //   }
    // }
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
      this.logger.trace(`sidebar state is ${this.state.state} in getMessage`);
      return "";
    }

    const { inputBuffer } = this.state;

    const lines = await inputBuffer.getLines({
      start: 0,
      end: -1,
      strictIndexing: false,
    });

    this.logger.trace(
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
