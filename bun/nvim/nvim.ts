import type { Nvim } from "bunvim";
import { NvimBuffer, type BufNr } from "./buffer.ts";
import { NvimWindow, type Position1Indexed, type WindowId } from "./window.ts";

export function getOption(option: string, nvim: Nvim) {
  return nvim.call("nvim_get_option", [option]);
}

export async function getCurrentWindow(nvim: Nvim) {
  const winId = (await nvim.call("nvim_get_current_win", [])) as WindowId;
  return new NvimWindow(winId, nvim);
}

export async function getCurrentBuffer(nvim: Nvim) {
  const bufnr = (await nvim.call("nvim_get_current_buf", [])) as BufNr;
  return new NvimBuffer(bufnr, nvim);
}

export async function getAllBuffers(nvim: Nvim) {
  const bufs = (await nvim.call("nvim_list_bufs", [])) as BufNr[];
  return bufs.map((bufnr) => new NvimBuffer(bufnr, nvim));
}

export async function getAllWindows(nvim: Nvim) {
  const winIds = (await nvim.call("nvim_list_wins", [])) as WindowId[];
  return winIds.map((winId) => new NvimWindow(winId, nvim));
}

export async function getcwd(nvim: Nvim) {
  const res = await nvim.call("nvim_exec2", [
    "echo getcwd()",
    { output: true },
  ]);
  if (typeof res.output != "string") {
    throw new Error(`Unable to get cwd`);
  }
  return res.output;
}

export async function mode(nvim: Nvim) {
  const res = await nvim.call("nvim_exec2", ["echo mode()", { output: true }]);
  if (typeof res.output != "string") {
    throw new Error(`Unable to get mode`);
  }
  return res.output;
}

export async function getpos(
  nvim: Nvim,
  str: string,
): Promise<Position1Indexed> {
  const res = await nvim.call("nvim_exec2", [
    `echo getpos("${str}")`,
    { output: true },
  ]);
  if (typeof res.output != "string") {
    throw new Error(`Unable to getpos`);
  }
  const posStr = res.output;

  const [_, row, col] = posStr
    // eslint-disable-next-line no-useless-escape
    .replace(/[\[\]]/g, "")
    .split(",")
    .map((n) => parseInt(n.trim(), 10));

  return {
    row,
    col,
  } as Position1Indexed;
}

export function diffthis(nvim: Nvim) {
  return nvim.call("nvim_command", ["diffthis"]);
}

export function notifyErr(nvim: Nvim, err: unknown) {
  return nvim.call("nvim_notify", [
    `Thunk execution error: ${err instanceof Error ? err.message : JSON.stringify(err)}`,
    3,
    {},
  ]);
}
