import { type Nvim } from "bunvim";
import type { Magenta } from "../src/magenta";
import type { Line } from "../src/nvim/buffer";
import type { MockClient } from "../src/anthropic-mock";
import { NvimWindow, pos0to1, type Position0Indexed } from "../src/nvim/window";
import { pollUntil } from "../src/utils/async";
import { calculatePosition } from "../src/tea/util";
import type { BindingKey } from "../src/tea/bindings";
import { getAllWindows } from "../src/nvim/nvim";

export class NvimDriver {
  constructor(
    public nvim: Nvim,
    public magenta: Magenta,
    public mockAnthropic: MockClient,
  ) {}

  async showSidebar() {
    if (this.magenta.sidebar.state.state == "hidden") {
      await this.magenta.command("toggle");
    }
  }

  async inputMagentaText(text: string) {
    const inputBuffer = this.magenta.sidebar.state.inputBuffer;
    if (!inputBuffer) {
      throw new Error(`sidebar inputBuffer not initialized yet`);
    }

    await inputBuffer.setLines({
      start: 0,
      end: -1,
      lines: text.split("\n") as Line[],
    });
  }

  async send() {
    this.magenta.command("send");
  }

  getDisplayBuffer() {
    const displayBuffer = this.magenta.sidebar.state.displayBuffer;
    if (!displayBuffer) {
      throw new Error(`sidebar displayBuffer not initialized yet`);
    }
    return displayBuffer;
  }

  getVisibleState() {
    if (this.magenta.sidebar.state.state != "visible") {
      throw new Error(`sidebar is not visible`);
    }
    return this.magenta.sidebar.state;
  }

  async assertDisplayBufferContains(text: string): Promise<Position0Indexed> {
    return pollUntil(async () => {
      const displayBuffer = this.getDisplayBuffer();
      const lines = await displayBuffer.getLines({ start: 0, end: -1 });
      const content = lines.join("\n");
      const index = content.indexOf(text);
      if (index == -1) {
        throw new Error(`Unable to find text ${text} in displayBuffer`);
      }

      return calculatePosition(
        { row: 0, col: 0 } as Position0Indexed,
        Buffer.from(content),
        index,
      );
    });
  }

  async triggerDisplayBufferKey(pos: Position0Indexed, key: BindingKey) {
    const { displayWindow } = this.getVisibleState();
    await this.nvim.call("nvim_set_current_win", [displayWindow.id]);
    displayWindow.setCursor(pos0to1(pos));

    await this.nvim.call("nvim_exec_lua", [
      `\
vim.rpcnotify(${this.nvim.channelId}, "magentaKey", "${key}")
-- local key = vim.api.nvim_replace_termcodes("${key}", true, false, true);
-- vim.api.nvim_feedkeys(key, "n", false);`,

      [],
    ]);
  }

  async assertWindowCount(n: number) {
    return await pollUntil(
      async () => {
        const windows = await getAllWindows();
        if (windows.length != n) {
          throw new Error(
            `Expected ${n} windows to appear, but saw ${windows.length}`,
          );
        }

        return windows;
      },
      { timeout: 200 },
    );
  }

  async findWindow(
    predicate: (w: NvimWindow) => Promise<boolean>,
  ): Promise<NvimWindow> {
    return await pollUntil(
      async () => {
        const windows = await getAllWindows();
        for (const window of windows) {
          if (await predicate(window)) {
            return window;
          }
        }

        throw new Error(`No window matched predicate`);
      },
      { timeout: 200 },
    );
  }
}
