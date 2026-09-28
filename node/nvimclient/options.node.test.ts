import { expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_POSITION_OPTS,
  parseClientOptions,
} from "./options.ts";

it("warns about server-only keys passed to setup() and ignores them", () => {
  const warnings: string[] = [];
  const options = parseClientOptions(
    {
      profiles: [{ name: "x", provider: "mock" }],
      autoContext: [],
      sidebarPosition: "right",
    },
    { warn: (msg) => warnings.push(msg) },
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("profiles, autoContext");
  expect(warnings[0]).toContain("~/.magenta/options.json");
  expect(options).not.toHaveProperty("profiles");
  expect(options.sidebarPosition).toBe("right");
});

it("keeps the defaults for sidebar positions the config does not name", () => {
  const options = parseClientOptions(
    { sidebarPositionOpts: { left: { displayHeightPercentage: 0.5 } } },
    { warn: () => {} },
  );
  expect(options.sidebarPositionOpts).toEqual({
    ...DEFAULT_SIDEBAR_POSITION_OPTS,
    left: { displayHeightPercentage: 0.5 },
  });
});
