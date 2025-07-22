import { it } from "vitest";
import { withDriver } from "./test/preamble.ts";
import type { NvimDriver } from "./test/driver.ts";

it("should track edits across multiple files", async () => {
  await withDriver({}, async (driver: NvimDriver) => {
    // Create first file and try to attach LSP
    await driver.editFile("file1.js");
    await driver.command("normal! ifunction hello() {\n  return 'world';\n}");
    await driver.command("write");

    // Create second file
    await driver.editFile("file2.js");
    await driver.command("normal! iconst greeting = 'hello';");
    await driver.command("write");

    const magenta = driver.magenta;
    magenta.changeTracker.clear();

    // Edit file1: change 'world' to 'universe'
    await driver.command("buffer file1.js");
    await driver.command("normal! /world\n");
    await driver.command("normal! ciw");
    await driver.command("normal! iuniverse");

    // Wait 300ms (longer than 150ms debounce) to ensure this edit is batched separately
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Edit file1 again: add exclamation
    await driver.command("normal! A!");

    // Wait 300ms to ensure this edit is batched separately
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Edit file2: change 'hello' to 'hi' (do it all in one command to avoid splitting)
    await driver.command("buffer file2.js");
    await driver.command("normal! /hello\nciwhi");

    // Wait 300ms to ensure the last edit is processed
    await new Promise((resolve) => setTimeout(resolve, 300));

    await driver.assertChangeTrackerHasEdits(5);

    // Verify that our expected changes are present (checking changes 0-4 in order)
    await driver.assertChangeTrackerContains([
      { oldText: "world", newText: "universe", filePath: "file1.js" },
      { newText: "const greeting = 'hello';", filePath: "file2.js" },
      { oldText: "universe", newText: "universe!", filePath: "file1.js" },
      { oldText: "'hello'", newText: "''", filePath: "file2.js" },
      { oldText: "''", newText: "hi", filePath: "file2.js" },
    ]);
  });
});
