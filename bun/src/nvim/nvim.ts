import { context } from "../context.ts";
import { NvimBuffer, type BufNr } from "./buffer.ts";
import { NvimWindow, type WindowId } from "./window.ts";

export function getOption(option: string) {
  return context.nvim.call("nvim_get_option", [option]);
}

export async function getCurrentWindow() {
  const winId = (await context.nvim.call(
    "nvim_get_current_win",
    [],
  )) as WindowId;
  return new NvimWindow(winId);
}

export async function getAllBuffers() {
  const bufs = (await context.nvim.call("nvim_list_bufs", [])) as BufNr[];
  return bufs.map((bufnr) => new NvimBuffer(bufnr));
}

export async function getAllWindows() {
  const winIds = (await context.nvim.call("nvim_list_wins", [])) as WindowId[];
  return winIds.map((winId) => new NvimWindow(winId));
}

export async function getcwd() {
  const cwd = (await context.nvim.call("nvim_eval", ["getcwd"])) as
    | string
    | null;
  if (typeof cwd != "string") {
    throw new Error(`Unable to get cwd`);
  }
  return cwd;
}

export function diffthis() {
  return context.nvim.call("nvim_eval", ["diffthis"]);
}
