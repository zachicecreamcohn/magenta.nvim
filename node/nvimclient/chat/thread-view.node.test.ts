import type { ProtocolActivity, ProtocolRunState } from "@magenta/server";
import { describe, expect, it } from "vitest";
import { renderToString } from "../tea/view.ts";
import { renderStatus } from "./thread-view.ts";

function renderStatusToString(
  state: ProtocolRunState | Extract<ProtocolActivity, { type: "streaming" }>,
): string {
  const loopState: ProtocolRunState =
    state.type === "streaming"
      ? {
          type: "running",
          activity: state,
          aborting: false,
        }
      : state;
  return renderToString(
    renderStatus(loopState, undefined, undefined, () => {}),
  );
}

describe("thread-view renderStatus streaming", () => {
  it("shows no waiting timer when last event was recent", async () => {
    const now = Date.now();
    const text = await renderStatusToString({
      type: "streaming",
      startedAt: now,
      lastEventTime: now - 1000,
      block: undefined,
      retry: undefined,
    });
    expect(text).toContain("Streaming response");
    expect(text).not.toContain("waiting");
  });

  it("shows a waiting timer after >3s of dead air", async () => {
    const now = Date.now();
    const text = await renderStatusToString({
      type: "streaming",
      startedAt: now - 4000,
      lastEventTime: now - 4000,
      block: undefined,
      retry: undefined,
    });
    expect(text).toContain("Streaming response");
    expect(text).toMatch(/waiting \ds/);
  });

  it("shows a retry countdown with attempt and error reason", async () => {
    const now = Date.now();
    const text = await renderStatusToString({
      type: "streaming",
      startedAt: now - 2000,
      lastEventTime: now - 2000,
      block: undefined,
      retry: {
        attempt: 2,
        nextRetryAt: now + 5000,
        error: { message: "API is temporarily overloaded" },
      },
    });
    expect(text).toContain("Retrying in");
    expect(text).toContain("attempt 2");
    expect(text).toContain("API is temporarily overloaded");
  });

  it("renders the preparing activity", async () => {
    const text = await renderStatusToString({
      type: "running",
      activity: { type: "preparing" },
      aborting: false,
    });
    expect(text).toContain("Preparing...");
  });

  it("renders aborting ahead of whatever the loop is still doing", async () => {
    const now = Date.now();
    const text = await renderStatusToString({
      type: "running",
      activity: {
        type: "streaming",
        startedAt: now,
        lastEventTime: now,
        block: undefined,
        retry: undefined,
      },
      aborting: true,
    });
    expect(text).toContain("Aborting...");
    expect(text).not.toContain("Streaming response");
  });

  it("renders an empty submission as a normal stop", async () => {
    const text = await renderStatusToString({
      type: "idle",
      lastResult: { type: "empty" },
    });
    expect(text).toContain("Stopped (end_turn)");
  });
});
