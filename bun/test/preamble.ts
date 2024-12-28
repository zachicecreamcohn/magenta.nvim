import { attach, type Nvim } from "bunvim";
import { unlink } from "node:fs/promises";
import { spawn } from "child_process";
import { type MountedVDOM } from "../src/tea/view.ts";
import { assertUnreachable } from "../src/utils/assertUnreachable.ts";
import { setContext } from "../src/context.ts";
import { Lsp } from "../src/lsp.ts";
import path from "path";
import { delay } from "../src/utils/async.ts";
import { Magenta } from "../src/magenta.ts";
import { withMockClient } from "../src/anthropic-mock.ts";
import { NvimDriver } from "./driver.ts";

export const MAGENTA_SOCK = "/tmp/magenta-test.sock";

export async function withNvimProcess(fn: () => Promise<void>) {
  try {
    await unlink(MAGENTA_SOCK);
  } catch (e) {
    if ((e as { code: string }).code !== "ENOENT") {
      console.error(e);
    }
  }

  const nvimProcess = spawn(
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

  if (!nvimProcess.pid) {
    throw new Error("Failed to start nvim process");
  }

  try {
    nvimProcess.on("error", (err) => {
      throw err;
    });

    nvimProcess.on("exit", (code, signal) => {
      if (code !== 1) {
        throw new Error(
          `Nvim process exited with code ${code} and signal ${signal}`,
        );
      }
    });

    // give enough time for socket to be created
    await delay(500);

    await fn();
  } finally {
    nvimProcess.kill();
  }
}

export async function withNvimClient(fn: (nvim: Nvim) => Promise<void>) {
  return await withNvimProcess(async () => {
    const nvim = await attach({
      socket: MAGENTA_SOCK,
      client: { name: "magenta" },
      logging: { level: "debug" },
    });

    await nvim.call("nvim_exec_lua", [
      `\
        require('magenta').bridge(${nvim.channelId})
      `,
      [],
    ]);

    setContext({
      nvim: nvim,
      lsp: new Lsp(nvim),
    });

    nvim!.logger!.info("Nvim started");

    try {
      await fn(nvim);
    } finally {
      nvim.detach();
    }
  });
}

export async function withDriver(fn: (driver: NvimDriver) => Promise<void>) {
  return await withNvimProcess(async () => {
    const nvim = await attach({
      socket: MAGENTA_SOCK,
      client: { name: "magenta" },
      logging: { level: "debug" },
    });

    setContext({
      nvim,
      lsp: new Lsp(nvim),
    });

    await withMockClient(async (mockAnthropic) => {
      const magenta = await Magenta.start(nvim);
      try {
        await fn(new NvimDriver(nvim, magenta, mockAnthropic));
      } finally {
        nvim.detach();
      }
    });
  });
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
