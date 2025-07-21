import { describe, it, expect } from "vitest";
import { withDriver } from "./preamble.ts";

describe("nvim-cmp completions", () => {
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
});
