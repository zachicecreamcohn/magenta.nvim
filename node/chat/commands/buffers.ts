import type { Command } from "./types.ts";
import type { ProviderMessageContent } from "../../providers/provider-types.ts";
import { getBuffersList } from "../../utils/listBuffers.ts";

export const bufCommand: Command = {
  name: "@buf",
  description: "Add current buffer to context",
  pattern: /@buf\b/,
  async execute(_match, context): Promise<ProviderMessageContent[]> {
    const buffersList = await getBuffersList(context.nvim);
    return [
      {
        type: "text",
        text: `Current buffers list:\n${buffersList}`,
      },
    ];
  },
};

export const buffersCommand: Command = {
  name: "@buffers",
  description: "Add all open buffers to context",
  pattern: /@buffers\b/,
  async execute(_match, context): Promise<ProviderMessageContent[]> {
    const buffersList = await getBuffersList(context.nvim);
    return [
      {
        type: "text",
        text: `Current buffers list:\n${buffersList}`,
      },
    ];
  },
};
