import type { Command } from "./types.ts";
import type { ProviderMessageContent } from "../../providers/provider-types.ts";
import { getDiagnostics } from "../../utils/diagnostics.ts";

export const diagCommand: Command = {
  name: "@diag",
  description: "Add diagnostics to context",
  pattern: /@diag\b/,
  async execute(_match, context): Promise<ProviderMessageContent[]> {
    try {
      const diagnostics = await getDiagnostics(context.nvim);
      // Append diagnostics as a separate content block
      return [
        {
          type: "text",
          text: `Current diagnostics:\n${diagnostics}`,
        },
      ];
    } catch (error) {
      context.nvim.logger.error(
        `Failed to fetch diagnostics for message: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Append error message as a separate content block
      return [
        {
          type: "text",
          text: `Error fetching diagnostics: ${error instanceof Error ? error.message : String(error)}`,
        },
      ];
    }
  },
};

export const diagnosticsCommand: Command = {
  name: "@diagnostics",
  description: "Add diagnostics to context",
  pattern: /@diagnostics\b/,
  async execute(_match, context): Promise<ProviderMessageContent[]> {
    try {
      const diagnostics = await getDiagnostics(context.nvim);
      // Append diagnostics as a separate content block
      return [
        {
          type: "text",
          text: `Current diagnostics:\n${diagnostics}`,
        },
      ];
    } catch (error) {
      context.nvim.logger.error(
        `Failed to fetch diagnostics for message: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Append error message as a separate content block
      return [
        {
          type: "text",
          text: `Error fetching diagnostics: ${error instanceof Error ? error.message : String(error)}`,
        },
      ];
    }
  },
};
