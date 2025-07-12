import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CopilotProvider } from "./copilot.ts";
import type {
  ProviderMessage,
  ProviderToolSpec,
  ProviderStreamEvent,
} from "./provider-types.ts";
import type { ToolName } from "../tools/types.ts";
import type { Nvim } from "../nvim/nvim-node";
import path from "path";
import os from "os";
import nock from "nock";
import { withRecording } from "../test/recording.ts";
import { MockFileSystem } from "../test/mock-fs.ts";

// Test fixtures
const SAMPLE_OAUTH_TOKEN = "ghu_1234567890abcdef";
const SAMPLE_GITHUB_TOKEN = "ghs_abcdef1234567890";

const HOSTS_JSON_CONTENT = JSON.stringify({
  "github.com": {
    user: "testuser",
    oauth_token: SAMPLE_OAUTH_TOKEN,
    git_protocol: "https",
  },
});

const GITHUB_TOKEN_RESPONSE = {
  token: SAMPLE_GITHUB_TOKEN,
  endpoints: {
    api: "https://api.githubcopilot.com",
  },
};

// Sample messages for testing
const SIMPLE_MESSAGES: ProviderMessage[] = [
  {
    role: "user",
    content: [{ type: "text", text: "Hello, how are you?" }],
  },
];

const TOOL_SPEC: ProviderToolSpec = {
  name: "get_weather" as ToolName,
  description: "Get weather information",
  input_schema: {
    type: "object",
    properties: {
      location: { type: "string", description: "City name" },
    },
    required: ["location"],
  },
};

describe.skip("CopilotProvider", () => {
  let provider: CopilotProvider;
  let mockNvim: Nvim;
  let mockFs: MockFileSystem;
  let restoreFs: () => void;

  beforeEach(() => {
    mockNvim = {
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      },
    } as unknown as Nvim;

    provider = new CopilotProvider(mockNvim);
    mockFs = new MockFileSystem();
    restoreFs = mockFs.mockFsPromises();
  });

  afterEach(() => {
    nock.cleanAll();
    restoreFs();
    mockFs.clear();
    vi.clearAllMocks();
  });

  describe("Authentication", () => {
    it("should discover OAuth token from hosts.json", async () => {
      await withRecording("auth-hosts-json", async () => {
        const hostsPath = path.join(
          os.homedir(),
          ".config",
          "github-copilot",
          "hosts.json",
        );
        mockFs.setFile(hostsPath, HOSTS_JSON_CONTENT);

        const streamEvents: ProviderStreamEvent[] = [];
        const request = provider.sendMessage({
          model: "claude-3.7-sonnet",
          messages: SIMPLE_MESSAGES,
          onStreamEvent: (event) => streamEvents.push(event),
          tools: [],
        });

        const result = await request.promise;
        expect(result.stopReason).toBe("end_turn");
        expect(streamEvents.length).toBeGreaterThan(0);
      });
    });
  });

  describe("Basic functionality", () => {
    beforeEach(() => {
      const hostsPath = path.join(
        os.homedir(),
        ".config",
        "github-copilot",
        "hosts.json",
      );
      mockFs.setFile(hostsPath, HOSTS_JSON_CONTENT);
    });

    it("should handle simple text response", async () => {
      await withRecording("simple-text-response", async () => {
        const streamEvents: ProviderStreamEvent[] = [];
        const request = provider.sendMessage({
          model: "claude-3.7-sonnet",
          messages: SIMPLE_MESSAGES,
          onStreamEvent: (event) => streamEvents.push(event),
          tools: [],
        });

        const result = await request.promise;

        expect(result.stopReason).toBe("end_turn");
        expect(streamEvents.length).toBeGreaterThan(0);
        expect(streamEvents[0].type).toBe("content_block_start");
      });
    });

    it("should handle tool use response", async () => {
      await withRecording("tool-use-response", async () => {
        const streamEvents: ProviderStreamEvent[] = [];
        const request = provider.sendMessage({
          model: "claude-3.7-sonnet",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "What's the weather in London?" },
              ],
            },
          ],
          onStreamEvent: (event) => streamEvents.push(event),
          tools: [TOOL_SPEC],
        });

        const result = await request.promise;

        expect(result.stopReason).toBe("tool_use");
        expect(streamEvents.length).toBeGreaterThan(0);
      });
    });
  });

  describe("Tool compatibility", () => {
    it("should make tool specs OpenAI compatible", () => {
      const spec: ProviderToolSpec = {
        name: "test_tool" as ToolName,
        description: "Test tool",
        input_schema: {
          type: "object",
          properties: {
            email: { type: "string", format: "email" },
            uri: { type: "string", format: "uri" },
            optional: { type: "string" },
          },
          required: ["email"],
        },
      };

      const params = provider.createStreamParameters({
        model: "claude-3.7-sonnet",
        messages: [],
        tools: [spec],
      });
      const tool = params.tools?.[0];
      const schema = tool?.function?.parameters;

      if (
        schema &&
        schema.properties &&
        typeof schema.properties === "object"
      ) {
        // Type-safe property access
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const properties = schema.properties as Record<string, any>;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const emailProp = properties.email;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const uriProp = properties.uri;

        // Should remove unsupported formats and add descriptions
        expect(emailProp).not.toHaveProperty("format");
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(emailProp.description).toBe("A valid email address");
        expect(uriProp).not.toHaveProperty("format");
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(uriProp.description).toBe("A valid URI string");

        // Should make all properties required and disable additional properties
        expect(schema.required).toEqual(["email", "uri", "optional"]);
        expect(schema.additionalProperties).toBe(false);
      }
    });
  });

  describe("Error handling", () => {
    beforeEach(() => {
      const hostsPath = path.join(
        os.homedir(),
        ".config",
        "github-copilot",
        "hosts.json",
      );
      mockFs.setFile(hostsPath, HOSTS_JSON_CONTENT);
    });

    it("should handle authentication failures", async () => {
      const tokenScope = nock("https://api.github.com")
        .get("/copilot_internal/v2/token")
        .reply(401, "Unauthorized");

      const streamEvents: ProviderStreamEvent[] = [];
      const request = provider.sendMessage({
        model: "claude-3.7-sonnet",
        messages: SIMPLE_MESSAGES,
        onStreamEvent: (event) => streamEvents.push(event),
        tools: [],
      });

      await expect(request.promise).rejects.toThrow();
      expect(tokenScope.isDone()).toBe(true);
    });

    it("should handle streaming errors gracefully", async () => {
      const tokenScope = nock("https://api.github.com")
        .get("/copilot_internal/v2/token")
        .reply(200, GITHUB_TOKEN_RESPONSE);

      const chatScope = nock("https://api.githubcopilot.com")
        .post("/chat/completions")
        .reply(500, "Internal Server Error");

      const streamEvents: ProviderStreamEvent[] = [];
      const request = provider.sendMessage({
        model: "claude-3.7-sonnet",
        messages: SIMPLE_MESSAGES,
        onStreamEvent: (event) => streamEvents.push(event),
        tools: [],
      });

      await expect(request.promise).rejects.toThrow();
      expect(tokenScope.isDone()).toBe(true);
      expect(chatScope.isDone()).toBe(true);
    });
  });
});
