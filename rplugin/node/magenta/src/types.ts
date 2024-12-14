import { Neovim } from "neovim";
import { Logger } from "./logger.js";

export type Context = {
  nvim: Neovim;
  logger: Logger;
};
