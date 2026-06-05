import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type { ToolName, ToolRequestId } from "@magenta/core";
import { expect, it } from "vitest";
import { pollForToolResult, withDriver } from "../test/preamble.ts";
import type { ScriptInvocationId } from "./script-manager.ts";

async function setupScript(tmpDir: string, body: string): Promise<void> {
  // The SDK shim (.magenta/scripts/magenta-sdk) is created by ScriptManager's
  // ensureShim() at startup; the script imports through it.
  const scriptsDir = path.join(tmpDir, ".magenta", "scripts");
  await fs.mkdir(scriptsDir, { recursive: true });
  await fs.writeFile(path.join(scriptsDir, "foo.ts"), body);
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

it("ignores non-registering library files without stalling discovery", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await setupScript(tmpDir, FOO_SCRIPT);
        const scriptsDir = path.join(tmpDir, ".magenta", "scripts");
        await fs.writeFile(
          path.join(scriptsDir, "shared-lib.ts"),
          "export const helper = () => 42;\n",
        );
      },
    },
    async (driver) => {
      const scriptManager = driver.magenta.scriptManager;
      await pollUntil(
        () => scriptManager.getCatalog().some((s) => s.name === "foo"),
        8000,
      );
      expect(scriptManager.getCatalog().map((s) => s.name)).toEqual(["foo"]);
    },
  );
});

it("discovers scripts from the global ~/.magenta/scripts path", async () => {
  await withDriver(
    {
      setupHome: async (homeDir) => {
        const scriptsDir = path.join(homeDir, ".magenta", "scripts");
        await fs.mkdir(scriptsDir, { recursive: true });
        await fs.writeFile(path.join(scriptsDir, "foo.ts"), FOO_SCRIPT);
      },
    },
    async (driver) => {
      const scriptManager = driver.magenta.scriptManager;
      await pollUntil(() =>
        scriptManager.getCatalog().some((s) => s.name === "foo"),
      );
    },
  );
});

it("invokes a script that spawns a thread and resolves with the structured yield", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await setupScript(tmpDir, FOO_SCRIPT);
      },
    },
    async (driver) => {
      const scriptManager = driver.magenta.scriptManager;

      await pollUntil(() =>
        scriptManager.getCatalog().some((s) => s.name === "foo"),
      );

      expect(
        existsSync(
          path.join(
            driver.magenta.cwd,
            ".magenta",
            "scripts",
            "magenta-sdk",
            "index.ts",
          ),
        ),
      ).toBe(true);

      const id = scriptManager.invokeScript(
        "foo",
        { x: "thing" },
        { sandboxBypassed: false },
      ) as ScriptInvocationId;

      const stream =
        await driver.mockAnthropic.awaitPendingStreamWithText("work on thing");
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

      await pollUntil(() => {
        const inv = scriptManager.invocations.get(id);
        return inv?.status === "done";
      });

      const inv = scriptManager.invocations.get(id);
      if (!inv) throw new Error("invocation missing");
      expect(inv.threadIds.length).toBe(1);
      expect(inv.logs).toContain("starting");
      expect(inv.logs.some((l) => l.includes('"ok":true'))).toBe(true);
    },
  );
});

const CRASH_SCRIPT = `
import { registerScript } from "./magenta-sdk/index.ts";

registerScript(
  "foo",
  "throws after thread",
  { type: "object", properties: {}, required: [] },
  async (_params, _thread, log) => {
    log("starting");
    throw new Error("boom");
  },
);
`;

it("marks the invocation error when the runner throws", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await setupScript(tmpDir, CRASH_SCRIPT);
      },
    },
    async (driver) => {
      const scriptManager = driver.magenta.scriptManager;
      await pollUntil(() =>
        scriptManager.getCatalog().some((s) => s.name === "foo"),
      );

      const id = scriptManager.invokeScript(
        "foo",
        {},
        { sandboxBypassed: false },
      ) as ScriptInvocationId;

      await pollUntil(
        () => scriptManager.invocations.get(id)?.status === "error",
      );
      expect(scriptManager.invocations.get(id)?.status).toBe("error");
    },
  );
});

const LONG_LIVED_SCRIPT = `
import { registerScript } from "./magenta-sdk/index.ts";
import { spawn } from "node:child_process";

registerScript(
  "foo",
  "spawns a long-lived child",
  { type: "object", properties: {}, required: [] },
  async (_params, _thread, log) => {
    const child = spawn("sleep", ["120"], { detached: false });
    log("child " + child.pid);
    await new Promise((r) => setTimeout(r, 60000));
  },
);
`;

