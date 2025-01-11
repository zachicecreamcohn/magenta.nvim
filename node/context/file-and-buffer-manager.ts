import type { MessageId } from "../chat/message";
import { assertUnreachable } from "../utils/assertUnreachable";
import { getBufferIfOpen } from "../utils/buffers";
import path from "node:path";
import fs from "node:fs";
import type { Nvim } from "bunvim";
import type { Result } from "../utils/result";
import { getcwd } from "../nvim/nvim";
import { NvimBuffer, type BufNr } from "../nvim/buffer";

type FileMeta = {
  type: "file";
  absFilePath: string;
  relFilePath: string;
  mtime: Date;
};

type BufferMeta = {
  type: "buffer";
  bufnr: BufNr;
  relFilePath: string;
  changeTick: number;
};

export class BufferAndFileManager {
  private filesAndBuffers: {
    [absFilePath: string]: {
      meta: FileMeta | BufferMeta;
      messageId: MessageId;
      content: string;
    };
  } = {};

  constructor(private nvim: Nvim) {}

  /** Return the file along with the message that precedes the last time this file was changed.
   */
  async getFileContents(
    absFilePath: string,
    messageId: MessageId,
  ): Promise<
    Result<{
      /** The message before which this file should appear.
       */
      messageId: MessageId;
      relFilePath: string;
      content: string;
    }>
  > {
    const result = await this.getFileCacheInfo(absFilePath);

    if (result.status == "ok") {
      const cache = this.filesAndBuffers[absFilePath];
      const fileOrBufferMeta = result.value;
      if (cache) {
        switch (fileOrBufferMeta.type) {
          case "buffer":
            if (
              cache.meta.type == "buffer" &&
              cache.meta.changeTick == fileOrBufferMeta.changeTick
            ) {
              // the buffer hasn't changed since the last time we retrieved it.
              return {
                status: "ok",
                value: {
                  messageId: cache.messageId,
                  relFilePath: cache.meta.relFilePath,
                  content: cache.content,
                },
              };
            } else {
              const bufferContent =
                await this.getContentFromMeta(fileOrBufferMeta);

              this.filesAndBuffers[absFilePath] = {
                meta: fileOrBufferMeta,
                messageId,
                content: bufferContent,
              };

              return {
                status: "ok",
                value: {
                  messageId,
                  relFilePath: cache.meta.relFilePath,
                  content: bufferContent,
                },
              };
            }

          case "file": {
            if (
              cache.meta.type == "file" &&
              cache.meta.mtime.getTime() == fileOrBufferMeta.mtime.getTime()
            ) {
              // the file hasn't changed since the last time we read it.
              return {
                status: "ok",
                value: {
                  messageId: cache.messageId,
                  relFilePath: cache.meta.relFilePath,
                  content: cache.content,
                },
              };
            } else {
              const content = await this.getContentFromMeta(fileOrBufferMeta);
              this.filesAndBuffers[absFilePath] = {
                meta: fileOrBufferMeta,
                messageId: messageId,
                content,
              };
              return {
                status: "ok",
                value: {
                  messageId,
                  relFilePath: cache.meta.relFilePath,
                  content,
                },
              };
            }
          }

          default:
            assertUnreachable(fileOrBufferMeta);
        }
      } else {
        const content = await this.getContentFromMeta(fileOrBufferMeta);
        this.filesAndBuffers[absFilePath] = {
          meta: fileOrBufferMeta,
          messageId: messageId,
          content,
        };

        return {
          status: "ok",
          value: {
            messageId,
            relFilePath: fileOrBufferMeta.relFilePath,
            content,
          },
        };
      }
    } else {
      return result;
    }
  }

  private async getContentFromMeta(
    meta: FileMeta | BufferMeta,
  ): Promise<string> {
    switch (meta.type) {
      case "file":
        return await fs.promises.readFile(meta.absFilePath, "utf-8");

      case "buffer":
        return (
          await new NvimBuffer(meta.bufnr, this.nvim).getLines({
            start: 0,
            end: -1,
          })
        ).join("\n");
    }
  }

  private async getFileCacheInfo(
    absFilePath: string,
  ): Promise<Result<FileMeta | BufferMeta>> {
    const cwd = await getcwd(this.nvim);
    const relFilePath = path.relative(cwd, absFilePath);
    const bufferOpenResult = await getBufferIfOpen({
      relativePath: relFilePath,
      context: { nvim: this.nvim },
    });

    switch (bufferOpenResult.status) {
      case "ok": {
        const changeTick = await bufferOpenResult.buffer.getChangeTick();
        return {
          status: "ok",
          value: {
            type: "buffer",
            bufnr: bufferOpenResult.buffer.id,
            relFilePath,
            changeTick,
          },
        };
      }

      case "error":
        return bufferOpenResult;

      case "not-found":
        break;

      default:
        assertUnreachable(bufferOpenResult);
    }

    try {
      const fileStats = await fs.promises.stat(absFilePath);
      return {
        status: "ok",
        value: {
          type: "file",
          absFilePath,
          relFilePath,
          mtime: fileStats.mtime,
        },
      };
    } catch (error) {
      return {
        status: "error",
        error: `Error trying to read file \`${relFilePath}\`: ${(error as Error).message}`,
      };
    }
  }
}
