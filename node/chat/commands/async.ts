import type { Command } from "./types.ts";
import type { ProviderMessageContent } from "../../providers/provider-types.ts";

export const asyncCommand: Command = {
  name: "@async",
  description:
    "Process message asynchronously without interrupting current operation",
  pattern: /^@async\b/,
  execute(): Promise<ProviderMessageContent[]> {
    // The async command doesn't add content, it just marks the message for async processing
    // This is handled specially in thread.ts
    return Promise.resolve([]);
  },
};
