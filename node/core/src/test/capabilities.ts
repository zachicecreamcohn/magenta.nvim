type TestMode = "all" | "sandbox";

const testMode: TestMode =
  (process.env.TEST_MODE as TestMode | undefined) ?? "all";

export const FULL_CAPABILITIES = testMode === "all";
