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
  const res = await context.nvim.call("nvim_exec2", [
    "echo getcwd()",
    { output: true },
  ]);
  if (typeof res.output != "string") {
    throw new Error(`Unable to get cwd`);
  }
  return res.output;
}

export function diffthis() {
  return context.nvim.call("nvim_command", ["diffthis"]);
}
