import type {
  ProtocolSessionState,
  SessionThreadSummary,
  ThreadId,
} from "@magenta/server";
import { expect, it } from "vitest";
import { SessionView } from "./session-view.ts";

const id = (s: string) => s as ThreadId;
function summary(
  s: string,
  extra: Record<string, unknown> = {},
): SessionThreadSummary {
  return {
    id: id(s),
    rootAncestorId: id(s),
    lastActivityTime: 0,
    threadType: "root",
    sandboxBypassed: false,
    state: "pending",
    ...extra,
  } as SessionThreadSummary;
}

it("listDerived filters by origin type and source; buildChildrenMap skips roots", () => {
  const state = {
    threads: [
      summary("a"),
      summary("f1", { origin: { type: "fork", sourceThreadId: id("a") } }),
      summary("r1", { origin: { type: "reflect", sourceThreadId: id("a") } }),
      summary("f2", { origin: { type: "fork", sourceThreadId: id("a") } }),
      summary("fb", { origin: { type: "fork", sourceThreadId: id("b") } }),
      summary("c1", { parentThreadId: id("a"), rootAncestorId: id("a") }),
      summary("c2", { parentThreadId: id("a"), rootAncestorId: id("a") }),
      summary("g", { parentThreadId: id("c1"), rootAncestorId: id("a") }),
    ],
  } as unknown as ProtocolSessionState;
  const view = new SessionView(state);
  expect(view.listDerived(id("a"), "fork").map((d) => d.threadId)).toEqual([
    "f1",
    "f2",
  ]);
  expect(view.listDerived(id("a"), "reflect").map((d) => d.threadId)).toEqual([
    "r1",
  ]);
  expect(view.listDerived(id("c1"), "fork")).toEqual([]);
  expect(view.buildChildrenMap()).toEqual(
    new Map([
      [id("a"), [id("c1"), id("c2")]],
      [id("c1"), [id("g")]],
    ]),
  );
  expect(view.getRootAncestorId(id("g"))).toBe("a");
  expect(view.getRootAncestorId(id("unknown"))).toBe("unknown");
});
