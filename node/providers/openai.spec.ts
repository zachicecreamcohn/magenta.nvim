import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getProvider, setClient } from "./provider";
import type { ProviderName } from "./provider-types";
import { withNvimClient } from "../test/preamble";

interface MockOpenAIConfig {
  baseURL?: string;
  apiKey?: string;
}

let lastOpenAIConfig: MockOpenAIConfig | undefined;

vi.mock("openai", () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: vi.fn().mockResolvedValue({
          [Symbol.asyncIterator]: () => ({
            next: vi.fn().mockResolvedValue({ done: true }),
          }),
        }),
      },
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
        baseUrl: "https://api.openai.com/v1",
      };

      const profile2 = {
        name: "qwen3:14b",
        provider: "openai" as ProviderName,
        model: "qwen3:14b",
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
});
