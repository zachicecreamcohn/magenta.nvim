import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import { OllamaProvider } from "./ollama";
import type { Nvim } from "nvim-node";
import type { Logger } from "winston";

vi.mock("ollama", () => ({
  default: {
    list: vi.fn(),
  },
}));

import ollama from "ollama";
import type OpenAI from "openai";

global.fetch = vi.fn() as unknown as typeof fetch;

describe("OllamaProvider", () => {
  beforeAll(() => {
    vi.useFakeTimers();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  const mockLogger: Partial<Logger> = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  };

  const mockNvim: Partial<Nvim> = {
    logger: mockLogger as Logger,
    call: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    vi.restoreAllMocks();

    (global.fetch as ReturnType<typeof vi.fn>).mockReset();
    (ollama.list as ReturnType<typeof vi.fn>).mockReset();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  const accessPrivate = (provider: OllamaProvider) => {
    return provider as unknown as {
      isOllamaInstalled: () => Promise<boolean>;
      isModelDownloaded: (
        modelName: string,
        notifyOnError?: boolean,
      ) => Promise<boolean>;
      initialize: () => Promise<void>;
      ready: boolean;
      error: Error | null;
    };
  };
  const createProvider = async () => {
    const provider = new OllamaProvider(mockNvim as Nvim);
    await vi.runAllTimersAsync();

    return provider;
  };

  describe("isOllamaInstalled", () => {
    it("returns true when Ollama is running", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
      });

      const provider = new OllamaProvider(mockNvim as Nvim);
      const isInstalled = await accessPrivate(provider).isOllamaInstalled();

      expect(isInstalled).toBe(true);
      expect(global.fetch).toHaveBeenCalled();
      expect(mockNvim.logger?.error).not.toHaveBeenCalled();
    });

    it("returns false when Ollama is not running", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
      });

      const provider = new OllamaProvider(mockNvim as Nvim);
      const isInstalled = await accessPrivate(provider).isOllamaInstalled();

      expect(isInstalled).toBe(false);
      expect(global.fetch).toHaveBeenCalled();
      expect(mockNvim.logger?.error).toHaveBeenCalled();
    });

    it("returns false when fetch throws an error", async () => {
      // Mock fetch throwing an error
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Network error"),
      );

      const provider = new OllamaProvider(mockNvim as Nvim);
      const isInstalled = await accessPrivate(provider).isOllamaInstalled();

      expect(isInstalled).toBe(false);
      expect(global.fetch).toHaveBeenCalled();
      expect(mockNvim.logger?.error).toHaveBeenCalled();
    });
  });

  describe("isModelDownloaded", () => {
    it("returns true when model is downloaded", async () => {
      (ollama.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        models: [{ name: "llama3.1:latest" }],
      });

      // Mock successful fetch response for Ollama server running locally
      // The provider confirms Ollama is running separately from confirming the requested model is downloaded
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
      });

      const provider = await createProvider();
      const isDownloaded = await accessPrivate(provider).isModelDownloaded(
        "llama3.1:latest",
        false,
      );

      expect(isDownloaded).toBe(true);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(ollama.list).toHaveBeenCalled();
      expect(mockNvim.logger?.error).not.toHaveBeenCalled();
    });

    it("returns false when model is not downloaded", async () => {
      (ollama.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        models: [{ name: "different-model:latest" }],
      });

      const provider = await createProvider();
      const isDownloaded = await accessPrivate(provider).isModelDownloaded(
        "llama3.1:latest",
        false,
      );

      expect(isDownloaded).toBe(false);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(ollama.list).toHaveBeenCalled();
    });

    it("notifies about missing model when notifyOnError is true", async () => {
      (ollama.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        models: [{ name: "different-model:latest" }],
      });

      const provider = await createProvider();
      const isDownloaded = await accessPrivate(provider).isModelDownloaded(
        "llama3.1:latest",
        true,
      );

      expect(isDownloaded).toBe(false);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(ollama.list).toHaveBeenCalled();
      expect(mockNvim.logger?.error).toHaveBeenCalled();
    });

    it("returns false and logs error when ollama.list throws", async () => {
      (ollama.list as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("API error"),
      );

      const provider = await createProvider();
      const isDownloaded = await accessPrivate(provider).isModelDownloaded(
        "llama3.1:latest",
        true,
      );

      expect(isDownloaded).toBe(false);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(ollama.list).toHaveBeenCalled();
      expect(mockNvim.logger?.error).toHaveBeenCalled();
    });
  });

  describe("initialize", () => {
    it("sets ready to true when Ollama is installed and model is downloaded", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
      });
      (ollama.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        models: [{ name: "llama3.1:latest" }],
      });

      const provider = await createProvider();

      await accessPrivate(provider).initialize();

      expect(accessPrivate(provider).ready).toBe(true);
      expect(accessPrivate(provider).error).toBe(null);
    });

    it("sets ready to false when Ollama is not installed", async () => {
      // Set up mocks before creating the provider
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
      });

      const provider = await createProvider();

      await accessPrivate(provider).initialize();

      expect(accessPrivate(provider).ready).toBe(false);
      expect(accessPrivate(provider).error).toBeTruthy();
      expect(accessPrivate(provider).error?.message).toContain(
        "Ollama is not installed or not running",
      );
    });

    it("sets ready to false when model is not downloaded", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
      });
      (ollama.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        models: [{ name: "different-model:latest" }],
      });

      const provider = await createProvider();

      await accessPrivate(provider).initialize();

      expect(accessPrivate(provider).ready).toBe(false);
      expect(accessPrivate(provider).error).toBeTruthy();
      expect(accessPrivate(provider).error?.message).toContain(
        "is not downloaded",
      );
    });

    it("captures error message when initialization fails", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Connection refused"),
      );

      const provider = await createProvider();

      await accessPrivate(provider).initialize();

      expect(accessPrivate(provider).ready).toBe(false);
      expect(accessPrivate(provider).error).toBeTruthy();
    });
  });
});

describe("OllamaProvider.sendMessage", () => {
  const mockLogger: Partial<Logger> = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  };

  const mockNvim: Partial<Nvim> = {
    logger: mockLogger as Logger,
    call: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  const accessPrivate = (provider: OllamaProvider) => {
    return provider as unknown as {
      ready: boolean;
      error: Error | null;
    };
  };

  it("counts input and output tokens correctly", async () => {
    vi.mock("tiktoken", () => ({
      default: {
        get_encoding: () => ({
          encode: () => new Array<number>(5).fill(0),
          free: vi.fn(),
        }),
      },
    }));

    const provider = new OllamaProvider(mockNvim as Nvim);

    accessPrivate(provider).ready = true;

    (provider as unknown as { client: OpenAI }).client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            [Symbol.asyncIterator]: function* () {
              yield {
                choices: [
                  {
                    delta: { content: "Test response" },
                    finish_reason: "stop",
                  },
                ],
              };
            },
            controller: { abort: vi.fn() },
          }),
        } as unknown as OpenAI["chat"]["completions"],
      },
    } as OpenAI;

    const result = await provider.sendMessage(
      [{ role: "user", content: "Test" }],
      () => {},
    );

    expect(result.usage.inputTokens).toBe(5);
    expect(result.usage.outputTokens).toBe(5);
  });
});
