import type { Nvim } from "../../nvim/nvim-node/index.ts";
import { pollUntil } from "../../utils/async.ts";

export class CompletionsInteraction {
  constructor(private nvim: Nvim) {}

  /**
   * Check if nvim-cmp is available
   */
  async isAvailable(): Promise<boolean> {
    return (await this.nvim.call("nvim_exec_lua", [
      `
      local ok, cmp = pcall(require, 'cmp')
      return ok
      `,
      [],
    ])) as boolean;
  }

  /**
   * Check if nvim-cmp is properly configured
   */
  async getSetupInfo(): Promise<{
    has_sources: boolean;
    has_mapping: boolean;
  }> {
    return (await this.nvim.call("nvim_exec_lua", [
      `
      local cmp = require('cmp')
      return {
        has_sources = #cmp.get_config().sources > 0,
        has_mapping = cmp.get_config().mapping ~= nil
      }
      `,
      [],
    ])) as { has_sources: boolean; has_mapping: boolean };
  }

  /**
   * Check if nvim-cmp completion menu is visible
   */
  async isVisible(): Promise<boolean> {
    return (await this.nvim.call("nvim_exec_lua", [
      `return require('cmp').visible()`,
      [],
    ])) as boolean;
  }

  /**
   * Get all completion entries
   */
  async getEntries(): Promise<Array<{ word: string; kind?: number }>> {
    return (await this.nvim.call("nvim_exec_lua", [
      `
      local cmp = require('cmp')
      local entries = cmp.get_entries()
      local result = {}
      for i, entry in ipairs(entries) do
        table.insert(result, {
          word = entry.completion_item.label,
          kind = entry.completion_item.kind
        })
      end
      return result
      `,
      [],
    ])) as Array<{ word: string; kind?: number }>;
  }

  /**
   * Get the currently selected completion entry
   */
  async getSelectedEntry(): Promise<
    { word: string; kind?: number } | undefined
  > {
    return (await this.nvim.call("nvim_exec_lua", [
      `
      local cmp = require('cmp')
      local selected = cmp.get_selected_entry()
      return selected and {
        word = selected.completion_item.label,
        kind = selected.completion_item.kind
      } or nil
      `,
      [],
    ])) as { word: string; kind?: number } | undefined;
  }

  /**
   * Manually trigger completion
   */
  async trigger(): Promise<void> {
    await this.nvim.call("nvim_exec_lua", [`require('cmp').complete()`, []]);
  }

  /**
   * Accept/confirm the current completion
   */
  async accept(): Promise<void> {
    await this.nvim.call("nvim_exec_lua", [
      `require('cmp').confirm({ select = true })`,
      [],
    ]);
  }

  /**
   * Navigate to next completion item
   */
  async selectNext(): Promise<void> {
    await this.nvim.call("nvim_exec_lua", [
      `require('cmp').select_next_item()`,
      [],
    ]);
  }

  /**
   * Navigate to previous completion item
   */
  async selectPrev(): Promise<void> {
    await this.nvim.call("nvim_exec_lua", [
      `require('cmp').select_prev_item()`,
      [],
    ]);
  }

  /**
   * Close/abort completion menu
   */
  async close(): Promise<void> {
    await this.nvim.call("nvim_exec_lua", [`require('cmp').abort()`, []]);
  }

  /**
   * Get debug information about nvim-cmp state
   */
  async getDebugInfo(): Promise<{
    mode: string;
    cmp_visible: boolean;
    cursor_pos: [number, number];
    buffer_lines: string[];
    entries_count: number;
    sources: Array<{ name: string; [key: string]: unknown }>;
  }> {
    return (await this.nvim.call("nvim_exec_lua", [
      `
      local cmp = require('cmp')
      return {
        mode = vim.fn.mode(),
        cmp_visible = cmp.visible(),
        cursor_pos = vim.api.nvim_win_get_cursor(0),
        buffer_lines = vim.api.nvim_buf_get_lines(0, 0, -1, false),
        sources = cmp.get_config().sources,
        entries_count = #cmp.get_entries()
      }
      `,
      [],
    ])) as {
      mode: string;
      cmp_visible: boolean;
      cursor_pos: [number, number];
      buffer_lines: string[];
      entries_count: number;
      sources: Array<{ name: string; [key: string]: unknown }>;
    };
  }

  /**
   * Wait for completion menu to become visible
   */
  async waitForVisible(timeout: number = 3000): Promise<void> {
    await pollUntil(
      async () => {
        const visible = await this.isVisible();
        if (!visible) {
          const debug = await this.getDebugInfo();
          throw new Error(
            `nvim-cmp completion menu not visible yet. Debug: ${JSON.stringify(debug)}`,
          );
        }
        return true;
      },
      { timeout },
    );
  }

  /**
   * Wait for completion menu to close/become invisible
   */
  async waitForInvisible(timeout: number = 3000): Promise<void> {
    await pollUntil(
      async () => {
        const visible = await this.isVisible();
        if (visible) {
          throw new Error("Completion menu should be closed");
        }
        return true;
      },
      { timeout },
    );
  }

  /**
   * Wait for a completion entry containing the specified substring to appear
   */
  async waitForCompletionContaining(
    substring: string,
    timeout: number = 5000,
  ): Promise<Array<{ word: string; kind?: number }>> {
    return await pollUntil(
      async () => {
        const entries = await this.getEntries();
        const entryWords = entries.map((e) => e.word);

        const hasSubstring = entryWords.some((word) =>
          word.includes(substring),
        );
        if (!hasSubstring) {
          throw new Error(
            `No completion entry containing "${substring}" found yet. Current entries: ${JSON.stringify(entryWords)}`,
          );
        }

        return entries;
      },
      { timeout },
    );
  }
}
