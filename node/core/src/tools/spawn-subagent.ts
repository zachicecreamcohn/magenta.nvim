import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThreadManager } from "../capabilities/thread-manager.ts";
import type { ThreadId, ThreadType } from "../chat-types.ts";
import type { ContainerConfig, ProvisionResult } from "../container/types.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider-types.ts";
import { AGENT_TYPES, type AgentType } from "../providers/system-prompt.ts";
import type {
  GenericToolRequest,
  ToolInvocation,
  ToolName,
} from "../tool-types.ts";
import type { NvimCwd, UnresolvedFilePath } from "../utils/files.ts";
import type { Result } from "../utils/result.ts";

const SPAWN_SUBAGENT_DESCRIPTION = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "spawn-subagent-description.md",
  ),
  "utf-8",
);

export type ToolRequest = GenericToolRequest<"spawn_subagent", Input>;

export type SpawnSubagentProgress = {
  threadId?: ThreadId;
  provisioningMessage?: string;
};
export type StructuredResult = {
  toolName: "spawn_subagent";
  threadId?: ThreadId;
  isBlocking: boolean;
  responseBody?: string;
};

export function execute(
  request: ToolRequest,
  context: {
    threadManager: ThreadManager;
    threadId: ThreadId;
    requestRender: () => void;
    cwd: NvimCwd;
    containerProvisioner?:
      | {
          containerConfig: ContainerConfig;
          provision: (opts: {
            repoPath: string;
            baseBranch?: string;
            containerConfig: ContainerConfig;
            onProgress?: (message: string) => void;
          }) => Promise<ProvisionResult>;
        }
      | undefined;
  },
): ToolInvocation & { progress: SpawnSubagentProgress } {
  const progress: SpawnSubagentProgress = {};

  const promise = (async (): Promise<ProviderToolResult> => {
    try {
      const input = request.input;

      if (
        input.agentType === "docker" ||
        input.agentType === "docker_unsupervised"
      ) {
        if (!input.branch) {
          return {
            type: "tool_result",
            id: request.id,
            result: {
              status: "error",
              error: "branch parameter is required when agentType is 'docker'",
            },
          };
        }

        if (!context.containerProvisioner) {
          return {
            type: "tool_result",
            id: request.id,
            result: {
              status: "error",
              error:
                "Docker environment is not configured. Set options.container in your magenta config.",
            },
          };
        }

        const provisioner = context.containerProvisioner;
        const provisionResult = await provisioner.provision({
          repoPath: context.cwd,
          baseBranch: input.branch,
          containerConfig: provisioner.containerConfig,
          onProgress: (message) => {
            progress.provisioningMessage = message;
            context.requestRender();
          },
        });

        const threadId = await context.threadManager.spawnThread({
          parentThreadId: context.threadId,
          prompt: input.prompt,
          threadType: "docker_root",
          ...(input.contextFiles ? { contextFiles: input.contextFiles } : {}),
          dockerSpawnConfig: {
            baseBranch: input.branch ?? "HEAD",
            workerBranch: provisionResult.workerBranch,
            containerName: provisionResult.containerName,
            tempDir: provisionResult.tempDir,
            imageName: provisionResult.imageName,
            startSha: provisionResult.startSha,
            workspacePath: provisioner.containerConfig.workspacePath,
            supervised: input.agentType === "docker_unsupervised",
          },
        });

        progress.threadId = threadId;
        context.requestRender();

        if (!input.blocking) {
          return {
            type: "tool_result",
            id: request.id,
            result: {
              status: "ok",
              value: [
                {
                  type: "text",
                  text: `Docker thread started with threadId: ${threadId} on worker branch: ${provisionResult.workerBranch} (forked from ${input.branch ?? "HEAD"})`,
                },
              ],
              structuredResult: {
                toolName: "spawn_subagent",
                threadId,
                isBlocking: false,
              },
            },
          };
        }

        const result = await context.threadManager.waitForThread(threadId);

        if (result.status === "ok") {
          return {
            type: "tool_result",
            id: request.id,
            result: {
              status: "ok",
              value: [
                {
                  type: "text",
                  text: `Docker sub-agent (${threadId}) on worker branch ${provisionResult.workerBranch} completed:\n${result.value}`,
                },
              ],
              structuredResult: {
                toolName: "spawn_subagent",
                threadId,
                isBlocking: true,
                responseBody: result.value,
              },
            },
          };
        } else {
          return {
            type: "tool_result",
            id: request.id,
            result: {
              status: "error",
              error: `Docker sub-agent (${threadId}) on worker branch ${provisionResult.workerBranch} failed: ${result.error}`,
            },
          };
        }
      }

      const threadType: ThreadType =
        input.agentType === "fast"
          ? "subagent_fast"
          : input.agentType === "explore"
            ? "subagent_explore"
            : "subagent_default";

      const threadId = await context.threadManager.spawnThread({
        parentThreadId: context.threadId,
        prompt: input.prompt,
        threadType,
        ...(input.contextFiles ? { contextFiles: input.contextFiles } : {}),
      });

      progress.threadId = threadId;
      context.requestRender();

      if (!input.blocking) {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "ok",
            value: [
              {
                type: "text",
                text: `Sub-agent started with threadId: ${threadId}`,
              },
            ],
            structuredResult: {
              toolName: "spawn_subagent",
              threadId,
              isBlocking: false,
            },
          },
        };
      }

      const result = await context.threadManager.waitForThread(threadId);

      if (result.status === "ok") {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "ok",
            value: [
              {
                type: "text",
                text: `Sub-agent (${threadId}) completed:\n${result.value}`,
              },
            ],
            structuredResult: {
              toolName: "spawn_subagent",
              threadId,
              isBlocking: true,
              responseBody: result.value,
            },
          },
        };
      } else {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: `Sub-agent (${threadId}) failed: ${result.error}`,
          },
        };
      }
    } catch (e) {
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: `Failed to create sub-agent thread: ${e instanceof Error ? e.message : String(e)}`,
        },
      };
    }
  })();

  return { promise, abort: () => {}, progress };
}

