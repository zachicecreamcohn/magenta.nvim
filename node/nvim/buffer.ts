import type { Nvim } from "bunvim";
import type { Position0Indexed, Position1Indexed } from "./window";

export type Line = string & { __line: true };
export type BufNr = number & { __bufnr: true };
export type Mode = "n" | "i" | "v";

export class NvimBuffer {
  constructor(
    public readonly id: BufNr,
    private nvim: Nvim,
  ) {}

  getOption(option: string) {
    return this.nvim.call("nvim_buf_get_option", [this.id, option]);
  }

  setOption(option: string, value: unknown) {
    return this.nvim.call("nvim_buf_set_option", [this.id, option, value]);
  }

  getChangeTick() {
    return this.nvim.call("nvim_buf_get_changedtick", [
      this.id,
    ]) as unknown as Promise<number>;
  }

  setLines({
    start,
    end,
    lines,
  }: {
    start: number;
    end: number;
    lines: Line[];
  }) {
    return this.nvim.call("nvim_buf_set_lines", [
      this.id,
      start,
      end,
      false,
      lines,
    ]);
  }

  async getLines({
    start,
    end,
  }: {
    start: number;
    end: number;
  }): Promise<Line[]> {
    const lines = await this.nvim.call("nvim_buf_get_lines", [
      this.id,
      start,
      end,
      false,
    ]);
    return lines as Line[];
  }

  async getText({
    startPos,
    endPos,
  }: {
    startPos: Position0Indexed;
    endPos: Position0Indexed;
  }): Promise<Line[]> {
    const lines = await this.nvim.call("nvim_buf_get_text", [
      this.id,
      startPos.row,
      startPos.col,
      endPos.row,
      endPos.col,
      {},
    ]);
    return lines as Line[];
  }

  setMark({ mark, pos }: { mark: string; pos: Position1Indexed }) {
    return this.nvim.call("nvim_buf_set_mark", [
      this.id,
      mark,
      pos.row,
      pos.col,
      {},
    ]);
  }

  setKeymap({
    mode,
    lhs,
    rhs,
    opts,
  }: {
    mode: Mode;
    lhs: string;
    rhs: string;
    opts: {
      silent?: boolean;
      noremap?: boolean;
    };
  }) {
    return this.nvim.call("nvim_buf_set_keymap", [
      this.id,
      mode,
      lhs,
      rhs,
      opts,
    ]);
  }

  getName() {
    return this.nvim.call("nvim_buf_get_name", [this.id]);
  }

  setName(name: string) {
    return this.nvim.call("nvim_buf_set_name", [this.id, name]);
  }

  static async create(listed: boolean, scratch: boolean, nvim: Nvim) {
    const bufNr = (await nvim.call("nvim_create_buf", [
      listed,
      scratch,
    ])) as BufNr;
    return new NvimBuffer(bufNr, nvim);
  }

  static async bufadd(absolutePath: string, nvim: Nvim) {
    const bufNr = (await nvim.call("nvim_eval", [
      `bufadd("${absolutePath}")`,
    ])) as BufNr;
    await nvim.call("nvim_eval", [`bufload(${bufNr})`]);
    return new NvimBuffer(bufNr, nvim);
  }
}
