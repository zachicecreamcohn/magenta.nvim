import type { HelpTagsProvider } from "@magenta/core";
import type { Nvim } from "../nvim/nvim-node/index.ts";

export class NvimHelpTagsProvider implements HelpTagsProvider {
  constructor(private nvim: Nvim) {}

  async listTagFiles(): Promise<string[]> {
    const paths = await this.nvim.call("nvim_get_runtime_file", [
      "doc/tags",
      true,
    ]);
    return paths;
  }
}
