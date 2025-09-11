import type { Command } from "./types.ts";
import type { ProviderMessageContent } from "../../providers/provider-types.ts";

export const forkCommand: Command = {
  name: "@fork",
  description: "Fork the current thread",
  pattern: /@fork\b/,
  execute(_match, _context): Promise<ProviderMessageContent[]> {
    // The fork command doesn't add content directly, it's handled by the thread
    // This is a placeholder that will be handled specially in thread.ts
    return Promise.resolve([]);
  },
};
