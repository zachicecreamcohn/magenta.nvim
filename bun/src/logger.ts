export type Options = {
  level: "debug" | "info" | "trace";
};

export class Logger {
  constructor(
    private nvim: {
      outWriteLine: (message: string) => Promise<void>;
      errWrite: (message: string) => Promise<void>;
      errWriteLine: (message: string) => Promise<void>;
    },
    private options: Options = { level: "debug" },
  ) {}

  log(message: string) {
    console.log(message);
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.nvim.outWriteLine(message);
  }

  debug(message: string) {
    if (this.options.level == "debug" || this.options.level == "trace") {
      console.log(message);
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this.nvim.outWriteLine(message);
    }
  }

  trace(message: string) {
    if (this.options.level == "trace") {
      console.log(message);
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this.nvim.outWriteLine(message);
    }
  }

  error(error: Error | string) {
    try {
      console.error(error);
    } catch {
      // nothing to do
    }

    if (typeof error == "string") {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this.nvim.errWriteLine(error);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this.nvim.errWriteLine(error.message);

      if (error.stack) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          this.nvim.errWrite(error.stack);
        } catch {
          // nothing to do
        }
      }
    }
  }
}
