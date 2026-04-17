const TIMINGS = Boolean(process.env.MAGENTA_TIMINGS);
const NODE_START_TIME = performance.now();

import { Magenta } from "./magenta.ts";
import { notifyErr } from "./nvim/nvim.ts";
import { attach, type LogLevel } from "./nvim/nvim-node/index.ts";

// These values are set by neovim when starting the node process
const ENV = {
  NVIM: process.env.NVIM,
  LOG_LEVEL: process.env.LOG_LEVEL as LogLevel | undefined,
  DEV: Boolean(process.env.IS_DEV),
};

if (!ENV.NVIM) throw Error("socket missing");
const nvim = await attach({
  socket: ENV.NVIM,
  client: { name: "magenta" },
  logging: { level: ENV.LOG_LEVEL },
});

if (nvim.logger.error) {
  const original = nvim.logger.error.bind(nvim.logger);
  nvim.logger.error = ((error: Error | string, ...rest: unknown[]) => {
    original(
      error instanceof Error
        ? `Error: ${error.message}\n${error.stack}`
        : error,
      ...rest,
    );
    notifyErr(nvim, error, ...rest).catch((err) =>
      original(
        err instanceof Error
          ? `notifyErr failed: ${err.message}\n${err.stack}`
          : err,
      ),
    );
  }) as typeof original;
}

process.on("uncaughtException", (error) => {
  nvim.logger.error(error);
  setTimeout(() => {
    // wait for logger to finish writing
    process.exit(1);
  }, 100);
});

if (TIMINGS)
  nvim.logger.info(
    `[magenta-timing] node process started, attaching to nvim took ${(performance.now() - NODE_START_TIME).toFixed(1)}ms`,
  );
await Magenta.start(nvim);
if (TIMINGS)
  nvim.logger.info(
    `[magenta-timing] Magenta.start() complete, total node startup: ${(performance.now() - NODE_START_TIME).toFixed(1)}ms`,
  );
