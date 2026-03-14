import { expect, it } from "vitest";
import { withDriver } from "../test/preamble.ts";
import { createSystemPrompt } from "./system-prompt.ts";

it("applies systemInfoOverrides for docker environments", async () => {
  await withDriver({}, async (driver) => {
    const systemPrompt = await createSystemPrompt("docker_root", {
      nvim: driver.magenta.nvim,
      cwd: driver.magenta.cwd,
      options: driver.magenta.options,
      systemInfoOverrides: {
        platform: "linux (docker)",
        cwd: "/workspace" as typeof driver.magenta.cwd,
      },
    });

    expect(systemPrompt).toContain("- Operating system: linux (docker)");
    expect(systemPrompt).toContain("- Current working directory: /workspace");
    expect(systemPrompt).toContain("# Docker Environment");
  });
});

it("includes worker branch info in docker system prompt when dockerContext is provided", async () => {
  await withDriver({}, async (driver) => {
    const systemPrompt = await createSystemPrompt("docker_root", {
      nvim: driver.magenta.nvim,
      cwd: driver.magenta.cwd,
      options: driver.magenta.options,
      dockerContext: {
        workerBranch: "magenta/worker-abcd1234",
        baseBranch: "my-feature",
      },
    });

    expect(systemPrompt).toContain("`magenta/worker-abcd1234`");
    expect(systemPrompt).toContain("`my-feature`");
    expect(systemPrompt).toContain("# Docker Environment");
  });
});

it("does not include branch info in docker prompt without dockerContext", async () => {
  await withDriver({}, async (driver) => {
    const systemPrompt = await createSystemPrompt("docker_root", {
      nvim: driver.magenta.nvim,
      cwd: driver.magenta.cwd,
      options: driver.magenta.options,
    });

    expect(systemPrompt).toContain("# Docker Environment");
    expect(systemPrompt).not.toContain("magenta/worker-");
    expect(systemPrompt).not.toContain("forked from");
  });
});
it("includes system information in the prompt", async () => {
  await withDriver({}, async (driver) => {
    const systemPrompt = await createSystemPrompt("root", {
      nvim: driver.magenta.nvim,
      cwd: driver.magenta.cwd,
      options: driver.magenta.options,
    });

    // Check that system information is included
    expect(systemPrompt).toContain("# System Information");
    expect(systemPrompt).toContain("- Current time:");
    expect(systemPrompt).toContain("- Operating system:");
    expect(systemPrompt).toContain("- Neovim version:");
    expect(systemPrompt).toContain("- Current working directory:");

    // Verify the platform is included
    expect(systemPrompt).toMatch(/- Operating system: (darwin|linux|win32)/);

    // Verify the timestamp format
    expect(systemPrompt).toMatch(
      /- Current time: \w+ \w+ \d+ \d+ \d+:\d+:\d+ GMT/,
    );

    // Verify cwd is included
    expect(systemPrompt).toContain(
      `- Current working directory: ${driver.magenta.cwd}`,
    );
  });
});
