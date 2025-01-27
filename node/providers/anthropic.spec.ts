import { describe, it, expect } from "vitest";
import {} from "./bedrock.ts";
import { placeCacheBreakpoints } from "./anthropic.ts";
import type { MessageParam } from "./anthropic.ts";

describe("anthropic.ts", () => {
  it("placeCacheBreakpoints should add cache markers at appropriate positions", () => {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "a".repeat(4096), // ~1024 tokens
          },
          {
            type: "text",
            text: "b".repeat(4096), // Another ~1024 tokens
          },
          {
            type: "text",
            text: "c".repeat(8192), // Another ~2048 tokens
          },
        ],
      },
    ];

    placeCacheBreakpoints(messages);

    expect(messages[0].content[0].cache_control).toBeUndefined();

    expect(messages[0].content[1].cache_control).toEqual({ type: "ephemeral" });

    expect(messages[0].content[2].cache_control).toEqual({ type: "ephemeral" });
  });

  it("placeCacheBreakpoints should handle mixed content types", () => {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "a".repeat(4096),
          },
          {
            type: "tool_use",
            name: "test_tool",
            id: "123",
            input: { param: "a".repeat(4096) },
          },
        ],
      },
    ];

    placeCacheBreakpoints(messages);

    expect(messages[0].content[0].cache_control).toBeUndefined();
    expect(messages[0].content[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("placeCacheBreakpoints should not add cache markers for small content", () => {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "short message",
          },
        ],
      },
    ];

    placeCacheBreakpoints(messages);

    expect(messages[0].content[0].cache_control).toBeUndefined();
  });
});