it("group-kills the subprocess tree on terminate", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await setupScript(tmpDir, LONG_LIVED_SCRIPT);
      },
    },
    async (driver) => {
      const scriptManager = driver.magenta.scriptManager;
      await pollUntil(() =>
        scriptManager.getCatalog().some((s) => s.name === "foo"),
      );

      const id = scriptManager.invokeScript(
        "foo",
        {},
        { sandboxBypassed: false },
      ) as ScriptInvocationId;

      await pollUntil(() =>
        (scriptManager.invocations.get(id)?.logs ?? []).some((l) =>
          l.startsWith("child "),
        ),
      );

      const inv = scriptManager.invocations.get(id);
      if (!inv) throw new Error("missing invocation");
      const childPid = inv.child.pid;
      const grandchildPid = Number(
        inv.logs.find((l) => l.startsWith("child "))!.slice("child ".length),
      );

      scriptManager.terminateAll();

      await pollUntil(() => {
        for (const pid of [childPid, grandchildPid]) {
          if (pid === undefined) continue;
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            // process gone
          }
        }
        return true;
      });
    },
  );
});

it("renders running invocations, logs, and spawned threads in the Scripts overview section", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await setupScript(tmpDir, FOO_SCRIPT);
      },
    },
    async (driver) => {
      await driver.showSidebar();
      const scriptManager = driver.magenta.scriptManager;
      await pollUntil(() =>
        scriptManager.getCatalog().some((s) => s.name === "foo"),
      );

      const id = scriptManager.invokeScript(
        "foo",
        { x: "thing" },
        { sandboxBypassed: false },
      ) as ScriptInvocationId;

      const stream =
        await driver.mockAnthropic.awaitPendingStreamWithText("work on thing");
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

      await pollUntil(
        () => scriptManager.invocations.get(id)?.status === "done",
      );

      await driver.magenta.command("threads-overview");

      await driver.assertDisplayBufferContains("# Scripts");
      await driver.assertDisplayBufferContains("foo");
      await driver.assertDisplayBufferContains("starting");

      const inv = scriptManager.invocations.get(id);
      if (!inv) throw new Error("missing invocation");

      // The script row starts collapsed; expand it to reveal the spawned thread
      // nested underneath.
      await driver.triggerDisplayBufferKeyOnContent("foo (done)", "=");
      await driver.assertDisplayBufferContains("yielded");
    },
  );
});

it("toggles sandbox bypass for the whole invocation from the script root row", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await setupScript(tmpDir, FOO_SCRIPT);
      },
    },
    async (driver) => {
      await driver.showSidebar();
      const scriptManager = driver.magenta.scriptManager;
      await pollUntil(() =>
        scriptManager.getCatalog().some((s) => s.name === "foo"),
      );

      const id = scriptManager.invokeScript(
        "foo",
        { x: "thing" },
        { sandboxBypassed: false },
      ) as ScriptInvocationId;

      const stream =
        await driver.mockAnthropic.awaitPendingStreamWithText("work on thing");
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

      await pollUntil(
        () => scriptManager.invocations.get(id)?.status === "done",
      );

      const inv = scriptManager.invocations.get(id);
      if (!inv) throw new Error("missing invocation");
      const threadId = inv.threadIds[0];
      expect(driver.magenta.chat.isSandboxBypassed(threadId)).toBe(false);

      await driver.magenta.command("threads-overview");
      await driver.assertDisplayBufferContains("foo (done)");
      // 🔒 indicates sandboxed; toggling with `t` flips the invocation flag.
      await driver.triggerDisplayBufferKeyOnContent("foo (done)", "t");

      await pollUntil(() => inv.sandboxBypassed === true);
      expect(driver.magenta.chat.isSandboxBypassed(threadId)).toBe(true);
    },
  );
});

it("expands and collapses the script row to show/hide spawned threads", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await setupScript(tmpDir, FOO_SCRIPT);
      },
    },
    async (driver) => {
      await driver.showSidebar();
      const scriptManager = driver.magenta.scriptManager;
      await pollUntil(() =>
        scriptManager.getCatalog().some((s) => s.name === "foo"),
      );

      const id = scriptManager.invokeScript(
        "foo",
        { x: "thing" },
        { sandboxBypassed: false },
      ) as ScriptInvocationId;

      const stream =
        await driver.mockAnthropic.awaitPendingStreamWithText("work on thing");
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

      await pollUntil(
        () => scriptManager.invocations.get(id)?.status === "done",
      );

      await driver.magenta.command("threads-overview");
      await driver.assertDisplayBufferContains("foo (done)");
      await driver.assertDisplayBufferDoesNotContain("yielded");

      await driver.triggerDisplayBufferKeyOnContent("foo (done)", "=");
      await driver.assertDisplayBufferContains("yielded");

      await driver.triggerDisplayBufferKeyOnContent("foo (done)", "=");
      await driver.assertDisplayBufferDoesNotContain("yielded");
    },
  );
});

