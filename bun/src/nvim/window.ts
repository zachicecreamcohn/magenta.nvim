import { context } from "../context.ts";
import { NvimBuffer, type BufNr } from "./buffer.ts";

export type Row0Indexed = number & { __row0Indexed: true };
export type Row1Indexed = number & { __row1Indexed: true };
export type ByteIdx = number & { __byteIdx: true };
export type Position1Indexed = {
  row: Row1Indexed;
  col: ByteIdx;
};

export type Position0Indexed = {
  row: Row0Indexed;
  col: ByteIdx;
};

export type WindowId = number & { __winId: true };

export class NvimWindow {
  constructor(public readonly id: WindowId) {}

  valid(): Promise<boolean> {
    return context.nvim.call("nvim_win_is_valid", [this.id]);
  }

  clearjumps() {
    return context.nvim.call("nvim_win_call", [
      this.id,
      `vim.cmd('clearjumps')`,
    ]);
  }

  setWidth(width: number) {
    return context.nvim.call("nvim_win_set_width", [this.id, width]);
  }

  setOption(name: string, value: unknown) {
    return context.nvim.call("nvim_win_set_option", [this.id, name, value]);
  }

  getVar(name: string) {
    return context.nvim.call("nvim_win_get_var", [this.id, name]);
  }

  setVar(name: string, value: unknown) {
    return context.nvim.call("nvim_win_set_var", [this.id, name, value]);
  }

  close(force: boolean = false) {
    return context.nvim.call("nvim_win_close", [this.id, force]);
  }

  async buffer(): Promise<NvimBuffer> {
    const bufNr = (await context.nvim.call("nvim_win_get_buf", [
      this.id,
    ])) as BufNr;
    return new NvimBuffer(bufNr);
  }

  async getCursor(): Promise<Position1Indexed> {
    const [row, col] = await context.nvim.call("nvim_win_get_cursor", [
      this.id,
    ]);
    return { row, col } as Position1Indexed;
  }

  setCursor(pos: Position1Indexed) {
    return context.nvim.call("nvim_win_set_cursor", [
      this.id,
      [pos.row, pos.col],
    ]);
  }

  zt() {
    return context.nvim.call("nvim_win_call", [
      this.id,
      `vim.cmd('normal! zt')`,
    ]);
  }
}
