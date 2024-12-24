import { getClient } from "../anthropic.ts";
import { Logger } from "../logger.ts";
import { setContext } from "../context.ts";
import { Neovim, NvimPlugin } from "neovim";
import { Lsp } from "../lsp.ts";

const logger = new Logger(
  {
    outWriteLine: () => Promise.resolve(undefined),
    errWrite: () => Promise.resolve(undefined),
    errWriteLine: () => Promise.resolve(undefined),
  },
  {
    level: "trace",
  },
);

setContext({
  plugin: undefined as unknown as NvimPlugin,
  nvim: undefined as unknown as Neovim,
  logger,
  lsp: undefined as unknown as Lsp
});

async function run() {
  const client = getClient();

  await client.sendMessage(
    [
      {
        role: "user",
        content: "try reading the contents of the file tmp",
      },
    ],
    (text) => {
      console.log("stream-text: " + text);
    },
    (err) => {
      console.error(err);
    },
  );
}

run().then(
  () => {
    console.log("success");
    process.exit(0);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
