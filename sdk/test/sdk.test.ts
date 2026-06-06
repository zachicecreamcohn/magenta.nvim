import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MagentaToScript, ScriptToMagenta } from "../protocol.ts";
import { runScript } from "../testing.ts";
import "./fixtures/two-threads.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures");

function forkScript(file: string): ChildProcess {
  return spawn(
    process.execPath,
    ["--experimental-transform-types", path.join(FIXTURES, file)],
    {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: { ...process.env, MAGENTA_SDK_CHILD: "1" },
    },
  );
}

function nextMessage(child: ChildProcess): Promise<ScriptToMagenta> {
  return new Promise((resolve) => {
    child.once("message", (msg) => resolve(msg as ScriptToMagenta));
  });
}

describe("sdk IPC", () => {
  it("registers scripts and reports them over IPC", async () => {
    const child = forkScript("two-scripts.ts");
    try {
      const msg = await nextMessage(child);
      expect(msg.type).toBe("register");
      if (msg.type === "register") {
        const names = msg.scripts.map((s) => s.name).sort();
        expect(names).toEqual(["alpha", "beta"]);
        const alpha = msg.scripts.find((s) => s.name === "alpha");
        expect(alpha?.description).toBe("the alpha script");
        expect(alpha?.parameterSchema).toBeDefined();
      }
    } finally {
      child.kill();
    }
  });

  it("runner thread()/log() produce correct IPC and resolve on thread-result", async () => {
    const child = forkScript("log-then-thread.ts");
    const messages: ScriptToMagenta[] = [];
    try {
      // wait for register, then invoke
      const reg = await nextMessage(child);
      expect(reg.type).toBe("register");

      const collected: Promise<void> = new Promise((resolve) => {
        child.on("message", (raw) => {
          const msg = raw as ScriptToMagenta;
          messages.push(msg);
          if (msg.type === "create-thread") {
            const reply: MagentaToScript = {
              type: "thread-result",
              requestId: msg.requestId,
              result: { status: "ok", value: { answer: 42 } },
            };
            child.send(reply);
          }
          if (msg.type === "done") resolve();
        });
      });

      const invoke: MagentaToScript = {
        type: "run-script",
        scriptName: "worker",
        parameters: {},
      };
      child.send(invoke);

      await collected;

      const types = messages.map((m) => m.type);
      expect(types).toEqual(["log", "create-thread", "log", "done"]);
      const threadMsg = messages.find((m) => m.type === "create-thread");
      expect(
        threadMsg && threadMsg.type === "create-thread" && threadMsg.prompt,
      ).toBe("p");
    } finally {
      child.kill();
    }
  });

  it("test harness drives a runner in-process and feeds yields back", async () => {
    const { handle, donePromise } = runScript("sequential", {});

    const first = await handle.nextThread();
    expect(first.prompt).toBe("first prompt");
    first.yield({ value: "A" });

    const second = await handle.nextThread();
    expect(second.prompt).toBe("second using A");
    second.yield({ value: "B" });

    await donePromise;
    expect(handle.logs).toEqual(["starting", "done B"]);
  });
});
