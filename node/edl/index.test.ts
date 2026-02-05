import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RunScriptResult } from "./index.ts";
import { runScript } from "./index.ts";

let testCounter = 0;

async function withTmpDir(fn: (tmpDir: string) => Promise<void>) {
  const tmpDir = path.join(
    "/tmp/magenta-test",
    `runscript-${Date.now()}-${testCounter++}`,
  );
  await fs.mkdir(tmpDir, { recursive: true });
  try {
    await fn(tmpDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function normalizePaths(
  result: RunScriptResult,
  tmpDir: string,
): RunScriptResult {
  if (result.status === "ok") {
    return {
      status: "ok",
      result: result.result.replaceAll(tmpDir, "<tmpDir>"),
    };
  }
  return {
    status: "error",
    error: result.error.replaceAll(tmpDir, "<tmpDir>"),
  };
}

describe("runScript", () => {
  it("returns ok with trace, mutations, and final selection", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world\n", "utf-8");

      const result = await runScript(`\
file \`${filePath}\`
select_first /world/
replace <<END
planet
END`);

      expect(normalizePaths(result, tmpDir)).toMatchSnapshot();
    });
  });

  it("returns error with message and trace on execution failure", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world\n", "utf-8");

      const result = await runScript(`\
file \`${filePath}\`
select_first /hello/
select /nonexistent/`);

      expect(normalizePaths(result, tmpDir)).toMatchSnapshot();
    });
  });

  it("returns error on parse failure", async () => {
    const result = await runScript("invalidcommand blah");

    expect(result).toMatchSnapshot();
  });

  it("returns ok with no mutations when script only selects", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world\n", "utf-8");

      const result = await runScript(`\
file \`${filePath}\`
select_first /hello/`);

      expect(normalizePaths(result, tmpDir)).toMatchSnapshot();
    });
  });
});
