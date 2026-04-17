import type Anthropic from "@anthropic-ai/sdk";
import type { ToolName, ToolRequestId } from "@magenta/core";
import { expect, it } from "vitest";
import { withDriver } from "../test/preamble.ts";

type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;
type ContentBlockParam = Anthropic.Messages.ContentBlockParam;

function extractToolResultText(
  messages: readonly Anthropic.Messages.MessageParam[],
): string {
  let toolResult: ToolResultBlockParam | undefined;
  for (const msg of messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const content = msg.content as ContentBlockParam[];
      toolResult = content.find(
        (block): block is ToolResultBlockParam => block.type === "tool_result",
      );
      if (toolResult) break;
    }
  }
  expect(toolResult).toBeDefined();
  expect(toolResult!.is_error).toBeFalsy();

  const resultContent = toolResult!.content;
  return typeof resultContent === "string"
    ? resultContent
    : (resultContent as ContentBlockParam[])
        .filter(
          (b): b is Anthropic.Messages.TextBlockParam => b.type === "text",
        )
        .map((b) => b.text)
        .join("");
}

it("docs tool returns matching help tags for a real query", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("How do I create a skill?");
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStreamWithText(
      "How do I create a skill?",
    );

    stream.respond({
      stopReason: "tool_use",
      text: "Let me search the help tags.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "docs-skills" as ToolRequestId,
            toolName: "docs" as ToolName,
            input: { query: "skills" },
          },
        },
      ],
    });

    const toolResultStream = await driver.mockAnthropic.awaitPendingStream();
    const text = extractToolResultText(toolResultStream.messages);

    expect(text).toContain("magenta-skills.txt");
    expect(text).toMatch(/magenta-skills:\d+/);
  });
});

it("docs tool reports no matches for a nonsense query", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("nothing to find");
    await driver.send();

    const stream =
      await driver.mockAnthropic.awaitPendingStreamWithText("nothing to find");

    stream.respond({
      stopReason: "tool_use",
      text: "Searching.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "docs-nomatch" as ToolRequestId,
            toolName: "docs" as ToolName,
            input: { query: "zzzzzzznomatch" },
          },
        },
      ],
    });

    const toolResultStream = await driver.mockAnthropic.awaitPendingStream();
    const text = extractToolResultText(toolResultStream.messages);

    expect(text).toContain("No matches");
  });
});
