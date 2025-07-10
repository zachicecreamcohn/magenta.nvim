import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type {
  ProviderMessage,
  ProviderToolSpec,
  ProviderStreamEvent,
} from "./provider-types.ts";
import type { ToolName } from "../tools/types.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import nock from "nock";
import { withRecording } from "../test/recording.ts";
import { MockFileSystem } from "../test/mock-fs.ts";
import { AnthropicProvider } from "./anthropic.ts";

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

describe("AnthropicProvider", () => {
  let provider: AnthropicProvider;
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
    provider = new AnthropicProvider(mockNvim);
    mockFs = new MockFileSystem();
    restoreFs = mockFs.mockFsPromises();
  });

  afterEach(() => {
    nock.cleanAll();
    restoreFs();
    mockFs.clear();
    vi.clearAllMocks();
  });

  describe("Basic functionality", () => {
    it("should handle simple text response", async () => {
      await withRecording("anthropic.simple-text-response", async () => {
        const streamEvents: ProviderStreamEvent[] = [];
        const request = provider.sendMessage(
          SIMPLE_MESSAGES,
          (event) => streamEvents.push(event),
          [],
        );

        const result = await request.promise;

        expect(result.stopReason).toBe("end_turn");
        expect(streamEvents.length).toBeGreaterThan(0);
        expect(streamEvents[0].type).toBe("content_block_start");
      });
    });

    it("should handle tool use response", async () => {
      await withRecording("anthropic.tool-use-response", async () => {
        const streamEvents: ProviderStreamEvent[] = [];
        const request = provider.sendMessage(
          [
            {
              role: "user",
              content: [
                { type: "text", text: "What's the weather in London?" },
              ],
            },
          ],
          (event) => streamEvents.push(event),
          [TOOL_SPEC],
        );

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

      const params = provider.createStreamParameters([], [spec]);
      const tool = params.tools?.[0];
      if (tool?.type !== "custom") {
        return;
      }
      const schema = tool?.input_schema;

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
});
