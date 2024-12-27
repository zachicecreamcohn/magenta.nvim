import { type Nvim } from "bunvim";
import { Lsp } from "./lsp.ts";

export type Context = {
  nvim: Nvim;
  lsp: Lsp;
};
/** Should be called first
 */
export function setContext(c: Context) {
  context = c;
}

export let context: Context;
