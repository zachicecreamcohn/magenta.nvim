import { AnthropicClient } from "../anthropic.ts";
import { Logger } from "../logger.ts";
import { setContext } from "../context.ts";
import { Neovim } from "neovim";

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
  nvim: undefined as unknown as Neovim,
  logger,
});

async function run() {
  const client = new AnthropicClient();

  await client.sendMessage(
    [
      {
        role: "user",
        content: "try reading the contents of the file tmp",
      },
    ],
    (text) => {
      console.log("text: " + text);
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
