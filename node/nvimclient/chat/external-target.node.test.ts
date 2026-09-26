import type { ThreadId } from "@magenta/server";
import { describe, expect, it } from "vitest";
import { pickExternalTarget } from "./chat.ts";

const a = "a" as ThreadId;
const b = "b" as ThreadId;
const c = "c" as ThreadId;

describe("pickExternalTarget", () => {
  it("returns the one visible thread", () => {
    expect(
      pickExternalTarget({
        visible: [a],
        lastCursorThreadId: b,
        threadIds: [a, b],
      }),
    ).toBe(a);
  });

  it("returns the last cursor thread when none are visible", () => {
    expect(
      pickExternalTarget({
        visible: [],
        lastCursorThreadId: a,
        threadIds: [a, b],
      }),
    ).toBe(a);
  });

  it("with two visible, picks the one that held the cursor last", () => {
    expect(
      pickExternalTarget({
        visible: [a, b],
        lastCursorThreadId: b,
        threadIds: [a, b, c],
      }),
    ).toBe(b);
  });

  it("with two visible, ignores a more recent thread that isn't visible", () => {
    expect(
      pickExternalTarget({
        visible: [a, b],
        lastCursorThreadId: c,
        threadIds: [a, b, c],
      }),
    ).toBe(a);
  });

  it("falls back to the newest thread without cursor history", () => {
    expect(
      pickExternalTarget({
        visible: [],
        lastCursorThreadId: undefined,
        threadIds: [a, b],
      }),
    ).toBe(b);
    expect(
      pickExternalTarget({
        visible: [],
        lastCursorThreadId: undefined,
        threadIds: [],
      }),
    ).toBeUndefined();
  });
});
