import { describe, it, expect, vi } from "vitest";
import * as SpawnSubagent from "./spawn-subagent.ts";
import type { ThreadManager } from "../capabilities/thread-manager.ts";
import type { ThreadId } from "../chat-types.ts";
import type { ToolRequestId } from "../tool-types.ts";
import type { NvimCwd } from "../utils/files.ts";
import type { ProviderToolResult } from "../providers/provider-types.ts";
import type { ContainerConfig, ProvisionResult } from "../container/types.ts";

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

function makeRequest(input: SpawnSubagent.Input): SpawnSubagent.ToolRequest {
  return {
    id: "tool_1" as ToolRequestId,
    toolName: "spawn_subagent" as const,
    input,
  };
}

async function getResultText(invocation: {
  promise: Promise<ProviderToolResult>;
}): Promise<string> {
  const result = await invocation.promise;
  if (result.result.status === "ok") {
    return (result.result.value[0] as { type: "text"; text: string }).text;
  }
  return result.result.error;
}

describe("spawn-subagent unit tests", () => {
  it("non-blocking returns immediately with threadId", async () => {
    const threadManager = createMockThreadManager();
    const invocation = SpawnSubagent.execute(
      makeRequest({ prompt: "do something", blocking: false }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
      },
    );

    const text = await getResultText(invocation);
    expect(text).toContain("Sub-agent started with threadId: thread-1");
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(threadManager.waitForThread).not.toHaveBeenCalled();
  });

  it("blocking waits for completion and returns result", async () => {
    const threadManager = createMockThreadManager({
      waitForThread: vi.fn().mockResolvedValue({
        status: "ok",
        value: "the answer",
      }),
    });

    const invocation = SpawnSubagent.execute(
      makeRequest({ prompt: "do something", blocking: true }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
      },
    );

    const text = await getResultText(invocation);
    expect(text).toContain("completed");
    expect(text).toContain("the answer");
  });

  it("blocking returns error when thread fails", async () => {
    const threadManager = createMockThreadManager({
      waitForThread: vi.fn().mockResolvedValue({
        status: "error",
        error: "crashed",
      }),
    });

    const invocation = SpawnSubagent.execute(
      makeRequest({ prompt: "do something", blocking: true }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
      },
    );

    const result = await invocation.promise;
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("failed");
      expect(result.result.error).toContain("crashed");
    }
  });

  it("sets progress.threadId after spawn", async () => {
    const threadManager = createMockThreadManager();
    const invocation = SpawnSubagent.execute(
      makeRequest({ prompt: "do something", blocking: false }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
      },
    );

    await invocation.promise;
    expect(invocation.progress.threadId).toBe("thread-1");
  });

  it("returns error when spawnThread throws", async () => {
    const threadManager = createMockThreadManager({
      spawnThread: vi.fn().mockRejectedValue(new Error("spawn failed")),
    });

    const invocation = SpawnSubagent.execute(
      makeRequest({ prompt: "do something" }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
      },
    );

    const result = await invocation.promise;
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("spawn failed");
    }
  });

  it("maps agentType to correct threadType", async () => {
    const cases: Array<{
      agentType: SpawnSubagent.Input["agentType"];
      expectedThreadType: string;
    }> = [
      { agentType: "fast", expectedThreadType: "subagent_fast" },
      { agentType: "explore", expectedThreadType: "subagent_explore" },
      { agentType: undefined, expectedThreadType: "subagent_default" },
    ];

    for (const { agentType, expectedThreadType } of cases) {
      const threadManager = createMockThreadManager();
      const input: SpawnSubagent.Input = {
        prompt: "do something",
        blocking: false,
      };
      if (agentType !== undefined) {
        input.agentType = agentType;
      }
      SpawnSubagent.execute(makeRequest(input), {
        threadManager,
        threadId: "parent-1" as ThreadId,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
      });

      await vi.waitFor(() => {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        expect(threadManager.spawnThread).toHaveBeenCalled();
      });

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(threadManager.spawnThread).toHaveBeenCalledWith(
        expect.objectContaining({ threadType: expectedThreadType }),
      );
    }
  });
});
describe("spawn-subagent docker provisioning progress", () => {
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
  };

  it("updates progress.provisioningMessage during provisioning", async () => {
    const threadManager = createMockThreadManager();
    const requestRender = vi.fn();

    const provision = vi.fn(
      (opts: {
        repoPath: string;
        branch: string;
        containerConfig: ContainerConfig;
        onProgress?: (message: string) => void;
      }) => {
        opts.onProgress?.("Cloning repository...");
        opts.onProgress?.("Building Docker image...");
        opts.onProgress?.("Starting container...");
        return Promise.resolve(provisionResult);
      },
    );

    const invocation = SpawnSubagent.execute(
      makeRequest({
        prompt: "do docker work",
        agentType: "docker",
        branch: "feature-branch",
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        requestRender,
        cwd: "/test" as NvimCwd,
        containerProvisioner: {
          containerConfig,
          provision,
        },
      },
    );

    await invocation.promise;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const expectedProvisionOpts = expect.objectContaining({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      onProgress: expect.any(Function),
    });
    expect(provision).toHaveBeenCalledWith(expectedProvisionOpts);
    // requestRender is called once per onProgress call, plus once for threadId
    expect(requestRender).toHaveBeenCalledTimes(4);
    // Final provisioningMessage should be the last one set
    expect(invocation.progress.provisioningMessage).toBe(
      "Starting container...",
    );
  });

  it("returns error when branch is missing for docker agentType", async () => {
    const threadManager = createMockThreadManager();

    const invocation = SpawnSubagent.execute(
      makeRequest({
        prompt: "do docker work",
        agentType: "docker",
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        containerProvisioner: {
          containerConfig,
          provision: vi.fn(),
        },
      },
    );

    const result = await invocation.promise;
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("branch parameter is required");
    }
  });

  it("returns error when containerProvisioner is not configured", async () => {
    const threadManager = createMockThreadManager();

    const invocation = SpawnSubagent.execute(
      makeRequest({
        prompt: "do docker work",
        agentType: "docker",
        branch: "feature-branch",
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
      },
    );

    const result = await invocation.promise;
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain(
        "Docker environment is not configured",
      );
    }
  });

  it("spawns docker_root thread with provision result", async () => {
    const threadManager = createMockThreadManager();

    const invocation = SpawnSubagent.execute(
      makeRequest({
        prompt: "do docker work",
        agentType: "docker",
        branch: "feature-branch",
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        containerProvisioner: {
          containerConfig,
          provision: vi.fn().mockResolvedValue(provisionResult),
        },
      },
    );

    await invocation.promise;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const expectedSpawnOpts = expect.objectContaining({
      threadType: "docker_root",
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      dockerSpawnConfig: expect.objectContaining({
        branch: "feature-branch",
        containerName: provisionResult.containerName,
        tempDir: provisionResult.tempDir,
        imageName: provisionResult.imageName,
      }),
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(threadManager.spawnThread).toHaveBeenCalledWith(expectedSpawnOpts);

    expect(invocation.progress.threadId).toBe("thread-1");
  });

  it("docker agentType sets supervised=false in DockerSpawnConfig", async () => {
    const threadManager = createMockThreadManager();

    const invocation = SpawnSubagent.execute(
      makeRequest({
        prompt: "do docker work",
        agentType: "docker",
        branch: "feature-branch",
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        containerProvisioner: {
          containerConfig,
          provision: vi.fn().mockResolvedValue(provisionResult),
        },
      },
    );

    await invocation.promise;

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(threadManager.spawnThread).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        dockerSpawnConfig: expect.objectContaining({
          supervised: false,
        }),
      }),
    );
  });

  it("docker_unsupervised agentType sets supervised=true in DockerSpawnConfig", async () => {
    const threadManager = createMockThreadManager();

    const invocation = SpawnSubagent.execute(
      makeRequest({
        prompt: "do docker work",
        agentType: "docker_unsupervised",
        branch: "feature-branch",
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        containerProvisioner: {
          containerConfig,
          provision: vi.fn().mockResolvedValue(provisionResult),
        },
      },
    );

    await invocation.promise;

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(threadManager.spawnThread).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        dockerSpawnConfig: expect.objectContaining({
          supervised: true,
        }),
      }),
    );
  });

  it("blocking docker waits for completion and returns result", async () => {
    const threadManager = createMockThreadManager({
      waitForThread: vi.fn().mockResolvedValue({
        status: "ok",
        value: "docker work done",
      }),
    });

    const invocation = SpawnSubagent.execute(
      makeRequest({
        prompt: "do docker work",
        agentType: "docker",
        branch: "feature-branch",
        blocking: true,
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        containerProvisioner: {
          containerConfig,
          provision: vi.fn().mockResolvedValue(provisionResult),
        },
      },
    );

    const text = await getResultText(invocation);
    expect(text).toContain("completed");
    expect(text).toContain("docker work done");
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(threadManager.waitForThread).toHaveBeenCalledWith("thread-1");
  });

  it("blocking docker returns error when thread fails", async () => {
    const threadManager = createMockThreadManager({
      waitForThread: vi.fn().mockResolvedValue({
        status: "error",
        error: "container crashed",
      }),
    });

    const invocation = SpawnSubagent.execute(
      makeRequest({
        prompt: "do docker work",
        agentType: "docker",
        branch: "feature-branch",
        blocking: true,
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        containerProvisioner: {
          containerConfig,
          provision: vi.fn().mockResolvedValue(provisionResult),
        },
      },
    );

    const result = await invocation.promise;
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("failed");
      expect(result.result.error).toContain("container crashed");
    }
  });

  it("non-blocking docker returns immediately with threadId", async () => {
    const threadManager = createMockThreadManager();

    const invocation = SpawnSubagent.execute(
      makeRequest({
        prompt: "do docker work",
        agentType: "docker",
        branch: "feature-branch",
        blocking: false,
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        containerProvisioner: {
          containerConfig,
          provision: vi.fn().mockResolvedValue(provisionResult),
        },
      },
    );

    const text = await getResultText(invocation);
    expect(text).toContain("Docker thread started with threadId: thread-1");
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(threadManager.waitForThread).not.toHaveBeenCalled();
  });
});
