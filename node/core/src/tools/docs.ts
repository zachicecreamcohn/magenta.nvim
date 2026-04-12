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

const HELP_DIR = join(__dirname, "../../../../doc");

type BuiltinDoc = {
  name: string;
  description: string;
};

const BUILTIN_DOCS: BuiltinDoc[] = [
  {
    name: "magenta",
    description: "Overview, installation, and quick start guide",
  },
  {
    name: "magenta-commands-keymaps",
    description: "Commands, keymaps, input commands, and completions",
  },
  {
    name: "magenta-config",
    description:
      "Configuration options, profiles, sidebar, project settings, and custom commands",
  },
  {
    name: "magenta-providers",
    description: "Provider configuration, supported models, and authentication",
  },
  {
    name: "magenta-tools",
    description: "Available tools list and MCP server configuration",
  },
  {
    name: "magenta-edl",
    description:
      "Edit Description Language reference: commands, patterns, registers, and examples",
  },
  {
    name: "magenta-subagents",
    description: "Sub-agent types, tiers, environments, and example workflows",
  },
  {
    name: "magenta-docker",
    description:
      "Dev containers: Dockerfile setup, provisioning lifecycle, file sync, and supervision",
  },
  {
    name: "magenta-security",
    description:
      "Security model overview: sandbox, approval system, Docker isolation, and threat model",
  },
  {
    name: "magenta-permissions",
    description:
      "Sandbox configuration: filesystem rules, network domains, path matching, and merging behavior",
  },
  {
    name: "magenta-skills",
    description:
      "Creating custom skills: file structure, frontmatter format, and TypeScript scripts",
  },
];

const DOC_NAMES = BUILTIN_DOCS.map((d) => d.name);

function loadBuiltinDoc(name: string): string {
  const builtin = BUILTIN_DOCS.find((d) => d.name === name);
  if (!builtin) throw new Error(`Unknown doc: ${name}`);
  return readFileSync(join(HELP_DIR, `${name}.txt`), "utf-8");
}

export type Input = {
  name: string;
};

export type ToolRequest = GenericToolRequest<"docs", Input>;
export type StructuredResult = { toolName: "docs" };

export function execute(request: ToolRequest): ToolInvocation {
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
      const content = loadBuiltinDoc(request.input.name);
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "ok",
          value: [{ type: "text", text: content }],
          structuredResult: { toolName: "docs" as const },
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

function buildDescription(): string {
  return BUILTIN_DOCS.map((d) => `- **${d.name}**: ${d.description}`).join(
    "\n",
  );
}

export function getSpec(): ProviderToolSpec {
  return {
    name: "docs" as ToolName,
    description:
      "Learn about built-in topics. Use this when you need guidance on tools, configuration, security, skills, or other magenta.nvim features.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          enum: DOC_NAMES,
          description: `The doc to retrieve:\n${buildDescription()}`,
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  };
}

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.name !== "string") {
    return {
      status: "error",
      error: "expected req.input.name to be a string",
    };
  }

  if (!DOC_NAMES.includes(input.name)) {
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
