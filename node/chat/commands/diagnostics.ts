import type { Command } from "./types.ts";
import type { ProviderMessageContent } from "../../providers/provider-types.ts";
import { getDiagnostics } from "../../utils/diagnostics.ts";

export const diagCommand: Command = {
  name: "@diag",
  description: "Add diagnostics to context",
  pattern: /@diag\b/,
  async execute(_match, context): Promise<ProviderMessageContent[]> {
    const diagnostics = await getDiagnostics(context.nvim);
    return [
      {
        type: "text",
        text: `Current diagnostics:\n${diagnostics}`,
      },
    ];
  },
};

export const diagnosticsCommand: Command = {
  name: "@diagnostics",
  description: "Add diagnostics to context",
  pattern: /@diagnostics\b/,
  async execute(_match, context): Promise<ProviderMessageContent[]> {
    const diagnostics = await getDiagnostics(context.nvim);
    return [
      {
        type: "text",
        text: `Current diagnostics:\n${diagnostics}`,
      },
    ];
  },
};
