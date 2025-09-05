import { it, expect } from "vitest";
import { createSystemPrompt } from "./system-prompt.ts";
import { withDriver } from "../test/preamble.ts";
import type { MagentaOptions } from "../options.ts";

it("includes system information in the prompt", async () => {
  await withDriver({}, async (driver) => {
    const systemPrompt = await createSystemPrompt(
      "root",
      driver.magenta.nvim,
      driver.magenta.cwd,
      driver.magenta.options,
    );

    // Check that system information is included
    expect(systemPrompt).toContain("# System Information");
    expect(systemPrompt).toContain("- Current time:");
    expect(systemPrompt).toContain("- Operating system:");
    expect(systemPrompt).toContain("- Neovim version:");
    expect(systemPrompt).toContain("- Current working directory:");
  });
});

it("uses custom system prompt when configured", async () => {
  await withDriver({}, async (driver) => {
    const optionsWithCustomPrompt: MagentaOptions = {
      ...driver.magenta.options,
      systemPrompt: "You are a custom AI assistant.",
    };

    const systemPrompt = await createSystemPrompt(
      "root",
      driver.magenta.nvim,
      driver.magenta.cwd,
      optionsWithCustomPrompt,
    );

    expect(systemPrompt).toContain("You are a custom AI assistant");
    expect(systemPrompt).not.toContain("You are a coding assistant");
    // System info should still be included
    expect(systemPrompt).toContain("# System Information");
  });
});
