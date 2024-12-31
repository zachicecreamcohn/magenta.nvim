import { attach, type Nvim } from "bunvim";
import { unlink, exists } from "node:fs/promises";
import { spawn } from "child_process";
import { type MountedVDOM } from "../tea/view.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import path from "path";
import { pollUntil } from "../utils/async.ts";
import { Magenta } from "../magenta.ts";
import { withMockClient } from "../anthropic-mock.ts";
import { NvimDriver } from "./driver.ts";

const SOCK = `/tmp/magenta-test.sock`;
export async function withNvimProcess(fn: (sock: string) => Promise<void>) {
  try {
    await unlink(SOCK);
    console.log("unlinked socket");
  } catch (e) {
    if ((e as { code: string }).code !== "ENOENT") {
      console.error(e);
    }
  }

  const nvimProcess = spawn(
    "nvim",
    ["--headless", "-n", "--clean", "--listen", SOCK, "-u", "minimal-init.lua"],
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

    await pollUntil(
      async () => {
        if (await exists(SOCK)) {
          console.log("socket ready");
          return true;
        }
        throw new Error("socket not ready");
      },
      { timeout: 500 },
    );

    await fn(SOCK);
  } finally {
    const res = nvimProcess.kill();
    console.log(`Killed process ${nvimProcess.pid} with result ${res}`);
  }
}

export async function withNvimClient(fn: (nvim: Nvim) => Promise<void>) {
  return await withNvimProcess(async (sock) => {
    const nvim = await attach({
      socket: sock,
      client: { name: "magenta" },
      logging: { level: "debug" },
    });

    await nvim.call("nvim_exec_lua", [
      `\
        require('magenta').bridge(${nvim.channelId})
      `,
      [],
    ]);

    nvim.logger!.info("Nvim started");

    try {
      await fn(nvim);
    } finally {
      nvim.detach();
      console.log(`detached nvim`);
    }
  });
}

export async function withDriver(fn: (driver: NvimDriver) => Promise<void>) {
  return await withNvimProcess(async (sock) => {
    const nvim = await attach({
      socket: sock,
      client: { name: "magenta" },
      logging: { level: "debug" },
    });

    await withMockClient(async (mockAnthropic) => {
      const magenta = await Magenta.start(nvim);
      try {
        await fn(new NvimDriver(nvim, magenta, mockAnthropic));
      } finally {
        magenta.destroy();
        nvim.detach();
        console.log(`detached nvim`);
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
