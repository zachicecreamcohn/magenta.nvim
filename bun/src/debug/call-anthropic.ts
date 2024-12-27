import { getClient } from "../anthropic.ts";
import { setContext } from "../context.ts";
import { type Nvim } from "bunvim";
import { Lsp } from "../lsp.ts";

setContext({
  nvim: undefined as unknown as Nvim,
  lsp: undefined as unknown as Lsp,
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
