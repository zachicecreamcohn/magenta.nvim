import { Neovim } from "neovim"
import { Logger } from "./logger"

export type Context = {
  nvim: Neovim,
  logger: Logger
}
