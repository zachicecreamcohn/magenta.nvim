import { describe, expect, it, vi } from "vitest";
import type { ThreadManager } from "../capabilities/thread-manager.ts";
import type { ThreadId } from "../chat-types.ts";
import type { ContainerConfig, ProvisionResult } from "../container/types.ts";
import type { ProviderToolResult } from "../providers/provider-types.ts";
import type { ToolRequestId } from "../tool-types.ts";
import type { NvimCwd, UnresolvedFilePath } from "../utils/files.ts";
import type { Result } from "../utils/result.ts";
import * as SpawnSubagents from "./spawn-subagents.ts";

type MockThreadManager = ThreadManager & {
  simulateYield(threadId: ThreadId, result: Result<string>): void;
};

function createMockThreadManager(
  overrides: Partial<ThreadManager> = {},
): MockThreadManager {
  const results = new Map<string, { status: "done"; result: Result<string> }>();
  const callbacks = new Map<string, Array<() => void>>();

  const manager: MockThreadManager = {
    spawnThread: vi.fn().mockResolvedValue("thread-1" as ThreadId),
    onThreadYielded: vi.fn((threadId: ThreadId, callback: () => void) => {
      let cbs = callbacks.get(threadId);
      if (!cbs) {
        cbs = [];
        callbacks.set(threadId, cbs);
      }
      cbs.push(callback);
      // If already yielded, fire immediately
      if (results.has(threadId)) {
        callback();
      }
    }),
    getThreadResult: vi.fn((threadId: ThreadId) => {
      return results.get(threadId) ?? { status: "pending" as const };
    }),
    simulateYield(threadId: ThreadId, result: Result<string>) {
      results.set(threadId, { status: "done", result });
      const cbs = callbacks.get(threadId);
      if (cbs) {
        for (const cb of cbs) {
          cb();
        }
      }
    },
    ...overrides,
  };
  return manager;
}

function makeRequest(input: SpawnSubagents.Input): SpawnSubagents.ToolRequest {
  return {
    id: "tool_1" as ToolRequestId,
    toolName: "spawn_subagents" as const,
    input,
  };
}

async function getResultText(invocation: {
  promise: Promise<ProviderToolResult>;
}): Promise<string> {
  const { result } = await invocation.promise;
  if (result.status === "ok") {
    return (result.value[0] as { type: "text"; text: string }).text;
  }
  return result.error;
}

