import type { Nvim } from "./nvim-node";
import type { Position0Indexed, Position1Indexed } from "./window";
import { withTimeout } from "../utils/async";
import type { AbsFilePath } from "../utils/files";

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

  setText({
    startPos,
    endPos,
    lines,
  }: {
    startPos: Position0Indexed;
    endPos: Position0Indexed;
    lines: Line[];
  }): Promise<void> {
    return this.nvim.call("nvim_buf_set_text", [
      this.id,
      startPos.row,
      startPos.col,
      endPos.row,
      endPos.col,
      lines,
    ]);
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

  setSiderbarKeymaps() {
    return this.nvim.call("nvim_exec_lua", [
      `require("magenta.keymaps").set_sidebar_buffer_keymaps(${this.id})`,
      [],
    ]);
  }

  setDisplayKeymaps() {
    return this.nvim.call("nvim_exec_lua", [
      `require("magenta.keymaps").set_display_buffer_keymaps(${this.id})`,
      [],
    ]);
  }

  setInlineKeymaps(targetBufnr: BufNr) {
    return this.nvim.call("nvim_exec_lua", [
      `require("magenta.keymaps").set_inline_buffer_keymaps(${this.id}, ${targetBufnr})`,
      [],
    ]);
  }

  getName() {
    return this.nvim.call("nvim_buf_get_name", [this.id]);
  }

  setName(name: string) {
    return this.nvim.call("nvim_buf_set_name", [this.id, name]);
  }

  async attemptWrite() {
    // TODO: this is really gross. Unfortunately when write fails in this context, for
    // some reason we never hear back from this promise.
    // This is brittle, since if the file takes longer than the timeout to write, we may
    // incorrectly assume that it failed to write. However, this should be rare. The extra
    // 1s delay is also not ideal, but we should be doing this rarely - only when responding
    // to a tool call. As such it should be ok for now, and I really just want to move on from
    // this issue.
    // See https://github.com/neovim/neovim/discussions/33804 for further discussion
    return withTimeout(
      this.nvim.call("nvim_exec_lua", [
        `\
vim.api.nvim_buf_call(${this.id}, function()
  -- silent to avoid blocking on unable to write (which would typically alert the user)
  vim.cmd("silent! write")
end)`,
        [],
      ]),
      1000,
    );
  }

  async attemptEdit() {
    // TODO: this is really gross. Unfortunately when write fails in this context, for
    // some reason we never hear back from this promise.
    // This is brittle, since if the file takes longer than the timeout to write, we may
    // incorrectly assume that it failed to write. However, this should be rare. The extra
    // 1s delay is also not ideal, but we should be doing this rarely - only when responding
    // to a tool call. As such it should be ok for now, and I really just want to move on from
    // this issue.
    // See https://github.com/neovim/neovim/discussions/33804 for further discussion
    return withTimeout(
      this.nvim.call("nvim_exec_lua", [
        `\
vim.api.nvim_buf_call(${this.id}, function()
  -- silent to avoid blocking on unable to write (which would typically alert the user)
  vim.cmd("silent! edit")
end)`,
        [],
      ]),
      1000,
    );
  }

  static async create(listed: boolean, scratch: boolean, nvim: Nvim) {
    const bufNr = (await nvim.call("nvim_create_buf", [
      listed,
      scratch,
    ])) as BufNr;
    return new NvimBuffer(bufNr, nvim);
  }

  static async bufadd(absolutePath: AbsFilePath, nvim: Nvim) {
    const bufNr = (await nvim.call("nvim_eval", [
      `bufadd("${absolutePath}")`,
    ])) as BufNr;
    await nvim.call("nvim_eval", [`bufload(${bufNr})`]);
    return new NvimBuffer(bufNr, nvim);
  }
}