it("surfaces a spawned thread's pending permission under a collapsed script row and approves it", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await setupScript(tmpDir, FOO_SCRIPT);
      },
    },
    async (driver) => {
      driver.mockSandbox.setState({
        status: "unsupported",
        reason: "disabled",
      });
      await driver.showSidebar();
      const scriptManager = driver.magenta.scriptManager;
      await pollUntil(() =>
        scriptManager.getCatalog().some((s) => s.name === "foo"),
      );

      const id = scriptManager.invokeScript(
        "foo",
        { x: "thing" },
        { sandboxBypassed: false },
      ) as ScriptInvocationId;

      const stream =
        await driver.mockAnthropic.awaitPendingStreamWithText("work on thing");
      // The spawned thread runs a command, which blocks on approval because the
      // sandbox is disabled and the invocation is not bypassed.
      stream.respond({
        stopReason: "tool_use",
        text: "running",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "bash-tool" as ToolRequestId,
              toolName: "bash_command" as ToolName,
              input: { command: "echo hi" },
            },
          },
        ],
      });

      await pollUntil(
        () => (scriptManager.invocations.get(id)?.threadIds.length ?? 0) > 0,
      );
      const inv = scriptManager.invocations.get(id);
      if (!inv) throw new Error("missing invocation");
      const threadId = inv.threadIds[0];

      await driver.magenta.command("threads-overview");

      // The script row is collapsed, but the pending permission must still
      // surface so the user is never blocked invisibly.
      await driver.assertDisplayBufferContains("foo (running)");
      await driver.assertDisplayBufferContains("May I run command");

      const thread = driver.magenta.chat.threadWrappers[threadId];
      if (thread.state !== "initialized")
        throw new Error("thread not initialized");
      expect(
        thread.thread.sandboxViolationHandler!.getPendingViolations().size,
      ).toBe(1);

      await driver.triggerDisplayBufferKeyOnContent("> YES", "<CR>");

      await pollUntil(
        () =>
          thread.thread.sandboxViolationHandler!.getPendingViolations().size ===
          0,
      );
    },
  );
});

it("lets an in-magenta agent trigger a script via run_script", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await setupScript(tmpDir, FOO_SCRIPT);
      },
    },
    async (driver) => {
      await driver.showSidebar();
      const scriptManager = driver.magenta.scriptManager;
      await pollUntil(() =>
        scriptManager.getCatalog().some((s) => s.name === "foo"),
      );

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

      await pollUntil(() => scriptManager.invocations.size > 0);
      const inv = [...scriptManager.invocations.values()][0];

      const stream =
        await driver.mockAnthropic.awaitPendingStreamWithText("work on thing");
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

      await pollUntil(() => inv.status === "done");
      expect(inv.scriptName).toBe("foo");
    },
  );
});

it("returns the script's parameter schema when run_script is called without parameters", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await setupScript(tmpDir, FOO_SCRIPT);
      },
    },
    async (driver) => {
      const scriptManager = driver.magenta.scriptManager;
      await pollUntil(() =>
        scriptManager.getCatalog().some((s) => s.name === "foo"),
      );

      await driver.inputMagentaText("what params does foo take?");
      driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "checking",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "disc-1" as ToolRequestId,
              toolName: "run_script" as ToolName,
              input: { scriptName: "foo" },
            },
          },
        ],
      });

      const result = await pollForToolResult(driver, "disc-1" as ToolRequestId);
      expect(result.result.status).toBe("ok");
      const text =
        result.result.status === "ok" ? result.result.value[0] : undefined;
      const schemaText = text && "text" in text ? text.text : "";
      expect(schemaText).toContain('"required"');
      // The discovery step must not start an invocation.
      expect(scriptManager.invocations.size).toBe(0);
    },
  );
});

it("seeds the invocation as bypassed when triggered from a sandbox-disabled thread", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await setupScript(tmpDir, FOO_SCRIPT);
      },
    },
    async (driver) => {
      await driver.showSidebar();
      const scriptManager = driver.magenta.scriptManager;
      await pollUntil(() =>
        scriptManager.getCatalog().some((s) => s.name === "foo"),
      );

      await driver.inputMagentaText("please run foo");
      driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      // Disable the sandbox (bypass) on the triggering thread before it calls
      // run_script.
      await driver.magenta.command("sandbox-bypass");

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

      await pollUntil(() => scriptManager.invocations.size > 0);
      const inv = [...scriptManager.invocations.values()][0];
      expect(inv.sandboxBypassed).toBe(true);
    },
  );
});
