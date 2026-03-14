import { describe, expect, it } from "vitest";
import { getSubsequentReminder } from "./system-reminders.ts";

describe("getSubsequentReminder", () => {
  it("conductor reminder includes skills, bash, edl, explore reminders", () => {
    const reminder = getSubsequentReminder("conductor");
    expect(reminder).toContain("<system-reminder>");
    expect(reminder).toContain("Remember the skills");
    expect(reminder).toContain("bash_command");
    expect(reminder).toContain("EDL");
    expect(reminder).toContain("explore agent");
    expect(reminder).toContain("conductor");
  });

  it("conductor reminder does not include yield_to_parent", () => {
    const reminder = getSubsequentReminder("conductor");
    expect(reminder).not.toContain("yield_to_parent");
  });

  it("root reminder does not include conductor workflow", () => {
    const reminder = getSubsequentReminder("root");
    expect(reminder).not.toContain("conductor");
  });
});
