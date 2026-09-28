import { pendingMessage } from "@magenta/server";
import { describe, expect, it } from "vitest";
import { resolveSubmission, type SubmissionCommands } from "./nvim-editor.ts";

const fileContent = { type: "text" as const, text: "contents of foo.ts" };
const context = {
  getOptions: () => ({}),
  commandRegistry: {
    processMessage: async (text: string) => ({
      processedText: text,
      additionalContent: text.includes("@file:foo.ts") ? [fileContent] : [],
      reminders: [],
    }),
  },
} as unknown as SubmissionCommands;
const resolve = (text: string, canCompact: boolean) =>
  resolveSubmission(pendingMessage(text), context, {
    cwd: "/" as never,
    homeDir: "/" as never,
    getContextFiles: () => ({}) as never,
    canCompact,
  });

describe("resolveSubmission", () => {
  it("expands the rest of an @compact into the compact handoff", async () => {
    expect(await resolve("@compact look at @file:foo.ts", true)).toEqual({
      type: "compact",
      prompt: {
        content: [{ type: "text", text: "look at @file:foo.ts" }, fileContent],
        reminders: [],
      },
    });
  });

  it("sends @compact as ordinary text in a compact thread", async () => {
    expect(await resolve("@compact", false)).toEqual({
      type: "send",
      prompt: { content: [{ type: "text", text: "@compact" }], reminders: [] },
    });
  });
});
