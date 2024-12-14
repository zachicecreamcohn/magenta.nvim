import { AnthropicClient } from "../anthropic.ts";
import { Logger } from "../logger.ts";

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

async function run() {
  const client = new AnthropicClient(logger);

  await client.sendMessage(
    [
      {
        role: "user",
        content: "try reading the contents of the file tmp",
      },
    ],
    (text) => {
      return Promise.resolve(console.log("text: " + text));
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