const ALL_AGENT_TYPES = [
  ...AGENT_TYPES,
  "docker",
  "docker_unsupervised",
] as const;
export const spec: ProviderToolSpec = {
  name: "spawn_subagent" as ToolName,
  description: SPAWN_SUBAGENT_DESCRIPTION,
  input_schema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "The sub-agent prompt. This should contain a clear question, and information about what the answer should look like.",
      },
      contextFiles: {
        type: "array",
        items: {
          type: "string",
        },
        description:
          "Optional list of file paths to provide as context to the sub-agent.",
      },
      agentType: {
        type: "string",
        enum: ALL_AGENT_TYPES as unknown as string[],
        description:
          "Optional agent type to use for the sub-agent. Use 'explore' for answering specific questions about the codebase (returns file paths and descriptions, not code). Use 'fast' for simple editing tasks. Use 'default' for tasks that require more thought and smarts. Use 'docker' to spawn a thread in an isolated Docker container (requires 'branch' parameter). Use 'docker_unsupervised' to spawn an autonomous docker agent that auto-restarts and handles teardown automatically (requires 'branch' parameter).",
      },
      branch: {
        type: "string",
        description:
          "Base branch to fork from for the docker agent. Required when agentType is 'docker'. A unique worker branch will be created from this base branch.",
      },
      blocking: {
        type: "boolean",
        description:
          "Pause this thread until the subagent finishes. If false (default), the tool returns immediately with the threadId you can use with wait_for_subagents to get the result.",
      },
    },

    required: ["prompt"],
  },
};

export type Input = {
  prompt: string;
  contextFiles?: UnresolvedFilePath[];
  agentType?: AgentType | "docker" | "docker_unsupervised";
  blocking?: boolean;
  branch?: string;
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.prompt !== "string") {
    return {
      status: "error",
      error: `expected req.input.prompt to be a string but it was ${JSON.stringify(input.prompt)}`,
    };
  }

  if (input.contextFiles !== undefined) {
    if (!Array.isArray(input.contextFiles)) {
      return {
        status: "error",
        error: `expected req.input.contextFiles to be an array but it was ${JSON.stringify(input.contextFiles)}`,
      };
    }

    if (!input.contextFiles.every((item) => typeof item === "string")) {
      return {
        status: "error",
        error: `expected all items in req.input.contextFiles to be strings but they were ${JSON.stringify(input.contextFiles)}`,
      };
    }
  }

  if (input.agentType !== undefined) {
    if (typeof input.agentType !== "string") {
      return {
        status: "error",
        error: `expected req.input.agentType to be a string but it was ${JSON.stringify(input.agentType)}`,
      };
    }

    const validTypes: readonly string[] = ALL_AGENT_TYPES;
    if (!validTypes.includes(input.agentType)) {
      return {
        status: "error",
        error: `expected req.input.agentType to be one of ${ALL_AGENT_TYPES.join(", ")} but it was ${JSON.stringify(input.agentType)}`,
      };
    }
  }

  if (input.branch !== undefined) {
    if (typeof input.branch !== "string") {
      return {
        status: "error",
        error: `expected req.input.branch to be a string but it was ${JSON.stringify(input.branch)}`,
      };
    }
  }

  if (input.blocking !== undefined) {
    if (typeof input.blocking !== "boolean") {
      return {
        status: "error",
        error: `expected req.input.blocking to be a boolean but it was ${JSON.stringify(input.blocking)}`,
      };
    }
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
