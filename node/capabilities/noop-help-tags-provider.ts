import type { HelpTagsProvider } from "@magenta/core";

export class NoopHelpTagsProvider implements HelpTagsProvider {
  listTagFiles(): Promise<string[]> {
    return Promise.resolve([]);
  }
}
