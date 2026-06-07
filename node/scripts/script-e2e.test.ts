import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolName, ToolRequestId } from "@magenta/core";
import { expect, it } from "vitest";
import { withDriver } from "../test/preamble.ts";

async function setupScript(tmpDir: string, body: string): Promise<void> {
  const scriptsDir = path.join(tmpDir, ".magenta", "scripts");
  await fs.mkdir(scriptsDir, { recursive: true });
  await fs.writeFile(path.join(scriptsDir, "index.ts"), body);
}

async function pollUntil(fn: () => boolean, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("pollUntil timed out");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

const FOO_SCRIPT = `
import { registerScript } from "./magenta-sdk/index.ts";

registerScript(
  "foo",
  "does foo",
  { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
  async (params, thread, log) => {
    log("starting");
    const r = await thread("work on " + params.x, {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    });
    log("got " + JSON.stringify(r));
  },
);
`;

it("end-to-end: agent invokes run_script, subprocess spawns a thread, yields, and the UI reflects it", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await setupScript(tmpDir, FOO_SCRIPT);
      },
    },
    async (driver) => {
      await driver.showSidebar();
      const scriptManager = driver.magenta.scriptManager;

      // 1. Script is detected and registered in the catalog.
      await pollUntil(() =>
        scriptManager.getCatalog().some((s) => s.name === "foo"),
      );

      // 2. The in-magenta agent invokes the script via run_script.
      await driver.inputMagentaText("please run foo");
      driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "running the script",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "run-1" as ToolRequestId,
              toolName: "run_script" as ToolName,
              input: { scriptName: "foo", parameters: { x: "thing" } },
            },
          },
        ],
      });

      // 3. The subprocess runs and its thread() spawns a real thread that hits
      //    the mock provider.
      await pollUntil(() => scriptManager.invocations.size > 0);
      const inv = [...scriptManager.invocations.values()][0];

      const stream =
        await driver.mockAnthropic.awaitPendingStreamWithText("work on thing");

      // 4. The spawned thread yields a schema-matching structured result.
      stream.respond({
        stopReason: "tool_use",
        text: "done",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-1" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: { ok: true },
            },
          },
        ],
      });

      // 5. The runner completes.
      await pollUntil(() => inv.status === "done");
      expect(inv.scriptName).toBe("foo");
      expect(inv.threadIds.length).toBe(1);
      expect(inv.logs).toContain("starting");
      expect(inv.logs.some((l) => l.includes('"ok":true'))).toBe(true);

      // 6. The Scripts section reflects the invocation and its log line.
      await driver.magenta.command("threads-overview");
      await driver.assertDisplayBufferContains("# Scripts");
      await driver.assertDisplayBufferContains("foo (done)");
      await driver.assertDisplayBufferContains("starting");

      // 7. Expanding the script row reveals a link to the yielded spawned thread.
      await driver.assertDisplayBufferDoesNotContain("yielded");
      await driver.triggerDisplayBufferKeyOnContent("foo (done)", "=");
      await driver.assertDisplayBufferContains("yielded");
    },
  );
});
