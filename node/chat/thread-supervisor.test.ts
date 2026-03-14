import { describe, expect, it, vi } from "vitest";

vi.mock("@magenta/core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@magenta/core")>();
  return {
    ...orig,
    teardownContainer: vi.fn().mockResolvedValue(undefined),
  };
});

import type { ContainerConfig, ProvisionResult } from "@magenta/core";
import { teardownContainer } from "@magenta/core";
import type { Shell, ShellResult } from "../capabilities/shell.ts";
import type { NvimCwd } from "../utils/files.ts";
import { DockerSupervisor } from "./thread-supervisor.ts";

function createMockShell(execResult?: Partial<ShellResult>): Shell {
  return {
    execute: vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: undefined,
      output: [],
      logFilePath: undefined,
      durationMs: 10,
      ...execResult,
    }),
    terminate: vi.fn(),
  };
}

const mockProvisionResult: ProvisionResult = {
  containerName: "test-container",
  tempDir: "/tmp/test-dir",
  imageName: "test-image",
  startSha: "abc123",
  workerBranch: "magenta/worker-abc123",
};

const mockContainerConfig: ContainerConfig = {
  dockerfile: ".devcontainer",
  workspacePath: "/workspace",
  installCommand: "npm install",
};

describe("DockerSupervisor", () => {
  describe("onEndTurnWithoutYield", () => {
    it("returns send-message for auto-restart", () => {
      const supervisor = new DockerSupervisor(
        createMockShell(),
        mockProvisionResult,
        mockContainerConfig,
        "feature-branch",
        "/repo" as NvimCwd,
      );

      const action = supervisor.onEndTurnWithoutYield("end_turn");
      expect(action.type).toBe("send-message");
      if (action.type === "send-message") {
        expect(action.text).toContain("yield_to_parent");
        expect(action.text).toContain("1/5");
      }
    });

    it("stops auto-restarting after max retries", () => {
      const supervisor = new DockerSupervisor(
        createMockShell(),
        mockProvisionResult,
        mockContainerConfig,
        "feature-branch",
        "/repo" as NvimCwd,
        { maxRestarts: 2 },
      );

      expect(supervisor.onEndTurnWithoutYield("end_turn").type).toBe(
        "send-message",
      );
      expect(supervisor.onEndTurnWithoutYield("end_turn").type).toBe(
        "send-message",
      );
      expect(supervisor.onEndTurnWithoutYield("end_turn").type).toBe("none");
    });

    it("does not restart when stop reason is aborted", () => {
      const supervisor = new DockerSupervisor(
        createMockShell(),
        mockProvisionResult,
        mockContainerConfig,
        "feature-branch",
        "/repo" as NvimCwd,
      );

      const action = supervisor.onEndTurnWithoutYield("aborted");
      expect(action.type).toBe("none");
    });
  });

  describe("onYield", () => {
    it("rejects yield when git status is dirty", async () => {
      const shell = createMockShell({
        output: [{ stream: "stdout", text: " M dirty-file.ts" }],
      });
      const supervisor = new DockerSupervisor(
        shell,
        mockProvisionResult,
        mockContainerConfig,
        "feature-branch",
        "/repo" as NvimCwd,
      );

      const action = await supervisor.onYield("done");
      expect(action.type).toBe("reject");
      if (action.type === "reject") {
        expect(action.message).toContain("dirty");
        expect(action.message).toContain("dirty-file.ts");
      }
    });

    it("accepts yield when git status is clean", async () => {
      const shell = createMockShell({ output: [] });
      const supervisor = new DockerSupervisor(
        shell,
        mockProvisionResult,
        mockContainerConfig,
        "feature-branch",
        "/repo" as NvimCwd,
      );

      const action = await supervisor.onYield("done");

      expect(action).toEqual({ type: "accept" });
      expect(teardownContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          containerName: "test-container",
          baseBranch: "feature-branch",
          workerBranch: "magenta/worker-abc123",
        }),
      );
    });

    it("forwards onProgress to teardownContainer", async () => {
      const shell = createMockShell({ output: [] });
      const onProgress = vi.fn();
      const supervisor = new DockerSupervisor(
        shell,
        mockProvisionResult,
        mockContainerConfig,
        "feature-branch",
        "/repo" as NvimCwd,
        { onProgress },
      );

      await supervisor.onYield("done");

      expect(teardownContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          baseBranch: "feature-branch",
          workerBranch: "magenta/worker-abc123",
          onProgress,
        }),
      );
    });

    it("does not pass onProgress when not provided", async () => {
      const shell = createMockShell({ output: [] });
      const supervisor = new DockerSupervisor(
        shell,
        mockProvisionResult,
        mockContainerConfig,
        "feature-branch",
        "/repo" as NvimCwd,
      );

      await supervisor.onYield("done");

      const call = vi.mocked(teardownContainer).mock.calls[0][0];
      expect(call).not.toHaveProperty("onProgress");
    });
  });

  describe("onAbort", () => {
    it("returns none", () => {
      const supervisor = new DockerSupervisor(
        createMockShell(),
        mockProvisionResult,
        mockContainerConfig,
        "feature-branch",
        "/repo" as NvimCwd,
      );

      expect(supervisor.onAbort()).toEqual({ type: "none" });
    });
  });
});
