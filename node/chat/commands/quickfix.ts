import type { Command } from "./types.ts";
import type { ProviderMessageContent } from "../../providers/provider-types.ts";
import { getQuickfixList, quickfixListToString } from "../../nvim/nvim.ts";

export const qfCommand: Command = {
  name: "@qf",
  description: "Add quickfix entries to context",
  pattern: /@qf\b/,
  async execute(_match, context): Promise<ProviderMessageContent[]> {
    const qflist = await getQuickfixList(context.nvim);
    const quickfixStr = await quickfixListToString(qflist, context.nvim);
    return [
      {
        type: "text",
        text: `Current quickfix list:\n${quickfixStr}`,
      },
    ];
  },
};

export const quickfixCommand: Command = {
  name: "@quickfix",
  description: "Add quickfix entries to context",
  pattern: /@quickfix\b/,
  async execute(_match, context): Promise<ProviderMessageContent[]> {
    const qflist = await getQuickfixList(context.nvim);
    const quickfixStr = await quickfixListToString(qflist, context.nvim);
    return [
      {
        type: "text",
        text: `Current quickfix list:\n${quickfixStr}`,
      },
    ];
  },
};
