import { expect, it } from "vitest";
import type { ThreadId } from "../chat-types.ts";
import type { MockStream } from "../providers/mock-anthropic-client.ts";
import { shellResult } from "../test/fakes.ts";
import { type Harness, withHarness } from "../test/harness.ts";
import type { ToolName, ToolRequestId } from "../tool-types.ts";
import type { BashProgress } from "../tools/bashCommand.ts";
import type { SpawnSubagentsProgress } from "../tools/spawn-subagents.ts";
import { pollUntil } from "../utils/async.ts";
import {
  globalState,
  type JsonValue,
  type ProtocolThreadState,
  sessionState,
  threadState,
} from "./state.ts";

// Every tool's progress crosses the boundary as data.
type AssertJson<T extends JsonValue> = T;
export type ToolProgressIsJson = [
  AssertJson<BashProgress>,
  AssertJson<SpawnSubagentsProgress>,
];

function roundTrips(value: unknown) {
  expect(JSON.parse(JSON.stringify(value))).toEqual(value);
}

function project(h: Harness, id: ThreadId): ProtocolThreadState {
  const record = h.session.getThread(id);
  if (record?.state !== "initialized") throw new Error("not initialized");
  const state = threadState(record.thread, record.compactor, h.session);
  roundTrips(state);
  roundTrips(sessionState(h.session, undefined));
  roundTrips(globalState(h.session));
  return state;
}

function respondTool(
  stream: MockStream,
  id: string,
  toolName: string,
  input: unknown,
) {
  stream.respond({
    stopReason: "tool_use",
    text: "working",
    toolRequests: [
      {
        status: "ok",
        value: {
          id: id as ToolRequestId,
          toolName: toolName as ToolName,
          input,
        },
      },
    ],
  });
}

it("projects tools, context, edits and compaction as serializable thread state", () =>
  withHarness({ files: { "/project/a.txt": "hello\n" } }, async (h) => {
    const { id, thread } = await h.createRoot();
    const done = h.send(thread, "look at @file:a.txt");
    respondTool(await h.nextStream(), "bash1", "bash_command", {
      command: "slow",
    });
    await pollUntil(() => {
      if (!h.shell.pending.length) throw new Error("waiting for shell");
    });
    const running = project(h, id);
    expect(running.run.type).toBe("running");
    expect(running.busy).toBe(true);
    expect(running.tools["bash1" as ToolRequestId]).toMatchObject({
      status: "running",
      progress: { liveOutput: [] },
    });
    expect(running.contextFiles.map((f) => f.absFilePath)).toEqual([
      "/project/a.txt",
    ]);
    expect(Object.keys(running.contextDeliveries)).not.toHaveLength(0);

    h.shell.pending[0]?.result.resolve(shellResult({ stdout: "hi" }));
    respondTool(await h.nextStream(), "edl1", "edl", {
      script: 'file `/project/a.txt`\nnarrow /hello/\nreplace "bye"',
    });
    (await h.nextStream()).respond({
      stopReason: "end_turn",
      text: "done",
      toolRequests: [],
    });
    await done;

    const settled = project(h, id);
    expect(settled.run).toMatchObject({
      type: "idle",
      lastResult: { type: "completed" },
    });
    expect(settled.tools["bash1" as ToolRequestId]).toMatchObject({
      status: "done",
      structuredResult: { toolName: "bash_command" },
    });
    expect(settled.tools["edl1" as ToolRequestId]?.status).toBe("done");
    expect(settled.editedFileGroups[0]?.files).toEqual([
      { path: "/project/a.txt", snapshot: "hello\n", content: "bye\n" },
    ]);
    expect(settled.messages.length).toBeGreaterThan(0);

    const compacting = h.send(thread, "@compact");
    const chunk = await h.nextStream();
    expect(project(h, id).compaction.current).toBeDefined();
    respondTool(chunk, "sum1", "edl", {
      script: "file `/summary.md`\nselect bof-eof\nreplace <<S\n# Summary\nS",
    });
    respondTool(await h.nextStream(), "y1", "yield_to_parent", {
      result: "wrote /summary.md",
    });
    (await h.nextStream()).respond({
      stopReason: "end_turn",
      text: "ready",
      toolRequests: [],
    });
    await compacting;
    const compacted = project(h, id);
    expect(compacted.compaction.current).toBeUndefined();
    expect(compacted.compaction.runs.map((r) => r.type)).toEqual(["done"]);
  }));

it("lists pending approvals without closures", () =>
  withHarness({}, async (h) => {
    const { id } = await h.createRoot();
    const approvals = h.session.approvalsFor(id);
    const settled = [
      approvals.promptForWriteApproval("/etc/x"),
      approvals.promptForNetworkAccess({ host: "example.com", port: 443 }),
      approvals.promptForApproval("rm -rf /", async () =>
        shellResult({ exitCode: 0 }),
      ),
      approvals.addViolation(
        {
          command: "curl",
          violations: [
            { line: "deny(12) net", timestamp: new Date() },
            { line: "deny(13) net", timestamp: new Date() },
          ],
          stderr: "blocked",
          result: shellResult({ exitCode: 1 }),
        },
        async () => shellResult({ exitCode: 0 }),
      ),
    ].map((p) => p.catch(() => undefined));
    const state = sessionState(h.session, undefined);
    roundTrips(state);
    expect(state.pendingApprovals.map((a) => a.prompt)).toEqual([
      { kind: "write-approval", absPath: "/etc/x" },
      { kind: "network-access", host: "example.com", port: 443 },
      { kind: "approval-prompt", command: "rm -rf /" },
      {
        kind: "violation",
        command: "curl",
        violations: [{ line: "deny(*) net", count: 2 }],
        stderr: "blocked",
      },
    ]);
    expect(state.pendingApprovals.every((a) => a.threadId === id)).toBe(true);
    h.session.rejectAll(id);
    await Promise.all(settled);
  }));

it("projects a failed thread creation as an error message", () =>
  withHarness({}, async (h) => {
    h.host.intercept = () => Promise.reject(new Error("no docker"));
    await expect(h.session.createRootThread()).rejects.toThrow("no docker");
    const state = sessionState(h.session, undefined);
    roundTrips(state);
    expect(state.threads).toEqual([
      expect.objectContaining({
        state: "error",
        error: { message: "no docker" },
      }),
    ]);
  }));
