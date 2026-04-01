import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentsMap, formatAgentsIntroduction } from "../agents/agents.ts";
import type { ThreadManager } from "../capabilities/thread-manager.ts";
import type { SubagentConfig, ThreadId } from "../chat-types.ts";
import type { ContainerConfig, ProvisionResult } from "../container/types.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider-types.ts";
import type {
  GenericToolRequest,
  ToolInvocation,
  ToolName,
} from "../tool-types.ts";
import type { NvimCwd, UnresolvedFilePath } from "../utils/files.ts";
import type { Result } from "../utils/result.ts";

const SPAWN_SUBAGENTS_BASE_DESCRIPTION = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "spawn-subagents-description.md",
  ),
  "utf-8",
);

const BASE_AGENT_TYPES = [
  "default",
  "fast",
  "docker",
  "docker_unsupervised",
] as const;

export type SubagentEntry = {
  prompt: string;
  contextFiles?: UnresolvedFilePath[];
  agentType?: string;
  branch?: string;
};

export type Input = {
  agents: SubagentEntry[];
};

export type ToolRequest = GenericToolRequest<"spawn_subagents", Input>;

export type SubagentElementProgress =
  | { status: "pending" }
  | { status: "provisioning"; message: string }
  | { status: "spawned"; threadId: ThreadId }
  | { status: "spawn-error"; error: string };

export type SpawnSubagentsProgress = {
  elements: Array<{
    entry: SubagentEntry;
    state: SubagentElementProgress;
  }>;
};

export type StructuredResult = {
  toolName: "spawn_subagents";
  agents: Array<{
    prompt: string;
    threadId?: ThreadId;
    ok: boolean;
    responseBody?: string;
  }>;
};

function resolveSubagentConfig(
  entry: SubagentEntry,
  agents: AgentsMap,
): SubagentConfig {
  const agentType = entry.agentType;

  if (!agentType || agentType === "default") {
    return {};
  }

  if (agentType === "fast") {
    return { fastModel: true };
  }

  // Look up custom agent by name
  const agentDef = agents[agentType];
  if (agentDef) {
    return {
      agentName: agentDef.name,
      fastModel: agentDef.fastModel,
      systemPrompt: agentDef.systemPrompt,
      systemReminder: agentDef.systemReminder,
    };
  }

  // Unknown agent type — treat as default
  return { agentName: agentType };
}

