import type { AgentStatus } from "@magenta/core";
import { describe, expect, it } from "vitest";
import { type Line, NvimBuffer } from "../nvim/buffer.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import { mountView, pos } from "../tea/view.ts";
import { withNvimClient } from "../test/preamble.ts";
import { renderStatus } from "./thread-view.ts";

async function renderStatusToString(agentStatus: AgentStatus): Promise<string> {
  let text = "";
  await withNvimClient(async (nvim) => {
    const buffer = await NvimBuffer.create(false, true, nvim);
    await buffer.setOption("modifiable", false);
    await mountView({
      view: () => renderStatus(agentStatus, { type: "normal" }, undefined),
      props: {},
      mount: {
        nvim,
        buffer,
        startPos: pos(0, 0),
        endPos: pos(0, 0),
      },
    });
    const lines = await buffer.getLines({
      start: 0 as Row0Indexed,
      end: 100 as Row0Indexed,
    });
    text = (lines as Line[]).join("\n");
  });
  return text;
}

describe("thread-view renderStatus streaming", () => {
  it("shows no waiting timer when last event was recent", async () => {
    const now = new Date();
    const text = await renderStatusToString({
      type: "streaming",
      startTime: now,
      lastEventTime: new Date(now.getTime() - 1000),
    });
    expect(text).toContain("Streaming response");
    expect(text).not.toContain("waiting");
  });

  it("shows a waiting timer after >3s of dead air", async () => {
    const now = new Date();
    const text = await renderStatusToString({
      type: "streaming",
      startTime: new Date(now.getTime() - 4000),
      lastEventTime: new Date(now.getTime() - 4000),
    });
    expect(text).toContain("Streaming response");
    expect(text).toMatch(/waiting \ds/);
  });

  it("shows a retry countdown with attempt and error reason", async () => {
    const now = new Date();
    const text = await renderStatusToString({
      type: "streaming",
      startTime: new Date(now.getTime() - 2000),
      lastEventTime: new Date(now.getTime() - 2000),
      retryStatus: {
        attempt: 2,
        nextRetryAt: new Date(now.getTime() + 5000),
        error: new Error("API is temporarily overloaded"),
      },
    });
    expect(text).toContain("Retrying in");
    expect(text).toContain("attempt 2");
    expect(text).toContain("API is temporarily overloaded");
  });
});
