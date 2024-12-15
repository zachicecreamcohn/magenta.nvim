import { Neovim } from "neovim";
import { Logger } from "./logger.ts";

export type Context = {
  nvim: Neovim;
  logger: Logger;
};
/** Should be called first
 */
export function setContext(c: Context) {
  context = c;
}

export let context: Context;
