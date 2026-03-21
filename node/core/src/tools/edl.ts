import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OnToolApplied } from "../capabilities/context-tracker.ts";
import type { FileIO } from "../capabilities/file-io.ts";
import {
  type EdlRegisters,
  type FileMutationSummary,
  runScript,
} from "../edl/index.ts";
import type { ProviderToolSpec } from "../providers/provider-types.ts";
import type {
  GenericToolRequest,
  ToolInvocation,
  ToolInvocationResult,
  ToolName,
} from "../tool-types.ts";
import {
  FileCategory,
  type HomeDir,
  type NvimCwd,
  resolveFilePath,
} from "../utils/files.ts";
import type { Result } from "../utils/result.ts";

const EDL_DESCRIPTION = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "edl-description.md"),
  "utf-8",
);

export type EdlDisplayData = {
  mutations: { path: string; summary: FileMutationSummary }[];
  fileErrorCount: number;
  finalSelectionCount: number | undefined;
};

export type ResultInfo = {
  toolName: "edl";
  displayData?: EdlDisplayData;
  formattedResult: string;
};

export const EDL_DISPLAY_PREFIX = "__EDL_DISPLAY__";
export type ToolRequest = GenericToolRequest<"edl", Input>;

export function execute(
  request: ToolRequest,
  context: {
    cwd: NvimCwd;
    homeDir: HomeDir;
    fileIO: FileIO;
    edlRegisters: EdlRegisters;
    onToolApplied?: OnToolApplied;
  },
): ToolInvocation {
  let aborted = false;

  const promise = (async (): Promise<ToolInvocationResult> => {
    try {
      const script = request.input.script;
      const result = await runScript(
        script,
        context.fileIO,
        context.edlRegisters,
      );

      if (aborted) {
        return {
          result: {
            type: "tool_result",
            id: request.id,
            result: {
              status: "error",
              error: "Request was aborted by the user.",
            },
          },
          resultInfo: { toolName: "edl", formattedResult: "" },
        };
      }

      if (result.status === "ok") {
        context.edlRegisters.registers = result.edlRegisters.registers;
        context.edlRegisters.nextSavedId = result.edlRegisters.nextSavedId;

        for (const mutation of result.data.mutations) {
          const absFilePath = resolveFilePath(
            context.cwd,
            mutation.path as Parameters<typeof resolveFilePath>[1],
            context.homeDir,
          );
          context.onToolApplied?.(
            absFilePath,
            {
              type: "edl-edit",
              content: mutation.content,
            },
            {
              category: FileCategory.TEXT,
              mimeType: "text/plain",
              extension: "",
            },
          );
        }

        const displayData: EdlDisplayData = {
          mutations: result.data.mutations.map((m) => ({
            path: m.path,
            summary: m.summary,
          })),
          fileErrorCount: result.data.fileErrors.length,
          finalSelectionCount: result.data.finalSelection
            ? result.data.finalSelection.ranges.length
            : undefined,
        };

        return {
          result: {
            type: "tool_result",
            id: request.id,
            result: {
              status: "ok",
              value: [
                {
                  type: "text",
                  text: `${EDL_DISPLAY_PREFIX}${JSON.stringify(displayData)}`,
                },
                { type: "text", text: result.formatted },
              ],
            },
          },
          resultInfo: {
            toolName: "edl",
            displayData,
            formattedResult: result.formatted,
          },
        };
      } else {
        return {
          result: {
            type: "tool_result",
            id: request.id,
            result: {
              status: "error",
              error: result.error,
            },
          },
          resultInfo: { toolName: "edl", formattedResult: result.error },
        };
      }
    } catch (error) {
      if (aborted) {
        return {
          result: {
            type: "tool_result",
            id: request.id,
            result: {
              status: "error",
              error: "Request was aborted by the user.",
            },
          },
          resultInfo: { toolName: "edl", formattedResult: "" },
        };
      }
      const errorMessage = `Failed to execute EDL script: ${error instanceof Error ? error.message : String(error)}`;
      return {
        result: {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: errorMessage,
          },
        },
        resultInfo: { toolName: "edl", formattedResult: errorMessage },
      };
    }
  })();

  return {
    promise,
    abort: () => {
      aborted = true;
    },
  };
}

export const spec: ProviderToolSpec = {
  name: "edl" as ToolName,
  description: EDL_DESCRIPTION,
  input_schema: {
    type: "object",
    properties: {
      script: {
        type: "string",
        description: "The EDL script to execute",
      },
    },
    required: ["script"],
  },
};

export type Input = {
  script: string;
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.script !== "string") {
    return {
      status: "error",
      error: "expected req.input.script to be a string",
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