export function execute(
  request: ToolRequest,
  context: {
    threadManager: ThreadManager;
    threadId: ThreadId;
    maxConcurrentSubagents: number;
    requestRender: () => void;
    cwd: NvimCwd;
    agents: AgentsMap;
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
): ToolInvocation & { progress: SpawnSubagentsProgress } {
  const input = request.input;
  const progress: SpawnSubagentsProgress = {
    elements: input.agents.map((entry) => ({
      entry,
      state: { status: "pending" as const },
    })),
  };

  const abortController = { aborted: false };

  const spawnEntry = async (
    element: SpawnSubagentsProgress["elements"][0],
  ): Promise<void> => {
    if (abortController.aborted) return;

    const entry = element.entry;

    try {
      if (
        entry.agentType === "docker" ||
        entry.agentType === "docker_unsupervised"
      ) {
        await spawnDockerEntry(element, entry, context);
        return;
      }

      const subagentConfig = resolveSubagentConfig(entry, context.agents);

      const threadId = await context.threadManager.spawnThread({
        parentThreadId: context.threadId,
        prompt: entry.prompt,
        threadType: "subagent",
        subagentConfig,
        ...(entry.contextFiles ? { contextFiles: entry.contextFiles } : {}),
      });

      element.state = { status: "spawned", threadId };
      context.requestRender();
    } catch (e) {
      element.state = {
        status: "spawn-error",
        error: e instanceof Error ? e.message : String(e),
      };
      context.requestRender();
    }
  };

  const spawnDockerEntry = async (
    element: SpawnSubagentsProgress["elements"][0],
    entry: SubagentEntry,
    ctx: typeof context,
  ): Promise<void> => {
    if (!entry.branch) {
      element.state = {
        status: "spawn-error",
        error:
          "branch parameter is required when agentType is 'docker' or 'docker_unsupervised'",
      };
      ctx.requestRender();
      return;
    }

    if (!ctx.containerProvisioner) {
      element.state = {
        status: "spawn-error",
        error:
          "Docker environment is not configured. Set options.container in your magenta config.",
      };
      ctx.requestRender();
      return;
    }

    const provisioner = ctx.containerProvisioner;

    element.state = { status: "provisioning", message: "Starting..." };
    ctx.requestRender();

    const provisionResult = await provisioner.provision({
      repoPath: ctx.cwd,
      baseBranch: entry.branch,
      containerConfig: provisioner.containerConfig,
      onProgress: (message) => {
        element.state = { status: "provisioning", message };
        ctx.requestRender();
      },
    });

    const threadId = await ctx.threadManager.spawnThread({
      parentThreadId: ctx.threadId,
      prompt: entry.prompt,
      threadType: "docker_root",
      ...(entry.contextFiles ? { contextFiles: entry.contextFiles } : {}),
      dockerSpawnConfig: {
        baseBranch: entry.branch ?? "HEAD",
        workerBranch: provisionResult.workerBranch,
        containerName: provisionResult.containerName,
        tempDir: provisionResult.tempDir,
        imageName: provisionResult.imageName,
        startSha: provisionResult.startSha,
        workspacePath: provisioner.containerConfig.workspacePath,
        supervised: entry.agentType === "docker_unsupervised",
      },
    });

    element.state = { status: "spawned", threadId };
    ctx.requestRender();
  };

  const promise = (async (): Promise<ProviderToolResult> => {
    try {
      const maxConcurrent = context.maxConcurrentSubagents;

      // Phase 1: Spawn all threads with concurrency control
      let nextIdx = 0;
      const inFlight = new Set<Promise<void>>();

      const startNext = (): void => {
        if (nextIdx >= progress.elements.length || abortController.aborted)
          return;
        const element = progress.elements[nextIdx++];
        const p = spawnEntry(element).then(() => {
          inFlight.delete(p);
        });
        inFlight.add(p);
      };

      while (
        nextIdx < progress.elements.length &&
        inFlight.size < maxConcurrent
      ) {
        startNext();
      }

      while (inFlight.size > 0) {
        await Promise.race(inFlight);
        if (!abortController.aborted) {
          startNext();
        }
      }

      if (abortController.aborted) {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: "Sub-agent execution was aborted",
          },
        };
      }

      // Phase 2: Wait for all spawned threads to yield
      const spawnedElements = progress.elements.filter(
        (
          el,
        ): el is typeof el & {
          state: { status: "spawned"; threadId: ThreadId };
        } => el.state.status === "spawned",
      );

      if (spawnedElements.length === 0) {
        return buildResult(request.id, progress, context.threadManager);
      }

      await new Promise<void>((resolve) => {
        const checkAllYielded = () => {
          if (abortController.aborted) {
            resolve();
            return;
          }
          const allDone = spawnedElements.every((el) => {
            const result = context.threadManager.getThreadResult(
              el.state.threadId,
            );
            return result.status === "done";
          });
          if (allDone) {
            resolve();
          }
        };

        for (const el of spawnedElements) {
          context.threadManager.onThreadYielded(
            el.state.threadId,
            checkAllYielded,
          );
        }

        // Check immediately in case all threads already yielded
        checkAllYielded();
      });

      if (abortController.aborted) {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: "Sub-agent execution was aborted",
          },
        };
      }

      return buildResult(request.id, progress, context.threadManager);
    } catch (e) {
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: e instanceof Error ? e.message : String(e),
        },
      };
    }
  })();

  return {
    promise,
    abort: () => {
      abortController.aborted = true;
    },
    progress,
  };
}

function buildResult(
  requestId: ToolRequest["id"],
  progress: SpawnSubagentsProgress,
  threadManager: ThreadManager,
): ProviderToolResult {
  const agents: StructuredResult["agents"] = [];
  let successCount = 0;
  let failCount = 0;

  let resultText = "All sub-agents completed:\n\n";

  for (const item of progress.elements) {
    const truncatedPrompt = truncatePrompt(item.entry.prompt);

    if (item.state.status === "spawn-error") {
      failCount++;
      resultText += `❌ ${truncatedPrompt}:\n${item.state.error}\n\n`;
      agents.push({
        prompt: item.entry.prompt,
        ok: false,
      });
      continue;
    }

    if (item.state.status !== "spawned") {
      failCount++;
      resultText += `❌ ${truncatedPrompt}:\nnever spawned\n\n`;
      agents.push({
        prompt: item.entry.prompt,
        ok: false,
      });
      continue;
    }

    const threadResult = threadManager.getThreadResult(item.state.threadId);
    if (threadResult.status === "pending") {
      failCount++;
      resultText += `❌ ${truncatedPrompt}:\nthread did not complete\n\n`;
      agents.push({
        prompt: item.entry.prompt,
        threadId: item.state.threadId,
        ok: false,
      });
      continue;
    }

    const result = threadResult.result;
    if (result.status === "ok") {
      successCount++;
      resultText += `✅ ${truncatedPrompt}:\n${result.value}\n\n`;
      agents.push({
        prompt: item.entry.prompt,
        threadId: item.state.threadId,
        ok: true,
        responseBody: result.value,
      });
    } else {
      failCount++;
      resultText += `❌ ${truncatedPrompt}:\n${result.error}\n\n`;
      agents.push({
        prompt: item.entry.prompt,
        threadId: item.state.threadId,
        ok: false,
      });
    }
  }

  const totalLine = `Total: ${progress.elements.length}\nSuccessful: ${successCount}\nFailed: ${failCount}\n\n`;
  resultText =
    resultText.slice(0, "All sub-agents completed:\n\n".length) +
    totalLine +
    resultText.slice("All sub-agents completed:\n\n".length);

  return {
    type: "tool_result",
    id: requestId,
    result: {
      status: "ok",
      value: [{ type: "text", text: resultText }],
      structuredResult: {
        toolName: "spawn_subagents" as const,
        agents,
      },
    },
  };
}

