import OpenAI from "openai";
import { OpenAIProvider } from "./openai";
import ollama from "ollama";
import type { Nvim } from "nvim-node";
import { notifyErr } from "../nvim/nvim.ts";
import type { ProviderMessage, StopReason, Usage } from "./provider-types.ts";
import * as ToolManager from "../tools/toolManager.ts";
import * as InlineEdit from "../inline-edit/inline-edit-tool.ts";
import * as ReplaceSelection from "../inline-edit/replace-selection-tool.ts";
import type { Result } from "../utils/result.ts";

export type OllamaOptions = {
  model: "llama3.1:latest";
};

export class OllamaProvider extends OpenAIProvider {
  // Ollama is compatible with OpenAI API
  // See https://ollama.com/blog/openai-compatibility

  private baseUrl: string;
  private ready: boolean = false;
  private error: Error | null = null;

  constructor(
    nvim: Nvim,
    options?: {
      baseUrl?: string | undefined;
    },
  ) {
    super(nvim);

    this.baseUrl = options?.baseUrl || "http://localhost:11434/v1";

    this.client = new OpenAI({
      apiKey: "ollama",
      baseURL: this.baseUrl,
    });

    this.model = "llama3.1:latest";

    // Start initialization in the background
    // We'll properly await it when needed in setModel
    this.initialize().catch((err) => {
      this.nvim.logger?.error(
        `Ollama initialization error: ${(err as Error).message}`,
      );
    });
  }

  private async initialize(): Promise<void> {
    try {
      const isInstalled = await this.isOllamaInstalled();
      if (!isInstalled) {
        this.error = new Error("Ollama is not installed or not running.");
        return;
      }

      const isDownloaded = await this.isModelDownloaded(this.model, true);
      if (!isDownloaded) {
        this.error = new Error(
          `Model ${this.model} is not downloaded. Run 'ollama pull ${this.model}'`,
        );
        return;
      }

      this.ready = true;
      this.error = null;
    } catch (error) {
      this.error = error instanceof Error ? error : new Error(String(error));
      this.ready = false;
    }
  }

  async setModel(model: string) {
    try {
      if (!this.ready && !this.error) {
        this.nvim.logger?.info(
          "Waiting for Ollama initialization to complete...",
        );
        await this.initialize();
      }

      if (!(await this.isOllamaInstalled())) {
        this.error = new Error("Ollama is not installed or not running.");
        this.ready = false;
        await notifyErr(this.nvim, this.error.message);
        return;
      }

      const modelIsDownloaded = await this.isModelDownloaded(model, false);
      if (!modelIsDownloaded) {
        this.error = new Error(
          `Model '${model}' is not downloaded. Please run 'ollama pull ${model}' first.`,
        );
        this.ready = false;
        this.nvim.logger?.error(this.error.message);
        await notifyErr(this.nvim, this.error.message);
        return;
      }

      await super.setModel(model);
      this.ready = true;
      this.error = null;
      this.nvim.logger?.info(`Ollama model '${model}' set successfully`);
    } catch (error) {
      this.error = error instanceof Error ? error : new Error(String(error));
      this.ready = false;
      this.nvim.logger?.error(
        `Error setting Ollama model: ${this.error.message}`,
      );
      await notifyErr(
        this.nvim,
        `Failed to set Ollama model: ${this.error.message}`,
      );
    }
  }

  private async checkReady(): Promise<{
    isReady: boolean;
    errorResponse: {
      stopReason: StopReason;
      usage: Usage;
    } | null;
  }> {
    if (!this.ready) {
      const errorMsg =
        this.error?.message ||
        "Ollama provider is not ready. Please check if Ollama is running and the model is downloaded.";

      await notifyErr(this.nvim, errorMsg);
      return {
        isReady: false,
        errorResponse: {
          stopReason: "error" as StopReason,
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      };
    }
    return { isReady: true, errorResponse: null };
  }

  async sendMessage(
    messages: Array<ProviderMessage>,
    onText: (text: string) => void,
  ): Promise<{
    toolRequests: Result<ToolManager.ToolRequest, { rawRequest: unknown }>[];
    stopReason: StopReason;
    usage: Usage;
  }> {
    const { isReady, errorResponse } = await this.checkReady();
    if (!isReady && errorResponse) {
      return {
        toolRequests: [],
        stopReason: errorResponse.stopReason,
        usage: errorResponse.usage,
      };
    }
    return super.sendMessage(messages, onText);
  }

  async inlineEdit(messages: Array<ProviderMessage>): Promise<{
    inlineEdit: Result<
      InlineEdit.InlineEditToolRequest,
      { rawRequest: unknown }
    >;
    stopReason: StopReason;
    usage: Usage;
  }> {
    const { isReady, errorResponse } = await this.checkReady();
    if (!isReady && errorResponse) {
      return {
        inlineEdit: {
          status: "error",
          error: this.error?.message || "Ollama provider is not ready",
          rawRequest: {},
        },
        stopReason: errorResponse.stopReason,
        usage: errorResponse.usage,
      };
    }
    return super.inlineEdit(messages);
  }

  async replaceSelection(messages: Array<ProviderMessage>): Promise<{
    replaceSelection: Result<
      ReplaceSelection.ReplaceSelectionToolRequest,
      { rawRequest: unknown }
    >;
    stopReason: StopReason;
    usage: Usage;
  }> {
    const { isReady, errorResponse } = await this.checkReady();
    if (!isReady && errorResponse) {
      return {
        replaceSelection: {
          status: "error",
          error: this.error?.message || "Ollama provider is not ready",
          rawRequest: {},
        },
        stopReason: errorResponse.stopReason,
        usage: errorResponse.usage,
      };
    }
    return super.replaceSelection(messages);
  }

  private async isModelDownloaded(modelName: string, notifyOnError = false) {
    try {
      const { models } = await ollama.list();
      const modelExists = models.some((m) => m.name === modelName);

      if (!modelExists && notifyOnError) {
        const errorMsg = `Model ${modelName} is not downloaded. Run 'ollama pull ${modelName}'`;
        this.nvim.logger?.error(errorMsg);
        await notifyErr(
          this.nvim,
          `Ollama model '${modelName}' is not found. Please run 'ollama pull ${modelName}' to download it.`,
        );
      }

      return modelExists;
    } catch (error) {
      this.nvim.logger?.error(
        `Error checking for Ollama model: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (notifyOnError) {
        await notifyErr(
          this.nvim,
          `Failed to check Ollama models: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return false;
    }
  }

  private async isOllamaInstalled() {
    try {
      const testUrl = new URL(this.baseUrl).origin;
      const res = await fetch(testUrl);
      const isInstalled = res.ok;

      if (!isInstalled) {
        this.nvim.logger?.error("Ollama is not running or not installed.");
        await notifyErr(
          this.nvim,
          "Ollama is not running. Please start Ollama or install it from https://ollama.com/",
        );
      }

      return isInstalled;
    } catch {
      this.nvim.logger?.error("Failed to connect to Ollama server.");
      await notifyErr(
        this.nvim,
        "Failed to connect to Ollama server. Please make sure Ollama is running.",
      );
      return false;
    }
  }
}
