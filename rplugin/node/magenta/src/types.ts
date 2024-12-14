import { Neovim } from "neovim";
import { Logger } from "./logger.ts";

export type Context = {
  nvim: Neovim;
  logger: Logger;
};
