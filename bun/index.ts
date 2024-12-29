import { attach, type LogLevel } from "bunvim";
import { Magenta } from "./magenta.ts";

// These values are set by neovim when starting the bun process
const ENV = {
  NVIM: process.env["NVIM"],
  LOG_LEVEL: process.env["LOG_LEVEL"] as LogLevel | undefined,
  DEV: Boolean(process.env["IS_DEV"]),
};

if (!ENV.NVIM) throw Error("socket missing");
const nvim = await attach({
  socket: ENV.NVIM,
  client: { name: "magenta" },
  logging: { level: ENV.LOG_LEVEL },
});

process.on("uncaughtException", (error) => {
  nvim.logger?.error(error);
  process.exit(1);
});

await Magenta.start(nvim);
