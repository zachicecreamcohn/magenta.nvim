import { Neovim, NvimPlugin } from "neovim";
import { Logger } from "./logger.ts";
import { Lsp } from "./lsp.ts";

export type Context = {
  plugin: NvimPlugin;
  nvim: Neovim;
  logger: Logger;
  lsp: Lsp;
};
/** Should be called first
 */
export function setContext(c: Context) {
  context = c;
}

export let context: Context;
