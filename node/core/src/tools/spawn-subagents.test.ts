import { describe, expect, it, vi } from "vitest";
import type { ThreadManager } from "../capabilities/thread-manager.ts";
import type { ThreadId } from "../chat-types.ts";
import type { ContainerConfig, ProvisionResult } from "../container/types.ts";
import type { ProviderToolResult } from "../providers/provider-types.ts";
import type { ToolRequestId } from "../tool-types.ts";
import type { NvimCwd, UnresolvedFilePath } from "../utils/files.ts";
import type { Result } from "../utils/result.ts";
import * as SpawnSubagents from "./spawn-subagents.ts";

function createMockThreadManager(
  overrides: Partial<ThreadManager> = {},
): ThreadManager {
  return {
    spawnThread: vi.fn().mockResolvedValue("thread-1" as ThreadId),
    waitForThread: vi.fn().mockResolvedValue({ status: "ok", value: "done" }),
    yieldResult: vi.fn(),
    ...overrides,
  };
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
    const threadManager = createMockThreadManager({
      waitForThread: vi.fn().mockResolvedValue({
        status: "ok",
        value: "the answer",
      }),
    });

    const invocation = SpawnSubagents.execute(
      makeRequest({ agents: [{ prompt: "do something" }] }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
      },
    );

    const text = await getResultText(invocation);
    expect(text).toContain("the answer");
    expect(threadManager.waitForThread).toHaveBeenCalled();
  });

  it("single agent returns error when thread fails", async () => {
    const threadManager = createMockThreadManager({
      waitForThread: vi.fn().mockResolvedValue({
        status: "error",
        error: "crashed",
      }),
    });

    const invocation = SpawnSubagents.execute(
      makeRequest({ agents: [{ prompt: "do something" }] }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
      },
    );

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
      },
    );

    await invocation.promise;
    const state = invocation.progress.elements[0].state;
    expect(state.status).toBe("completed");
    if (state.status === "completed") {
      expect(state.threadId).toBe("thread-1");
    }
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
      { agentType: "fast", expectedThreadType: "subagent_fast" },
      { agentType: "explore", expectedThreadType: "subagent_explore" },
      { agentType: undefined, expectedThreadType: "subagent_default" },
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
      waitForThread: vi.fn(() =>
        Promise.resolve({
          status: "ok" as const,
          value: "element completed",
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
      },
    );

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
      waitForThread: vi.fn((threadId: ThreadId) => {
        if (threadId === ("thread_1" as ThreadId)) {
          return Promise.resolve({
            status: "error" as const,
            error: "something broke",
          });
        }
        return Promise.resolve({ status: "ok" as const, value: "success" });
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
      },
    );

    const text = await getResultText(invocation);
    expect(text).toContain("Successful: 1");
    expect(text).toContain("Failed: 1");
  });

  it("respects maxConcurrentSubagents", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const deferreds: Array<{ resolve: (value: ThreadId) => void }> = [];
    const waitDeferreds = new Map<
      string,
      { resolve: (value: Result<string>) => void }
    >();

    const threadManager = createMockThreadManager({
      spawnThread: vi.fn(() => {
        concurrent++;
        if (concurrent > maxConcurrent) {
          maxConcurrent = concurrent;
        }
        return new Promise<ThreadId>((resolve) => {
          deferreds.push({ resolve });
        });
      }),
      waitForThread: vi.fn(
        (threadId: ThreadId) =>
          new Promise<Result<string>>((resolve) => {
            waitDeferreds.set(threadId as string, { resolve });
          }),
      ),
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
      },
    );

    await vi.waitFor(() => expect(deferreds.length).toBe(2));
    expect(maxConcurrent).toBe(2);

    concurrent--;
    deferreds[0].resolve("thread_1" as ThreadId);
    await vi.waitFor(() => expect(waitDeferreds.has("thread_1")).toBe(true));
    waitDeferreds.get("thread_1")!.resolve({ status: "ok", value: "done1" });

    await vi.waitFor(() => expect(deferreds.length).toBe(3));

    concurrent--;
    deferreds[1].resolve("thread_2" as ThreadId);
    await vi.waitFor(() => expect(waitDeferreds.has("thread_2")).toBe(true));
    waitDeferreds.get("thread_2")!.resolve({ status: "ok", value: "done2" });

    concurrent--;
    deferreds[2].resolve("thread_3" as ThreadId);
    await vi.waitFor(() => expect(waitDeferreds.has("thread_3")).toBe(true));
    waitDeferreds.get("thread_3")!.resolve({ status: "ok", value: "done3" });

    const { result } = await invocation.promise;
    expect(result.status).toBe("ok");
    expect(maxConcurrent).toBe(2);
  });

  it("abort stops processing", async () => {
    const spawnDeferreds: Array<{ resolve: (value: ThreadId) => void }> = [];
    const waitDeferreds = new Map<
      string,
      { resolve: (value: Result<string>) => void }
    >();

    const threadManager = createMockThreadManager({
      spawnThread: vi.fn(
        () =>
          new Promise<ThreadId>((resolve) => {
            spawnDeferreds.push({ resolve });
          }),
      ),
      waitForThread: vi.fn(
        (threadId: ThreadId) =>
          new Promise<Result<string>>((resolve) => {
            waitDeferreds.set(threadId as string, { resolve });
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
      },
    );

    await vi.waitFor(() => expect(spawnDeferreds.length).toBe(2));
    invocation.abort();

    spawnDeferreds[0].resolve("thread_1" as ThreadId);
    spawnDeferreds[1].resolve("thread_2" as ThreadId);

    await vi.waitFor(() => expect(waitDeferreds.has("thread_1")).toBe(true));
    waitDeferreds.get("thread_1")!.resolve({ status: "ok", value: "done" });
    await vi.waitFor(() => expect(waitDeferreds.has("thread_2")).toBe(true));
    waitDeferreds.get("thread_2")!.resolve({ status: "ok", value: "done" });

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
      waitForThread: vi.fn(() =>
        Promise.resolve({ status: "ok" as const, value: "done" }),
      ),
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
      },
    );

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

  it("validation rejects invalid agentType", () => {
    const result = SpawnSubagents.validateInput({
      agents: [{ prompt: "test", agentType: "invalid" }],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("agentType");
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
        containerProvisioner: { containerConfig, provision },
      },
    );

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
        containerProvisioner: {
          containerConfig,
          provision: vi.fn().mockResolvedValue(provisionResult),
        },
      },
    );

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

  it("mixed agents: docker and non-docker in parallel", async () => {
    let callCount = 0;
    const threadManager = createMockThreadManager({
      spawnThread: vi.fn(() => {
        callCount++;
        return Promise.resolve(`thread_${callCount}` as ThreadId);
      }),
      waitForThread: vi.fn(() =>
        Promise.resolve({ status: "ok" as const, value: "done" }),
      ),
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
        containerProvisioner: {
          containerConfig,
          provision: vi.fn().mockResolvedValue(provisionResult),
        },
      },
    );

    const text = await getResultText(invocation);
    expect(text).toContain("Total: 2");
    expect(text).toContain("Successful: 2");
  });
});
