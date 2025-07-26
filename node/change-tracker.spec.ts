import { expect, it } from "vitest";
import { withDriver } from "./test/preamble.ts";
import type { NvimDriver } from "./test/driver.ts";
import { writeFileSync } from "fs";
import { join } from "path";

it("should track edits across multiple files", async () => {
  await withDriver(
    {
      options: {
        lspDebounceMs: 100, // Use shorter debounce for faster tests
      },
    },
    async (driver: NvimDriver) => {
      // Write files directly to disk
      writeFileSync(
        join(driver.magenta.cwd, "file1.js"),
        "function hello() {\n  return 'world';\n}",
      );
      writeFileSync(
        join(driver.magenta.cwd, "file2.js"),
        "const greeting = 'hello';",
      );

      // Open the files in vim
      await driver.editFile("file1.js");
      await driver.editFile("file2.js");

      // // Edit file1: change 'world' to 'universe'
      await driver.command("buffer file1.js");
      await driver.command("normal! /world\n");
      await driver.command("normal! ciwuniverse");

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Edit file1 again: add exclamation
      await driver.command("normal! a!");

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Edit file2: change 'hello' to 'hi' (do it all in one command to avoid splitting)
      await driver.command("buffer file2.js");
      await driver.command("normal! /hello\nciwhi");

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Test typing in insert mode using nvim_feedkeys
      await driver.command("normal! G"); // Go to end of file

      // Use feedkeys to enter insert mode and type
      const keysToType = "o// Added via insert mode typing<Esc>";
      const escapedKeys = await driver.nvim.call("nvim_replace_termcodes", [
        keysToType,
        true,
        false,
        true,
      ]);
      await driver.nvim.call("nvim_feedkeys", [escapedKeys, "n", false]);

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify that our expected changes are present (checking changes 0-4 in order)
      await driver.assertChangeTrackerContains([
        { oldText: "world", newText: "universe", filePath: "file1.js" },
        { oldText: "universe", newText: "universe!", filePath: "file1.js" },
        { oldText: "hello", newText: "hi", filePath: "file2.js" },
        {
          oldText: "const greeting = 'hi';",
          newText: "const greeting = 'hi';\n",
          filePath: "file2.js",
        },
        {
          oldText: "const greeting = 'hi';\n",
          newText: "const greeting = 'hi';\n// Added via insert mode typing\n",
          filePath: "file2.js",
        },
      ]);

      const changes = driver.magenta.changeTracker
        .getChanges()
        .map((change) => {
          // Remove timestamp and make paths relative for consistent snapshots
          const { timestamp, ...changeWithoutTimestamp } = change;
          return changeWithoutTimestamp;
        });
      expect(changes).toMatchSnapshot();
    },
  );
});
