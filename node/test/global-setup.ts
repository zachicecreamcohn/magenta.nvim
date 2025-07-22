import { access } from "node:fs/promises";
import * as path from "node:path";
import { $, within } from "zx";

export async function setup() {
  // Get project root by going up from node/test/global-setup.ts to project root
  const projectRoot = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../..",
  );
  const pluginDir = path.join(projectRoot, "test-plugins");
  const cmpDir = path.join(pluginDir, "nvim-cmp");
  const forceSetup = process.env.FORCE_SETUP === "true";

  // Force remove existing directories if FORCE_SETUP is set
  if (forceSetup) {
    try {
      await $`rm -rf ${cmpDir}`;
    } catch {
      // Ignore errors if directory doesn't exist
    }
  }

  try {
    await access(cmpDir);
  } catch {
    try {
      // Plugin doesn't exist, need to download it
      await $`mkdir -p ${pluginDir}`;
      await $`git clone --depth=1 https://github.com/hrsh7th/nvim-cmp.git ${cmpDir}`;
    } catch (e) {
      console.error(`Uh-oh. nvim-cmp setup failed`);
      console.error(e);
    }
  }

  // Set up git repo in fixtures directory
  const fixturesDir = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "fixtures",
  );

  // Force remove existing git repo if FORCE_SETUP is set
  if (forceSetup) {
    try {
      await $`rm -rf ${path.join(fixturesDir, ".git")}`;
    } catch {
      // Ignore errors if directory doesn't exist
    }
  }

  try {
    await access(path.join(fixturesDir, ".git"));
  } catch {
    try {
      await within(async () => {
        $.cwd = fixturesDir;
        await $`git init`;
      });
    } catch (e) {
      console.error(`Uh-oh. git is already initialized`);
      console.error(e);
    }
  }
}

export async function teardown() {
  // Any global cleanup can go here if needed
}
