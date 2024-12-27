import { attach, type Nvim } from "bunvim";
import { unlink } from "node:fs/promises";
import { spawn } from "child_process";
import { type MountedVDOM } from "../src/tea/view.ts";
import { assertUnreachable } from "../src/utils/assertUnreachable.ts";
import { setContext } from "../src/context.ts";
import { Lsp } from "../src/lsp.ts";
import path from "path";

export const MAGENTA_SOCK = "/tmp/magenta-test.sock";

export class NeovimTestHelper {
  private nvimProcess: ReturnType<typeof spawn> | undefined;
  private nvimClient: Nvim | undefined;

  startNvim(): Promise<Nvim> {
    return new Promise(async (resolve, reject) => {
      try {
        try {
          await unlink(MAGENTA_SOCK);
        } catch (e) {
          if ((e as { code: string }).code !== "ENOENT") {
            console.error(e);
          }
        }

        this.nvimProcess = spawn(
          "nvim",
          [
            "--headless",
            "-n",
            "--clean",
            "--listen",
            MAGENTA_SOCK,
            "-u",
            "minimal-init.lua",
          ],
          {
            // root dir relative to this file
            cwd: path.resolve(path.dirname(__filename), "../../"),
          },
        );

        if (!this.nvimProcess.pid) {
          throw new Error("Failed to start nvim process");
        }

        this.nvimProcess.on("error", (err) => {
          reject(err);
        });

        this.nvimProcess.on("exit", (code, signal) => {
          if (code !== 1) {
            console.log(
              `Nvim process exited with code ${code} and signal ${signal}`,
            );
          }
        });

        await new Promise((resolve) => setTimeout(resolve, 500));

        this.nvimClient = await attach({
          socket: MAGENTA_SOCK,
          client: { name: "magenta" },
          logging: { level: "debug" },
        });

        await this.nvimClient.call("nvim_exec_lua", [
          `\
require('magenta').bridge(${this.nvimClient.channelId})
`,
          [],
        ]);

        setContext({
          nvim: this.nvimClient,
          lsp: new Lsp(this.nvimClient),
        });

        resolve(this.nvimClient);
        this.nvimClient!.logger!.info("Nvim started");
      } catch (err) {
        reject(err);
      }
    });
  }

  stopNvim(): void {
    if (this.nvimClient) {
      this.nvimClient?.detach();
      this.nvimClient = undefined;
    }

    if (this.nvimProcess) {
      this.nvimProcess.kill();
      this.nvimProcess = undefined;
    }
  }
}

export function extractMountTree(mounted: MountedVDOM): unknown {
  switch (mounted.type) {
    case "string":
      return {
        type: "string",
        startPos: mounted.startPos,
        endPos: mounted.endPos,
        content: mounted.content,
      };
    case "node":
      return {
        type: "node",
        children: mounted.children.map(extractMountTree),
        startPos: mounted.startPos,
        endPos: mounted.endPos,
      };

    case "array":
      return {
        type: "array",
        children: mounted.children.map(extractMountTree),
        startPos: mounted.startPos,
        endPos: mounted.endPos,
      };

    default:
      assertUnreachable(mounted);
  }
}

process.on("uncaughtException", (err) => {
  console.error(err);
  process.exit(1);
});
