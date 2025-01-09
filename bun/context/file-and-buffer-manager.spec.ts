import { withNvimClient } from "../test/preamble.ts";
import { describe, expect, it } from "bun:test";
import { BufferAndFileManager } from "./file-and-buffer-manager.ts";
import path from "path";
import fs from "fs";
import { getCurrentBuffer, getcwd } from "../nvim/nvim.ts";
import type { MessageId } from "../chat/message.ts";
import type { Line } from "../nvim/buffer.ts";

describe("Neovim Plugin Tests", () => {
  it("basic rendering & update", async () => {
    await withNvimClient(async (nvim) => {
      const bufferAndFileManager = new BufferAndFileManager(nvim);
      const cwd = await getcwd(nvim);

      const absFilePath = path.resolve(cwd, "bun/test/fixtures/poem.txt");
      {
        const res = await bufferAndFileManager.getFileContents(
          absFilePath,
          1 as MessageId,
        );

        expect(res).toEqual({
          status: "ok",
          value: {
            messageId: 1 as MessageId,
            relFilePath: "bun/test/fixtures/poem.txt",
            content: `\
Moonlight whispers through the trees,
Silver shadows dance with ease.
Stars above like diamonds bright,
Paint their stories in the night.
`,
          },
        });
      }

      {
        const res = await bufferAndFileManager.getFileContents(
          absFilePath,
          3 as MessageId,
        );

        expect(
          res,
          "when the content hasn't changed, we should return the initial message id",
        ).toEqual({
          status: "ok",
          value: {
            messageId: 1 as MessageId,
            relFilePath: "bun/test/fixtures/poem.txt",
            content: `\
Moonlight whispers through the trees,
Silver shadows dance with ease.
Stars above like diamonds bright,
Paint their stories in the night.
`,
          },
        });
      }

      await touchFile(absFilePath);
      {
        const res = await bufferAndFileManager.getFileContents(
          absFilePath,
          5 as MessageId,
        );

        expect(
          res,
          "after the file is touched, we update the returned messageId",
        ).toEqual({
          status: "ok",
          value: {
            messageId: 5 as MessageId,
            relFilePath: "bun/test/fixtures/poem.txt",
            content: `\
Moonlight whispers through the trees,
Silver shadows dance with ease.
Stars above like diamonds bright,
Paint their stories in the night.
`,
          },
        });
      }

      await nvim.call("nvim_exec2", [`edit ${absFilePath}`, {}]);
      const buf = await getCurrentBuffer(nvim);
      await buf.setLines({
        start: 0,
        end: -1,
        lines: ["new content"] as Line[],
      });

      {
        const res = await bufferAndFileManager.getFileContents(
          absFilePath,
          7 as MessageId,
        );

        expect(
          res,
          "after the file is loaded into a buffer, we load the buffer content",
        ).toEqual({
          status: "ok",
          value: {
            messageId: 7 as MessageId,
            relFilePath: "bun/test/fixtures/poem.txt",
            content: `new content`,
          },
        });
      }
    });
  });
});

async function touchFile(filePath: string): Promise<void> {
  const time = new Date();
  await fs.promises.utimes(filePath, time, time);
}
