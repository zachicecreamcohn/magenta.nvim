import { it, expect } from "vitest";
import { withDriver } from "./preamble.ts";

it("should have nvim-cmp available", async () => {
  await withDriver({}, async (driver) => {
    // Check if nvim-cmp is available
    const cmpAvailable = await driver.completions.isAvailable();
    expect(cmpAvailable).toBe(true);

    // Check if it's properly configured
    const cmpSetupInfo = await driver.completions.getSetupInfo();
    expect(cmpSetupInfo.has_sources).toBe(true);
    expect(cmpSetupInfo.has_mapping).toBe(true);
  });
});

it("should show keyword completions when typing '@' in magenta input buffer", async () => {
  await withDriver({}, async (driver) => {
    // Set up sidebar and wait for it to be ready
    await driver.showSidebar();
    await driver.waitForChatReady();

    // Switch to input window, enter insert mode and type '@' to trigger completion
    await driver.sendKeysToInputBuffer("i@");

    // Wait for completion menu to appear with expected keyword completions
    const entries = await driver.completions.waitForCompletionContaining("@qf");
    const entryWords = entries.map((e) => e.word);

    expect(entries.length).toBeGreaterThan(0);

    // Verify we have keyword completions (should include keywords from the magenta completion source)
    expect(entryWords).toContain("@qf");
    expect(entryWords).toContain("@diag");
    expect(entryWords).toContain("@buf");
    expect(entryWords).toContain("@file:");
    expect(entryWords).toContain("@diff:");
  });
});

it("should show file path completions when typing '@file:' in magenta input buffer", async () => {
  await withDriver({}, async (driver) => {
    // Set up sidebar and wait for it to be ready
    await driver.showSidebar();
    await driver.waitForChatReady();

    // Switch to input window, enter insert mode and type '@file:' to trigger file path completion
    await driver.sendKeysToInputBuffer("i@file:");

    // Wait for completion menu to appear and for file completions to be populated
    const entries =
      await driver.completions.waitForCompletionContaining("poem.txt");
    const entryWords = entries.map((e) => e.word);

    expect(entries.length).toBeGreaterThan(0);

    // We should have some file entries that start with @file:
    const fileEntries = entryWords.filter((word) => word.startsWith("@file:"));
    expect(fileEntries.length).toBeGreaterThan(0);

    // We should have entries for files in the fixtures directory
    const hasFixtureFiles = entryWords.some(
      (word) =>
        word.includes("poem.txt") ||
        word.includes("test.ts") ||
        word.includes("tsconfig.json"),
    );
    expect(hasFixtureFiles).toBe(true);
  });
});

it("should fuzzy-find in @file:", async () => {
  await withDriver({}, async (driver) => {
    // Set up sidebar and wait for it to be ready
    await driver.showSidebar();
    await driver.waitForChatReady();

    // Switch to input window, enter insert mode and type '@file:' to trigger file path completion
    await driver.sendKeysToInputBuffer("i@file:p3");

    // Wait for completion menu to appear and for file completions to be populated
    const entries =
      await driver.completions.waitForCompletionContaining("poem 3.txt");

    expect(entries.length).toEqual(1); // we filter down to just poem3, which is the only one that matches p3
  });
});

it("should prioritize open buffers first in @file: completions", async () => {
  await withDriver({}, async (driver) => {
    // First, open a specific file in a buffer
    await driver.editFile("test-auto-context.md");

    // Now set up sidebar and wait for it to be ready
    await driver.showSidebar();
    await driver.waitForChatReady();

    // Switch to input window, enter insert mode and type '@file:' to trigger file completion
    await driver.sendKeysToInputBuffer("i@file:");

    // Wait for completion menu to appear with the open buffer
    const entries = await driver.completions.waitForCompletionContaining(
      "test-auto-context.md",
    );
    expect(entries[0].word).toContain("test-auto-context.md"); // the buffer should be the top entry
  });
});
