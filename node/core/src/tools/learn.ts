import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider-types.ts";
import type {
  GenericToolRequest,
  ToolInvocation,
  ToolName,
} from "../tool-types.ts";
import type { Result } from "../utils/result.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DOC_NAMES = ["create-skill", "update-permissions", "plan"] as const;
export type DocName = (typeof DOC_NAMES)[number];

const LEARN_DIR = join(__dirname, "learn");

function loadDoc(name: DocName): string {
  return readFileSync(join(LEARN_DIR, `${name}.md`), "utf-8");
}

export type Input = {
  name: DocName;
};

export type ToolRequest = GenericToolRequest<"learn", Input>;
export type StructuredResult = { toolName: "learn" };

export function execute(
  request: ToolRequest,
  _context: Record<string, never>,
): ToolInvocation {
  let aborted = false;

  const promise = (async (): Promise<ProviderToolResult> => {
    await Promise.resolve();
    if (aborted) {
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: "Request was aborted by the user.",
        },
      };
    }

    try {
      const content = loadDoc(request.input.name);
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "ok",
          value: [{ type: "text", text: content }],
          structuredResult: { toolName: "learn" as const },
        },
      };
    } catch (error) {
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: `Failed to load doc "${request.input.name}": ${error instanceof Error ? error.message : String(error)}`,
        },
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
  name: "learn" as ToolName,
  description:
    "Learn about built-in topics. Use this when you need guidance on creating skills, updating sandbox permissions, or creating implementation plans.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        enum: [...DOC_NAMES],
        description:
          "The doc to retrieve:\n" +
          "- **create-skill**: Guide for creating new skills in magenta.nvim, including file structure, frontmatter format, and TypeScript script execution\n" +
          "- **update-permissions**: Configure sandbox permissions for filesystem access and network domains. Use when sandbox violations occur.\n" +
          "- **plan**: Guide for creating implementation plans. Use when breaking down complex work into actionable steps.",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.name !== "string") {
    return {
      status: "error",
      error: "expected req.input.name to be a string",
    };
  }

  if (!DOC_NAMES.includes(input.name as DocName)) {
    return {
      status: "error",
      error: `expected req.input.name to be one of: ${DOC_NAMES.join(", ")}`,
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
