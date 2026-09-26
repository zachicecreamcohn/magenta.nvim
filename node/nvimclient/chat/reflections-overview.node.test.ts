import type {
  ContentBlockIdx,
  DisplayBufferText,
  MessageIdx,
  Session,
  ThreadId,
  ThreadOrigin,
} from "@magenta/server";
import { expect, it } from "vitest";
import { entryAtLine, orderedReflections } from "./reflections-overview.ts";

function entry(id: string, messageIdx: number, contentIdx: number) {
  const origin: Extract<ThreadOrigin, { type: "reflect" }> = {
    type: "reflect",
    sourceThreadId: "src" as ThreadId,
    anchor: {
      messageIdx: messageIdx as MessageIdx,
      contentIdx: contentIdx as ContentBlockIdx,
      reflectionText: id as DisplayBufferText,
    },
  };
  return { threadId: id as ThreadId, origin };
}

const derived = [
  entry("m3c0", 3, 0),
  entry("m1c2", 1, 2),
  entry("m1c0-late", 1, 0),
  entry("m1c0-early", 1, 0),
];
// Creation order is list order; reverse the tie so creation order matters.
derived.splice(2, 2, derived[3], derived[2]);
const session = {
  listDerived: () => derived,
} as unknown as Pick<Session, "listDerived">;

it("orders by messageIdx, then contentIdx, then creation", () => {
  expect(
    orderedReflections(session, "src" as ThreadId).map((e) => e.threadId),
  ).toEqual(["m1c0-early", "m1c0-late", "m1c2", "m3c0"]);
});

it("maps lines past the two header lines to entries", () => {
  const entries = orderedReflections(session, "src" as ThreadId);
  expect(entryAtLine(entries, 1)).toBeUndefined();
  expect(entryAtLine(entries, 2)).toBeUndefined();
  expect(entryAtLine(entries, 3)?.threadId).toBe("m1c0-early");
  expect(entryAtLine(entries, 6)?.threadId).toBe("m3c0");
  expect(entryAtLine(entries, 7)).toBeUndefined();
});