describe("spawn-subagents unit tests", () => {
  it("single agent blocks and returns result", async () => {
    const threadManager = createMockThreadManager();

    const invocation = SpawnSubagents.execute(
      makeRequest({ agents: [{ prompt: "do something" }] }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    // Wait for spawn, then simulate yield
    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalled();
    });
    threadManager.simulateYield("thread-1" as ThreadId, {
      status: "ok",
      value: "the answer",
    });

    const text = await getResultText(invocation);
    expect(text).toContain("the answer");
  });

  it("single agent returns error when thread fails", async () => {
    const threadManager = createMockThreadManager();

    const invocation = SpawnSubagents.execute(
      makeRequest({ agents: [{ prompt: "do something" }] }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalled();
    });
    threadManager.simulateYield("thread-1" as ThreadId, {
      status: "error",
      error: "crashed",
    });

    const text = await getResultText(invocation);
    expect(text).toContain("crashed");
    expect(text).toContain("Failed: 1");
  });

  it("sets progress.threadId after spawn", async () => {
    const threadManager = createMockThreadManager();
    const invocation = SpawnSubagents.execute(
      makeRequest({ agents: [{ prompt: "do something" }] }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalled();
    });

    const state = invocation.progress.elements[0].state;
    expect(state.status).toBe("spawned");
    if (state.status === "spawned") {
      expect(state.threadId).toBe("thread-1");
    }

    threadManager.simulateYield("thread-1" as ThreadId, {
      status: "ok",
      value: "done",
    });
    await invocation.promise;
  });

  it("returns error when spawnThread throws", async () => {
    const threadManager = createMockThreadManager({
      spawnThread: vi.fn().mockRejectedValue(new Error("spawn failed")),
    });

    const invocation = SpawnSubagents.execute(
      makeRequest({ agents: [{ prompt: "do something" }] }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    const text = await getResultText(invocation);
    expect(text).toContain("spawn failed");
  });

  it("maps agentType to correct threadType", async () => {
    const cases: Array<{
      agentType: SpawnSubagents.SubagentEntry["agentType"];
      expectedThreadType: string;
    }> = [
      { agentType: "fast", expectedThreadType: "subagent" },
      { agentType: "explore", expectedThreadType: "subagent" },
      { agentType: undefined, expectedThreadType: "subagent" },
    ];

    for (const { agentType, expectedThreadType } of cases) {
      const threadManager = createMockThreadManager();
      const entry: SpawnSubagents.SubagentEntry = { prompt: "do something" };
      if (agentType !== undefined) {
        entry.agentType = agentType;
      }
      SpawnSubagents.execute(makeRequest({ agents: [entry] }), {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      });

      await vi.waitFor(() => {
        expect(threadManager.spawnThread).toHaveBeenCalled();
      });

      expect(threadManager.spawnThread).toHaveBeenCalledWith(
        expect.objectContaining({ threadType: expectedThreadType }),
      );
    }
  });

  it("processes multiple agents in parallel and returns summary", async () => {
    let callCount = 0;
    const threadManager = createMockThreadManager({
      spawnThread: vi.fn(() => {
        callCount++;
        return Promise.resolve(`thread_${callCount}` as ThreadId);
      }),
    });

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [{ prompt: "task 1" }, { prompt: "task 2" }],
      }),
      {
        threadManager,
        threadId: "parent_thread" as ThreadId,
        maxConcurrentSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalledTimes(2);
    });
    threadManager.simulateYield("thread_1" as ThreadId, {
      status: "ok",
      value: "element completed",
    });
    threadManager.simulateYield("thread_2" as ThreadId, {
      status: "ok",
      value: "element completed",
    });

    const text = await getResultText(invocation);
    expect(text).toContain("Total: 2");
    expect(text).toContain("Successful: 2");
    expect(text).toContain("Failed: 0");
  });

  it("handles element errors and continues", async () => {
    let callCount = 0;
    const threadManager = createMockThreadManager({
      spawnThread: vi.fn(() => {
        callCount++;
        return Promise.resolve(`thread_${callCount}` as ThreadId);
      }),
    });

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [{ prompt: "task 1" }, { prompt: "task 2" }],
      }),
      {
        threadManager,
        threadId: "parent_thread" as ThreadId,
        maxConcurrentSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalledTimes(2);
    });
    threadManager.simulateYield("thread_1" as ThreadId, {
      status: "error",
      error: "something broke",
    });
    threadManager.simulateYield("thread_2" as ThreadId, {
      status: "ok",
      value: "success",
    });

    const text = await getResultText(invocation);
    expect(text).toContain("Successful: 1");
    expect(text).toContain("Failed: 1");
  });

  it("respects maxConcurrentSubagents", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const spawnDeferreds: Array<{ resolve: (value: ThreadId) => void }> = [];
    let spawnCount = 0;

    const threadManager = createMockThreadManager({
      spawnThread: vi.fn(() => {
        concurrent++;
        spawnCount++;
        if (concurrent > maxConcurrent) {
          maxConcurrent = concurrent;
        }
        const id = `thread_${spawnCount}` as ThreadId;
        return new Promise<ThreadId>((resolve) => {
          spawnDeferreds.push({
            resolve: () => {
              concurrent--;
              resolve(id);
            },
          });
        });
      }),
    });

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [
          { prompt: "task 1" },
          { prompt: "task 2" },
          { prompt: "task 3" },
        ],
      }),
      {
        threadManager,
        threadId: "parent_thread" as ThreadId,
        maxConcurrentSubagents: 2,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    // Only 2 should be in flight at once
    await vi.waitFor(() => expect(spawnDeferreds.length).toBe(2));
    expect(maxConcurrent).toBe(2);

    // Resolve first spawn, which should allow 3rd to start
    spawnDeferreds[0].resolve("thread_1" as ThreadId);
    await vi.waitFor(() => expect(spawnDeferreds.length).toBe(3));

    // Resolve remaining spawns
    spawnDeferreds[1].resolve("thread_2" as ThreadId);
    spawnDeferreds[2].resolve("thread_3" as ThreadId);

    // Now all 3 are spawned, simulate yields
    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalledTimes(3);
    });
    threadManager.simulateYield("thread_1" as ThreadId, {
      status: "ok",
      value: "done1",
    });
    threadManager.simulateYield("thread_2" as ThreadId, {
      status: "ok",
      value: "done2",
    });
    threadManager.simulateYield("thread_3" as ThreadId, {
      status: "ok",
      value: "done3",
    });

    const { result } = await invocation.promise;
    expect(result.status).toBe("ok");
    expect(maxConcurrent).toBe(2);
  });

  it("abort stops processing", async () => {
    const spawnDeferreds: Array<{ resolve: (value: ThreadId) => void }> = [];

    const threadManager = createMockThreadManager({
      spawnThread: vi.fn(
        () =>
          new Promise<ThreadId>((resolve) => {
            spawnDeferreds.push({ resolve });
          }),
      ),
    });

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [{ prompt: "task 1" }, { prompt: "task 2" }],
      }),
      {
        threadManager,
        threadId: "parent_thread" as ThreadId,
        maxConcurrentSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => expect(spawnDeferreds.length).toBe(2));
    invocation.abort();

    spawnDeferreds[0].resolve("thread_1" as ThreadId);
    spawnDeferreds[1].resolve("thread_2" as ThreadId);

    const { result } = await invocation.promise;
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("aborted");
    }
  });

  it("passes contextFiles to spawnThread", async () => {
    const spawnThread = vi.fn(() => Promise.resolve("thread_1" as ThreadId));
    const threadManager = createMockThreadManager({
      spawnThread,
    });

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [
          {
            prompt: "task 1",
            contextFiles: ["/some/file.ts" as UnresolvedFilePath],
          },
        ],
      }),
      {
        threadManager,
        threadId: "parent_thread" as ThreadId,
        maxConcurrentSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(spawnThread).toHaveBeenCalled();
    });
    threadManager.simulateYield("thread_1" as ThreadId, {
      status: "ok",
      value: "done",
    });

    await invocation.promise;
    expect(spawnThread).toHaveBeenCalledWith(
      expect.objectContaining({
        contextFiles: ["/some/file.ts"],
      }),
    );
  });

  it("validation rejects empty agents array", () => {
    const result = SpawnSubagents.validateInput({ agents: [] });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("empty");
    }
  });

  it("validation rejects missing prompt", () => {
    const result = SpawnSubagents.validateInput({
      agents: [{ notPrompt: "test" }],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("prompt");
    }
  });

  it("validation accepts custom agentType strings", () => {
    const result = SpawnSubagents.validateInput({
      agents: [{ prompt: "test", agentType: "my-custom-agent" }],
    });
    expect(result.status).toBe("ok");
  });

  it("validation rejects non-string agentType", () => {
    const result = SpawnSubagents.validateInput({
      agents: [{ prompt: "test", agentType: 123 }],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("agentType");
    }
  });

  it("validation rejects non-array agents", () => {
    const result = SpawnSubagents.validateInput({ agents: "not-an-array" });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("array");
    }
  });

  it("validation rejects non-string contextFiles items", () => {
    const result = SpawnSubagents.validateInput({
      agents: [{ prompt: "test", contextFiles: [123] }],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("contextFiles");
    }
  });

  it("validation rejects non-string branch", () => {
    const result = SpawnSubagents.validateInput({
      agents: [{ prompt: "test", branch: 123 }],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("branch");
    }
  });

  it("abort during Phase 2 (waiting for yields) returns aborted error", async () => {
    const threadManager = createMockThreadManager();

    const invocation = SpawnSubagents.execute(
      makeRequest({ agents: [{ prompt: "do something" }] }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    // Wait for spawn to complete (Phase 1 done)
    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalled();
    });

    // Now we're in Phase 2 (waiting for yields). Abort here.
    invocation.abort();

    // Simulate the yield after abort - it should not matter
    threadManager.simulateYield("thread-1" as ThreadId, {
      status: "ok",
      value: "too late",
    });

    const { result } = await invocation.promise;
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("aborted");
    }
  });
});

