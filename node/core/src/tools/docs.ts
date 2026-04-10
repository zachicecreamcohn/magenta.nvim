import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../logger.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider-types.ts";
import { extractYamlFrontmatter } from "../providers/skills.ts";
import type {
  GenericToolRequest,
  ToolInvocation,
  ToolName,
} from "../tool-types.ts";
import type { NvimCwd } from "../utils/files.ts";
import type { Result } from "../utils/result.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ARTICLES_DIR = join(__dirname, "docs");
const HELP_DIR = join(__dirname, "../../../../doc");

type BuiltinDoc = {
  name: string;
  description: string;
  source: "article" | "help";
};

const BUILTIN_DOCS: BuiltinDoc[] = [
  {
    name: "create-skill",
    description:
      "Guide for creating new skills in magenta.nvim, including file structure, frontmatter format, and TypeScript script execution",
    source: "article",
  },
  {
    name: "update-permissions",
    description:
      "Configure sandbox permissions for filesystem access and network domains. Use when sandbox violations occur.",
    source: "article",
  },
  {
    name: "plan",
    description:
      "Guide for creating implementation plans. Use when breaking down complex work into actionable steps.",
    source: "article",
  },
  {
    name: "magenta",
    description: "Overview, installation, and quick start guide",
    source: "help",
  },
  {
    name: "magenta-commands",
    description: "Commands, keymaps, and input reference",
    source: "help",
  },
  {
    name: "magenta-config",
    description: "Configuration options, profiles, and project settings",
    source: "help",
  },
  {
    name: "magenta-tools",
    description: "Available tools, sub-agents, MCP support, and permissions",
    source: "help",
  },
  {
    name: "magenta-providers",
    description: "Provider configuration and supported models",
    source: "help",
  },
];

const DOC_NAMES = BUILTIN_DOCS.map((d) => d.name);

export type UserDoc = {
  name: string;
  description: string;
  filePath: string;
};

function loadBuiltinDoc(name: string): string {
  const builtin = BUILTIN_DOCS.find((d) => d.name === name);
  if (!builtin) throw new Error(`Unknown doc: ${name}`);
  if (builtin.source === "article") {
    return readFileSync(join(ARTICLES_DIR, `${name}.md`), "utf-8");
  }
  return readFileSync(join(HELP_DIR, `${name}.txt`), "utf-8");
}

export function loadUserDocs(cwd: NvimCwd, logger: Logger): UserDoc[] {
  const docsDir = join(cwd, ".magenta", "docs");
  let files: string[];
  try {
    files = readdirSync(docsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  const docs: UserDoc[] = [];
  for (const file of files) {
    const filePath = join(docsDir, file);
    try {
      const content = readFileSync(filePath, "utf-8");
      const frontmatter = extractYamlFrontmatter(content);
      if (!frontmatter?.name || !frontmatter?.description) {
        logger.warn(
          `User doc ${filePath} is missing required frontmatter (name and/or description)`,
        );
        continue;
      }
      docs.push({
        name: frontmatter.name,
        description: frontmatter.description,
        filePath,
      });
    } catch (err) {
      logger.warn(
        `Failed to read user doc ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return docs;
}

export type Input = {
  name: string;
};

export type ToolRequest = GenericToolRequest<"docs", Input>;
export type StructuredResult = { toolName: "docs" };

export type ExecuteContext = {
  userDocs: UserDoc[];
};

export function execute(
  request: ToolRequest,
  context: ExecuteContext,
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
      const userDoc = context.userDocs.find(
        (d) => d.name === request.input.name,
      );
      const content = userDoc
        ? readFileSync(userDoc.filePath, "utf-8")
        : loadBuiltinDoc(request.input.name);
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

function buildDescription(userDocs: UserDoc[]): string {
  const allDocs = [
    ...BUILTIN_DOCS.map((d) => ({
      name: d.name,
      description: d.description,
    })),
    ...userDocs.map((d) => ({ name: d.name, description: d.description })),
  ];
  return allDocs.map((d) => `- **${d.name}**: ${d.description}`).join("\n");
}

export function getSpec(userDocs: UserDoc[] = []): ProviderToolSpec {
  const allNames = [...DOC_NAMES, ...userDocs.map((d) => d.name)];
  return {
    name: "docs" as ToolName,
    description:
      "Learn about built-in topics. Use this when you need guidance on creating skills, updating sandbox permissions, or creating implementation plans.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          enum: allNames,
          description: `The doc to retrieve:\n${buildDescription(userDocs)}`,
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  };
}

export function validateInput(
  input: { [key: string]: unknown },
  userDocs: UserDoc[] = [],
): Result<Input> {
  if (typeof input.name !== "string") {
    return {
      status: "error",
      error: "expected req.input.name to be a string",
    };
  }

  const allNames = [...DOC_NAMES, ...userDocs.map((d) => d.name)];
  if (!allNames.includes(input.name)) {
    return {
      status: "error",
      error: `expected req.input.name to be one of: ${allNames.join(", ")}`,
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
