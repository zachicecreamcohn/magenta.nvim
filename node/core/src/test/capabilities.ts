import { existsSync } from "node:fs";

type TestMode = "all" | "sandbox";

const testMode: TestMode =
  (process.env.TEST_MODE as TestMode | undefined) ?? "all";

export const FULL_CAPABILITIES = testMode === "all";

// Docker-in-Docker doesn't work because `docker cp` writes to the host
// filesystem while `rsync` runs inside the container, causing path mismatches.
// These tests must run on the host directly.
export const HOST_DOCKER_AVAILABLE =
  FULL_CAPABILITIES && !existsSync("/.dockerenv");