describe("spawn-subagents docker provisioning", () => {
  const containerConfig: ContainerConfig = {
    dockerfile: "Dockerfile",
    workspacePath: "/workspace",
    installCommand: "npm install",
  };

  const provisionResult: ProvisionResult = {
    containerName: "magenta-test-abc123",
    tempDir: "/tmp/magenta-dev-containers/magenta-test-abc123",
    imageName: "magenta-dev-test",
    startSha: "abc123",
    workerBranch: "magenta/worker-abc123",
  };

  it("updates provisioning progress during docker provisioning", async () => {
    const threadManager = createMockThreadManager();
    const requestRender = vi.fn();

    const provision = vi.fn(
      (opts: {
        repoPath: string;
        baseBranch?: string;
        containerConfig: ContainerConfig;
        onProgress?: (message: string) => void;
      }) => {
        opts.onProgress?.("Cloning repository...");
        opts.onProgress?.("Building Docker image...");
        opts.onProgress?.("Starting container...");
        return Promise.resolve(provisionResult);
      },
    );

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [
          {
            prompt: "do docker work",
            agentType: "docker",
            branch: "feature-branch",
          },
        ],
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        requestRender,
        cwd: "/test" as NvimCwd,
        agents: {},
        containerProvisioner: { containerConfig, provision },
      },
    );

    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalled();
    });
    threadManager.simulateYield("thread-1" as ThreadId, {
      status: "ok",
      value: "done",
    });

    await invocation.promise;
    expect(provision).toHaveBeenCalledWith(
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
  });

  it("returns error when branch is missing for docker agentType", async () => {
    const threadManager = createMockThreadManager();

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [{ prompt: "do docker work", agentType: "docker" }],
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
        containerProvisioner: {
          containerConfig,
          provision: vi.fn(),
        },
      },
    );

    const text = await getResultText(invocation);
    expect(text).toContain("branch parameter is required");
  });

  it("returns error when containerProvisioner is not configured", async () => {
    const threadManager = createMockThreadManager();

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [
          {
            prompt: "do docker work",
            agentType: "docker",
            branch: "feature-branch",
          },
        ],
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    const text = await getResultText(invocation);
    expect(text).toContain("Docker environment is not configured");
  });

  it("spawns docker_root thread with provision result", async () => {
    const threadManager = createMockThreadManager();

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [
          {
            prompt: "do docker work",
            agentType: "docker",
            branch: "feature-branch",
          },
        ],
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
        containerProvisioner: {
          containerConfig,
          provision: vi.fn().mockResolvedValue(provisionResult),
        },
      },
    );

    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalled();
    });
    threadManager.simulateYield("thread-1" as ThreadId, {
      status: "ok",
      value: "done",
    });

    await invocation.promise;
    expect(threadManager.spawnThread).toHaveBeenCalledWith(
      expect.objectContaining({
        threadType: "docker_root",
        dockerSpawnConfig: expect.objectContaining({
          baseBranch: "feature-branch",
          containerName: provisionResult.containerName,
          workerBranch: provisionResult.workerBranch,
        }),
      }),
    );
  });

  it("docker_unsupervised agentType sets supervised=true", async () => {
    const threadManager = createMockThreadManager();

    SpawnSubagents.execute(
      makeRequest({
        agents: [
          {
            prompt: "do docker work",
            agentType: "docker_unsupervised",
            branch: "feature-branch",
          },
        ],
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
        containerProvisioner: {
          containerConfig,
          provision: vi.fn().mockResolvedValue(provisionResult),
        },
      },
    );

    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalled();
    });

    expect(threadManager.spawnThread).toHaveBeenCalledWith(
      expect.objectContaining({
        dockerSpawnConfig: expect.objectContaining({ supervised: true }),
      }),
    );
  });

  it("returns spawn-error when provision() rejects", async () => {
    const threadManager = createMockThreadManager();

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [
          {
            prompt: "do docker work",
            agentType: "docker",
            branch: "feature-branch",
          },
        ],
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
        containerProvisioner: {
          containerConfig,
          provision: vi
            .fn()
            .mockRejectedValue(new Error("Docker daemon not running")),
        },
      },
    );

    const text = await getResultText(invocation);
    expect(text).toContain("Docker daemon not running");
    expect(text).toContain("Failed: 1");

    const state = invocation.progress.elements[0].state;
    expect(state.status).toBe("spawn-error");
    if (state.status === "spawn-error") {
      expect(state.error).toContain("Docker daemon not running");
    }
  });

  it("mixed agents: docker and non-docker in parallel", async () => {
    let callCount = 0;
    const threadManager = createMockThreadManager({
      spawnThread: vi.fn(() => {
        callCount++;
        return Promise.resolve(`thread_${callCount}` as ThreadId);
      }),
    });

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [
          { prompt: "non-docker task", agentType: "fast" },
          {
            prompt: "docker task",
            agentType: "docker",
            branch: "main",
          },
        ],
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
        containerProvisioner: {
          containerConfig,
          provision: vi.fn().mockResolvedValue(provisionResult),
        },
      },
    );

    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalledTimes(2);
    });
    threadManager.simulateYield("thread_1" as ThreadId, {
      status: "ok",
      value: "done",
    });
    threadManager.simulateYield("thread_2" as ThreadId, {
      status: "ok",
      value: "done",
    });

    const text = await getResultText(invocation);
    expect(text).toContain("Total: 2");
    expect(text).toContain("Successful: 2");
  });
});