function truncatePrompt(prompt: string, maxLen: number = 80): string {
  const singleLine = prompt.replace(/\n/g, " ");
  return singleLine.length > maxLen
    ? `${singleLine.substring(0, maxLen)}...`
    : singleLine;
}

export function getSpec(agents: AgentsMap): ProviderToolSpec {
  const agentNames = Object.keys(agents);
  const allAgentTypes = [...BASE_AGENT_TYPES, ...agentNames];

  const agentsDescription = formatAgentsIntroduction(agents, "" as NvimCwd);
  const description = SPAWN_SUBAGENTS_BASE_DESCRIPTION + agentsDescription;

  return {
    name: "spawn_subagents" as ToolName,
    description,
    input_schema: {
      type: "object",
      properties: {
        agents: {
          type: "array",
          description:
            "Array of sub-agent configurations to run in parallel. Each entry specifies a prompt and optional settings.",
          items: {
            type: "object",
            properties: {
              prompt: {
                type: "string",
                description:
                  "The sub-agent prompt. This should contain a clear question or task description.",
              },
              contextFiles: {
                type: "array",
                items: { type: "string" },
                description:
                  "Optional list of file paths to provide as context to this sub-agent.",
              },
              agentType: {
                type: "string",
                enum: allAgentTypes,
                description:
                  "Agent type for this sub-agent. Use custom agent names, 'fast' for quick edits, 'default' for complex tasks, 'docker'/'docker_unsupervised' for isolated container work.",
              },
              branch: {
                type: "string",
                description:
                  "Base branch to fork from for docker agents. Required when agentType is 'docker' or 'docker_unsupervised'.",
              },
            },
            required: ["prompt"],
          },
          minItems: 1,
        },
      },
      required: ["agents"],
    },
  };
}
export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (!Array.isArray(input.agents)) {
    return {
      status: "error",
      error: `expected req.input.agents to be an array but it was ${JSON.stringify(input.agents)}`,
    };
  }

  if (input.agents.length === 0) {
    return {
      status: "error",
      error: "agents array cannot be empty",
    };
  }

  for (let i = 0; i < input.agents.length; i++) {
    const agent = input.agents[i] as Record<string, unknown>;

    if (typeof agent.prompt !== "string") {
      return {
        status: "error",
        error: `expected agents[${i}].prompt to be a string but it was ${JSON.stringify(agent.prompt)}`,
      };
    }

    if (agent.contextFiles !== undefined) {
      if (!Array.isArray(agent.contextFiles)) {
        return {
          status: "error",
          error: `expected agents[${i}].contextFiles to be an array but it was ${JSON.stringify(agent.contextFiles)}`,
        };
      }
      if (
        !agent.contextFiles.every((item: unknown) => typeof item === "string")
      ) {
        return {
          status: "error",
          error: `expected all items in agents[${i}].contextFiles to be strings`,
        };
      }
    }

    if (agent.agentType !== undefined) {
      if (typeof agent.agentType !== "string") {
        return {
          status: "error",
          error: `expected agents[${i}].agentType to be a string but it was ${JSON.stringify(agent.agentType)}`,
        };
      }
    }

    if (agent.branch !== undefined) {
      if (typeof agent.branch !== "string") {
        return {
          status: "error",
          error: `expected agents[${i}].branch to be a string but it was ${JSON.stringify(agent.branch)}`,
        };
      }
    }
  }

  return {
    status: "ok",
    value: {
      agents: input.agents as SubagentEntry[],
    },
  };
}
