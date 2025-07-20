import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getProvider, setClient } from "./provider";
import type { ProviderName, ProviderStreamEvent } from "./provider-types";
import { withNvimClient } from "../test/preamble";

interface MockOpenAIConfig {
  baseURL?: string;
  apiKey?: string;
}

let lastOpenAIConfig: MockOpenAIConfig | undefined;
let mockStreamEvents: unknown[] = [];
vi.mock("openai", () => {
  class MockOpenAI {
    responses = {
      create: vi.fn().mockImplementation(() => {
        return {
          // eslint-disable-next-line @typescript-eslint/require-await
          [Symbol.asyncIterator]: async function* () {
            for (const event of mockStreamEvents) {
              yield event;
            }
          },
          controller: {
            abort: vi.fn(),
          },
        };
      }),
    };

    constructor(config: MockOpenAIConfig) {
      lastOpenAIConfig = config;
    }
  }

  return {
    default: MockOpenAI,
  };
});

describe("OpenAIProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastOpenAIConfig = undefined;
    mockStreamEvents = [];
    process.env.OPENAI_API_KEY = "test-key";
    setClient("openai", undefined);
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("should correctly reset baseUrl when switching between profiles with different baseUrls", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    await withNvimClient(async (nvim) => {
      const profile1 = {
        name: "gpt-4o",
        provider: "openai" as ProviderName,
        model: "gpt-4o",
        fastModel: "gpt-4o",
        baseUrl: "https://api.openai.com/v1",
      };

      const profile2 = {
        name: "qwen3:14b",
        provider: "openai" as ProviderName,
        model: "qwen3:14b",
        fastModel: "qwen3:14b",
        baseUrl: "http://localhost:11434/v1",
      };

      const provider1 = getProvider(nvim, profile1);
      expect(provider1).toBeDefined();

      expect(lastOpenAIConfig).toHaveProperty(
        "baseURL",
        "https://api.openai.com/v1",
      );

      const provider2 = getProvider(nvim, profile2);
      expect(provider2).toBeDefined();

      expect(lastOpenAIConfig).toHaveProperty(
        "baseURL",
        "http://localhost:11434/v1",
      );

      expect(provider1).not.toBe(provider2);
    });
  });

  it("should handle reasoning events correctly", async () => {
    await withNvimClient(async (nvim) => {
      const profile = {
        name: "gpt-4o",
        provider: "openai" as ProviderName,
        model: "gpt-4o",
        fastModel: "gpt-4o",
      };

      // Set up mock stream events from the notes
      mockStreamEvents = [
        // Initial reasoning item with encrypted content
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "reasoning",
            id: "item-123",
            encrypted_content: "encrypted-data-456",
          },
        },
        // First summary part
        {
          type: "response.reasoning_summary_part.added",
          summary_index: 0,
          item_id: "item-123",
        },
        {
          type: "response.reasoning_summary_text.delta",
          summary_index: 0,
          item_id: "item-123",
          delta: "First part of thinking",
        },
        {
          type: "response.reasoning_summary_text.delta",
          summary_index: 0,
          item_id: "item-123",
          delta: " continues here",
        },
        {
          type: "response.reasoning_summary_text.done",
          summary_index: 0,
          item_id: "item-123",
        },
        {
          type: "response.reasoning_summary_part.done",
          summary_index: 0,
          item_id: "item-123",
        },
        // Second summary part
        {
          type: "response.reasoning_summary_part.added",
          summary_index: 1,
          item_id: "item-123",
        },
        {
          type: "response.reasoning_summary_text.delta",
          summary_index: 1,
          item_id: "item-123",
          delta: "Second thinking part",
        },
        {
          type: "response.reasoning_summary_text.done",
          summary_index: 1,
          item_id: "item-123",
        },
        {
          type: "response.reasoning_summary_part.done",
          summary_index: 1,
          item_id: "item-123",
        },
        // End reasoning item
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "reasoning",
            id: "item-123",
          },
        },
        // Completion event
        {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 100,
              output_tokens: 50,
            },
          },
        },
      ];

      const provider = getProvider(nvim, profile);
      const capturedEvents: ProviderStreamEvent[] = [];

      const streamRequest = provider.sendMessage({
        model: "gpt-4o",
        messages: [
          { role: "user", content: [{ type: "text", text: "Test message" }] },
        ],
        onStreamEvent: (event) => capturedEvents.push(event),
        tools: [],
      });

      await streamRequest.promise;

      // Expected events based on the implementation:
      expect(capturedEvents).toEqual([
        // Redacted thinking block (start + end)
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "redacted_thinking",
            data: "encrypted-data-456",
          },
          providerMetadata: {
            openai: {
              itemId: "item-123",
            },
          },
        },
        {
          type: "content_block_stop",
          index: 0,
          providerMetadata: {
            openai: {
              itemId: "item-123",
            },
          },
        },
        // First thinking block
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "thinking",
            thinking: "",
            signature: "",
          },
          providerMetadata: {
            openai: {
              itemId: "item-123",
              summaryIndex: 0,
            },
          },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: "First part of thinking",
          },
          providerMetadata: {
            openai: {
              itemId: "item-123",
              summaryIndex: 0,
            },
          },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: " continues here",
          },
          providerMetadata: {
            openai: {
              itemId: "item-123",
              summaryIndex: 0,
            },
          },
        },
        {
          type: "content_block_stop",
          index: 0,
          providerMetadata: {
            openai: {
              itemId: "item-123",
              summaryIndex: 0,
            },
          },
        },
        // Second thinking block
        {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "thinking",
            thinking: "",
            signature: "",
          },
          providerMetadata: {
            openai: {
              itemId: "item-123",
              summaryIndex: 1,
            },
          },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "thinking_delta",
            thinking: "Second thinking part",
          },
          providerMetadata: {
            openai: {
              itemId: "item-123",
              summaryIndex: 1,
            },
          },
        },
        {
          type: "content_block_stop",
          index: 1,
          providerMetadata: {
            openai: {
              itemId: "item-123",
              summaryIndex: 1,
            },
          },
        },
      ]);
    });
  });
});
