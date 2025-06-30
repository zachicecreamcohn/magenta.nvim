import { describe, it, expect } from "vitest";
import { placeCacheBreakpoints } from "./anthropic.ts";
import type { MessageParam } from "./anthropic.ts";
import Anthropic from "@anthropic-ai/sdk";
import type {
  TextBlockParam,
  ToolUseBlockParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/index.mjs";

describe("placeCacheBreakpoints", () => {
  it("should return correct metadata about cache placement", () => {
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
        ],
      },
    ];

    const result = placeCacheBreakpoints(messages);

    expect(result.headersPlaced).toBe(2);
    expect(result.needsSystemHeader).toBe(true); // Less than 4 headers placed
  });

  it("should place cache markers only on the last 4 eligible sites", () => {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "a".repeat(4096) }, // Site 1
          { type: "text", text: "b".repeat(4096) }, // Site 2
          { type: "text", text: "c".repeat(4096) }, // Site 3
          { type: "text", text: "d".repeat(4096) }, // Site 4
          { type: "text", text: "e".repeat(4096) }, // Site 5
          { type: "text", text: "f".repeat(4096) }, // Site 6
        ],
      },
    ];

    const result = placeCacheBreakpoints(messages);

    // Only the last 4 sites should have cache markers
    expect(
      (messages[0].content[0] as TextBlockParam).cache_control,
    ).toBeUndefined();
    expect(
      (messages[0].content[1] as TextBlockParam).cache_control,
    ).toBeUndefined();
    expect((messages[0].content[2] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });
    expect((messages[0].content[3] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });
    expect((messages[0].content[4] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });
    expect((messages[0].content[5] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });

    expect(result.headersPlaced).toBe(4);
    expect(result.needsSystemHeader).toBe(false); // Exactly 4 headers placed
  });

  it("should not place cache markers for content under 1000 tokens", () => {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "short message", // Much less than 1000 tokens
          },
          {
            type: "text",
            text: "a".repeat(1000), // ~250 tokens
          },
        ],
      },
    ];

    const result = placeCacheBreakpoints(messages);

    expect(
      (messages[0].content[0] as TextBlockParam).cache_control,
    ).toBeUndefined();
    expect(
      (messages[0].content[1] as TextBlockParam).cache_control,
    ).toBeUndefined();
    expect(result.headersPlaced).toBe(0);
    expect(result.needsSystemHeader).toBe(true);
  });

  it("should handle mixed content types correctly", () => {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "a".repeat(4096), // ~1024 tokens - becomes first cache site
          },
          {
            type: "tool_use",
            name: "test_tool",
            id: "123",
            input: { param: "b".repeat(4096) }, // ~1024 tokens - becomes second cache site
          },
          {
            type: "tool_result",
            tool_use_id: "123",
            content: "c".repeat(4096), // ~1024 tokens - becomes third cache site
            is_error: false,
          },
        ],
      },
    ];

    const result = placeCacheBreakpoints(messages);

    // First block becomes a cache site (1024 tokens >= 1000)
    expect((messages[0].content[0] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });
    // Second block becomes next cache site (1024 tokens since reset >= 1000)
    expect((messages[0].content[1] as ToolUseBlockParam).cache_control).toEqual(
      { type: "ephemeral" },
    );
    // Third block becomes next cache site (1024 tokens since reset >= 1000)
    expect(
      (messages[0].content[2] as ToolResultBlockParam).cache_control,
    ).toEqual({ type: "ephemeral" });
    expect(result.headersPlaced).toBe(3);
    expect(result.needsSystemHeader).toBe(true);
  });

  it("should reset token counter after placing each cache site", () => {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "a".repeat(4096) }, // 1024 tokens - becomes first cache site
          { type: "text", text: "b".repeat(2048) }, // 512 tokens - not enough for next site
          { type: "text", text: "c".repeat(2048) }, // 512 tokens - now total 1024 since last cache - becomes second site
        ],
      },
    ];

    const result = placeCacheBreakpoints(messages);

    // First block becomes a cache site immediately (1024 >= 1000)
    expect((messages[0].content[0] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });
    // Second block doesn't qualify (only 512 tokens since reset)
    expect(
      (messages[0].content[1] as TextBlockParam).cache_control,
    ).toBeUndefined();
    // Third block qualifies (512 + 512 = 1024 tokens since reset >= 1000)
    expect((messages[0].content[2] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });
    expect(result.headersPlaced).toBe(2);
  });

  it("should work across multiple messages", () => {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "a".repeat(4096) }, // ~1024 tokens - becomes first cache site
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "b".repeat(4096) }, // ~1024 tokens - becomes second cache site
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "c".repeat(4096) }, // ~1024 tokens - becomes third cache site
        ],
      },
    ];

    const result = placeCacheBreakpoints(messages);

    // First message becomes first cache site
    expect((messages[0].content[0] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });
    // Second message becomes second cache site (reset after first)
    expect((messages[1].content[0] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });
    // Third message becomes third cache site (reset after second)
    expect((messages[2].content[0] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });
    expect(result.headersPlaced).toBe(3);
  });

  it("should handle edge case with exactly 4 cache sites", () => {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "a".repeat(4096) }, // First cache site
          { type: "text", text: "b".repeat(4096) }, // Second cache site
          { type: "text", text: "c".repeat(4096) }, // Third cache site
          { type: "text", text: "d".repeat(4096) }, // Fourth cache site
        ],
      },
    ];

    const result = placeCacheBreakpoints(messages);

    // All 4 blocks become cache sites, all get marked (last 4)
    expect((messages[0].content[0] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });
    expect((messages[0].content[1] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });
    expect((messages[0].content[2] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });
    expect((messages[0].content[3] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });
    expect(result.headersPlaced).toBe(4); // All 4 sites get marked
    expect(result.needsSystemHeader).toBe(false); // Exactly 4, so no system header needed
  });

  it("should handle empty messages gracefully", () => {
    const messages: MessageParam[] = [];

    const result = placeCacheBreakpoints(messages);

    expect(result.headersPlaced).toBe(0);
    expect(result.needsSystemHeader).toBe(true);
  });

  it("should handle messages with empty content arrays", () => {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [],
      },
    ];

    const result = placeCacheBreakpoints(messages);

    expect(result.headersPlaced).toBe(0);
    expect(result.needsSystemHeader).toBe(true);
  });

  it("should handle complex tool result content", () => {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "123",
            content: [
              { type: "text", text: "a".repeat(2048) },
              { type: "text", text: "b".repeat(2048) },
            ],
            is_error: false,
          },
          {
            type: "text",
            text: "c".repeat(4096),
          },
        ],
      },
    ];

    const result = placeCacheBreakpoints(messages);

    expect(
      (messages[0].content[0] as ToolResultBlockParam).cache_control,
    ).toEqual({ type: "ephemeral" });
    expect((messages[0].content[1] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });
    expect(result.headersPlaced).toBe(2);
  });

  it("should handle image and document content types", () => {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "a".repeat(4096), // ~1024 tokens
            },
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "b".repeat(4096), // ~1024 tokens
            },
            title: "Test Document",
          },
        ],
      },
    ];

    const result = placeCacheBreakpoints(messages);

    expect(
      (messages[0].content[0] as Anthropic.Messages.ImageBlockParam)
        .cache_control,
    ).toEqual({ type: "ephemeral" });
    expect(
      (messages[0].content[1] as Anthropic.Messages.DocumentBlockParam)
        .cache_control,
    ).toEqual({ type: "ephemeral" });
    expect(result.headersPlaced).toBe(2);
  });

  it("should handle more than 4 cache sites and only mark the last 4", () => {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "a".repeat(4096) }, // Site 1 - should NOT be marked
          { type: "text", text: "b".repeat(4096) }, // Site 2 - should NOT be marked
          { type: "text", text: "c".repeat(4096) }, // Site 3 - should be marked
          { type: "text", text: "d".repeat(4096) }, // Site 4 - should be marked
          { type: "text", text: "e".repeat(4096) }, // Site 5 - should be marked
          { type: "text", text: "f".repeat(4096) }, // Site 6 - should be marked
        ],
      },
    ];

    const result = placeCacheBreakpoints(messages);

    // First two sites should not be marked (not in last 4)
    expect(
      (messages[0].content[0] as TextBlockParam).cache_control,
    ).toBeUndefined();
    expect(
      (messages[0].content[1] as TextBlockParam).cache_control,
    ).toBeUndefined();

    // Last 4 sites should be marked
    expect((messages[0].content[2] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });
    expect((messages[0].content[3] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });
    expect((messages[0].content[4] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });
    expect((messages[0].content[5] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });

    expect(result.headersPlaced).toBe(4);
    expect(result.needsSystemHeader).toBe(false); // Exactly 4 headers
  });

  it("should handle text blocks with citations", () => {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "a".repeat(2048),
            citations: [
              {
                type: "web_search_result_location",
                cited_text: "b".repeat(1024),
                url: "https://example.com",
                title: "Example",
                encrypted_index: "c".repeat(1024),
              },
            ],
          },
        ],
      },
    ];

    const result = placeCacheBreakpoints(messages);

    // Total should be ~2048 + 1024 + url + title + encrypted_index = well over 1000 tokens
    expect((messages[0].content[0] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });
    expect(result.headersPlaced).toBe(1);
  });

  it("should handle server_tool_use content type", () => {
    const messages: MessageParam[] = [
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "123",
            name: "web_search",
            input: { param: "a".repeat(4096) }, // ~1024 tokens in input
          } as any,
        ],
      },
    ];

    const result = placeCacheBreakpoints(messages);

    expect((messages[0].content[0] as any).cache_control).toEqual({
      type: "ephemeral",
    });
    expect(result.headersPlaced).toBe(1);
  });

  it("should handle web_search_tool_result content type", () => {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [
          {
            type: "web_search_tool_result",
            content: [
              {
                url: "https://example.com",
                title: "a".repeat(1024),
                encrypted_content: "b".repeat(3072), // Total ~1024 tokens
              },
            ],
          } as any,
        ],
      },
    ];

    const result = placeCacheBreakpoints(messages);

    expect((messages[0].content[0] as any).cache_control).toEqual({
      type: "ephemeral",
    });
    expect(result.headersPlaced).toBe(1);
  });

  it("should handle thinking blocks (excluded from cache)", () => {
    const messages: MessageParam[] = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            content: "a".repeat(4096), // Would be 1024 tokens but thinking blocks are excluded
          } as any,
          {
            type: "text",
            text: "b".repeat(4096), // 1024 tokens - should become cache site
          },
        ],
      },
    ];

    const result = placeCacheBreakpoints(messages);

    // Thinking block should not have cache control
    expect((messages[0].content[0] as any).cache_control).toBeUndefined();
    // Text block should become cache site
    expect((messages[0].content[1] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });
    expect(result.headersPlaced).toBe(1);
  });

  it("should handle combination of small blocks that accumulate to cache threshold", () => {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "a".repeat(1000) }, // 250 tokens
          { type: "text", text: "b".repeat(1000) }, // 250 tokens
          { type: "text", text: "c".repeat(1000) }, // 250 tokens
          { type: "text", text: "d".repeat(1000) }, // 250 tokens - total 1000, becomes cache site
          { type: "text", text: "e".repeat(4096) }, // 1024 tokens - becomes next cache site
        ],
      },
    ];

    const result = placeCacheBreakpoints(messages);

    // First three blocks should not have cache control
    expect(
      (messages[0].content[0] as TextBlockParam).cache_control,
    ).toBeUndefined();
    expect(
      (messages[0].content[1] as TextBlockParam).cache_control,
    ).toBeUndefined();
    expect(
      (messages[0].content[2] as TextBlockParam).cache_control,
    ).toBeUndefined();

    // Fourth block triggers cache site (cumulative 1000 tokens >= 1000)
    expect((messages[0].content[3] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });

    // Fifth block becomes next cache site after reset
    expect((messages[0].content[4] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });

    expect(result.headersPlaced).toBe(2);
  });

  it("should handle complex tool result content", () => {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "123",
            content: [
              { type: "text", text: "a".repeat(2048) },
              { type: "text", text: "b".repeat(2048) },
            ],
            is_error: false,
          },
          {
            type: "text",
            text: "c".repeat(4096),
          },
        ],
      },
    ];

    const result = placeCacheBreakpoints(messages);

    expect(
      (messages[0].content[0] as ToolResultBlockParam).cache_control,
    ).toEqual({ type: "ephemeral" });
    expect((messages[0].content[1] as TextBlockParam).cache_control).toEqual({
      type: "ephemeral",
    });
    expect(result.headersPlaced).toBe(2);
  });
});
