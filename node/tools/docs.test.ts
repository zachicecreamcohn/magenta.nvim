import type Anthropic from "@anthropic-ai/sdk";
import type { ToolName, ToolRequestId } from "@magenta/core";
import { expect, it } from "vitest";
import { withDriver } from "../test/preamble.ts";

type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;
type ContentBlockParam = Anthropic.Messages.ContentBlockParam;

it("docs tool returns skills documentation when agent requests it", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("How do I create a skill?");
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStreamWithText(
      "How do I create a skill?",
    );

    // Agent decides to use the learn tool to learn about skills
    stream.respond({
      stopReason: "tool_use",
      text: "Let me look up the skills guide.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "docs-skills" as ToolRequestId,
            toolName: "docs" as ToolName,
            input: { name: "magenta-skills" },
          },
        },
      ],
    });

    // Wait for the tool result to be sent back
    const toolResultStream = await driver.mockAnthropic.awaitPendingStream();

    // Find the user message containing the tool result
    let toolResult: ToolResultBlockParam | undefined;
    for (const msg of toolResultStream.messages) {
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const content = msg.content as ContentBlockParam[];
        toolResult = content.find(
          (block): block is ToolResultBlockParam =>
            block.type === "tool_result",
        );
        if (toolResult) break;
      }
    }
    expect(toolResult).toBeDefined();
    expect(toolResult!.is_error).toBeFalsy();

    // The tool result content should contain the skills documentation
    const resultContent = toolResult!.content;
    const text =
      typeof resultContent === "string"
        ? resultContent
        : (resultContent as ContentBlockParam[])
            .filter(
              (b): b is Anthropic.Messages.TextBlockParam => b.type === "text",
            )
            .map((b) => b.text)
            .join("");
    expect(text).toContain("magenta-skills");
    expect(text).toContain("Skill Locations");
    expect(text).toContain("skill.md");
  });
});

it("docs tool returns neovim help doc when agent requests it", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("How do I use magenta commands?");
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStreamWithText(
      "How do I use magenta commands?",
    );

    stream.respond({
      stopReason: "tool_use",
      text: "Let me look up the commands reference.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "docs-commands" as ToolRequestId,
            toolName: "docs" as ToolName,
            input: { name: "magenta-commands-keymaps" },
          },
        },
      ],
    });

    const toolResultStream = await driver.mockAnthropic.awaitPendingStream();

    let toolResult: ToolResultBlockParam | undefined;
    for (const msg of toolResultStream.messages) {
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const content = msg.content as ContentBlockParam[];
        toolResult = content.find(
          (block): block is ToolResultBlockParam =>
            block.type === "tool_result",
        );
        if (toolResult) break;
      }
    }
    expect(toolResult).toBeDefined();
    expect(toolResult!.is_error).toBeFalsy();

    const resultContent = toolResult!.content;
    const text =
      typeof resultContent === "string"
        ? resultContent
        : (resultContent as ContentBlockParam[])
            .filter(
              (b): b is Anthropic.Messages.TextBlockParam => b.type === "text",
            )
            .map((b) => b.text)
            .join("");
    expect(text).toContain("magenta-commands");
    expect(text).toContain("Ex Commands");
    expect(text).toContain("Default Keymaps");
  });
});
