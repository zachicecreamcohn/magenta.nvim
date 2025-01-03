import { type Nvim } from "bunvim";
import type { Magenta } from "../magenta";
import type { Line } from "../nvim/buffer";
import type { MockProvider } from "../providers/mock";
import {
  NvimWindow,
  pos0to1,
  type ByteIdx,
  type Position0Indexed,
} from "../nvim/window";
import { pollUntil } from "../utils/async";
import { calculatePosition } from "../tea/util";
import type { BindingKey } from "../tea/bindings";
import { getAllWindows } from "../nvim/nvim";

export class NvimDriver {
  constructor(
    public nvim: Nvim,
    public magenta: Magenta,
    public mockAnthropic: MockProvider,
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

  send() {
    return this.magenta.command("send");
  }

  clear() {
    return this.magenta.command("clear");
  }

  getDisplayBuffer() {
    const displayBuffer = this.magenta.sidebar.state.displayBuffer;
    if (!displayBuffer) {
      throw new Error(`sidebar displayBuffer not initialized yet`);
    }
    return displayBuffer;
  }

  async getDisplayBufferText() {
    const displayBuffer = this.getDisplayBuffer();
    const lines = await displayBuffer.getLines({ start: 0, end: -1 });
    return lines.join("\n");
  }

  getVisibleState() {
    if (this.magenta.sidebar.state.state != "visible") {
      throw new Error(`sidebar is not visible`);
    }
    return this.magenta.sidebar.state;
  }

  async assertDisplayBufferContains(
    text: string,
    start: number = 0,
  ): Promise<Position0Indexed> {
    return pollUntil(async () => {
      const displayBuffer = this.getDisplayBuffer();
      const lines = await displayBuffer.getLines({ start: 0, end: -1 });
      const content = lines.slice(start).join("\n");
      const index = Buffer.from(content).indexOf(text) as ByteIdx;
      if (index == -1) {
        throw new Error(
          `Unable to find text:\n"${text}"\nafter line ${start} in displayBuffer.\ndisplayBuffer content:\n${content}`,
        );
      }

      return calculatePosition(
        { row: start, col: 0 } as Position0Indexed,
        Buffer.from(content),
        index,
      );
    });
  }

  async assertDisplayBufferContent(text: string): Promise<void> {
    return pollUntil(async () => {
      const displayBuffer = this.getDisplayBuffer();
      const lines = await displayBuffer.getLines({ start: 0, end: -1 });
      const content = lines.join("\n");
      if (content != text) {
        throw new Error(
          `display buffer content does not match text:\n"${text}"\ndisplayBuffer content:\n${content}`,
        );
      }
    });
  }

  async triggerDisplayBufferKey(pos: Position0Indexed, key: BindingKey) {
    const { displayWindow } = this.getVisibleState();
    await this.nvim.call("nvim_set_current_win", [displayWindow.id]);
    await displayWindow.setCursor(pos0to1(pos));

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
        const windows = await getAllWindows(this.nvim);
        if (windows.length != n) {
          const windowDetails = await Promise.all(
            windows.map(async (w) => {
              const buffer = await w.buffer();
              const name = await buffer.getName();
              return `window ${w.id} containing buffer "${name}"`;
            }),
          );
          throw new Error(
            `Expected ${n} windows to appear, but saw ${windows.length}: [${windowDetails.join(", ")}]`,
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
        const windows = await getAllWindows(this.nvim);
        for (const window of windows) {
          if (await predicate(window)) {
            return window;
          }
        }

        const windowDetails = await Promise.all(
          windows.map(async (w) => {
            const buffer = await w.buffer();
            const name = await buffer.getName();
            return `window ${w.id} containing buffer "${name}"`;
          }),
        );

        throw new Error(
          `No window matched predicate ${predicate.toString()}: [${windowDetails.join(", ")}]`,
        );
      },
      { timeout: 200 },
    );
  }

  async editFile(filePath: string): Promise<void> {
    await this.nvim.call("nvim_exec2", [`edit ${filePath}`, {}]);
  }
}
