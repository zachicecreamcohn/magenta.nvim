import { describe, it, expect } from "vitest";
import { withDriver } from "../test/preamble";
import type { ToolRequestId } from "../tools/toolManager";
import type { UnresolvedFilePath } from "../utils/files";
import type { WebSearchResultBlock } from "@anthropic-ai/sdk/resources.mjs";
import type { ToolName } from "../tools/types";
import fs from "node:fs";
import { getcwd } from "../nvim/nvim";
import { resolveFilePath } from "../utils/files";

describe("node/chat/message.spec.ts", () => {
  it("display multiple edits to the same file, and edit details", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`Update the poem in the file poem.txt`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      request.respond({
        stopReason: "end_turn",
        text: "ok, I will try to rewrite the poem in that file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id1" as ToolRequestId,
              toolName: "replace" as ToolName,
              input: {
                filePath: "poem.txt" as UnresolvedFilePath,
                find: `Moonlight whispers through the trees,
Silver shadows dance with ease.
Stars above like diamonds bright,
Paint their stories in the night.`,
                replace: `Replace 1
Replace 2`,
              },
            },
          },
        ],
      });
      await driver.assertDisplayBufferContains(`\
# user:
Update the poem in the file poem.txt`);

      await driver.assertDisplayBufferContains(`\
# assistant:
ok, I will try to rewrite the poem in that file
✏️✅ Replace [[ -4 / +2 ]] in \`poem.txt\`
\`\`\`diff
-Moonlight whispers through the trees,
-Silver shadows dance with ease.
-Stars above like diamonds bright,
-Paint their stories in the night.
\\ No newline at end of file
+Replace 1
+Replace 2
\\ No newline at end of file

\`\`\``);

      await driver.assertDisplayBufferContains(`\
Edits:
  \`poem.txt\` (1 edits). [± diff snapshot]`);

      const reviewPos =
        await driver.assertDisplayBufferContains("diff snapshot");
      await driver.triggerDisplayBufferKey(reviewPos, "<CR>");

      await driver.assertDisplayBufferContains(`\
# assistant:
ok, I will try to rewrite the poem in that file
✏️✅ Replace [[ -4 / +2 ]] in \`poem.txt\``);

      // Go back to main view
      await driver.triggerDisplayBufferKey(reviewPos, "<CR>");

      await driver.assertDisplayBufferContains(`\
# assistant:
ok, I will try to rewrite the poem in that file
✏️✅ Replace [[ -4 / +2 ]] in \`poem.txt\``);
    });
  });

  it("displays deleted context updates correctly", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Create a temporary file for testing
      const cwd = await getcwd(driver.nvim);
      const tempFilePath = resolveFilePath(
        cwd,
        "temp-delete-test.txt" as UnresolvedFilePath,
      );
      const tempContent = "temporary file content\nfor testing deletion";
      await fs.promises.writeFile(tempFilePath, tempContent);

      // Add file to context
      await driver.addContextFiles("temp-delete-test.txt");

      // Verify file is in context
      await driver.assertDisplayBufferContains(`\
# context:
- \`temp-delete-test.txt\``);

      // Delete the file from disk
      await fs.promises.unlink(tempFilePath);

      // Send a message to trigger context update
      await driver.inputMagentaText("What happened to the file?");
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();

      // Check that the request contains the file deletion update
      // Check that the request contains the file deletion update
      const contextUpdateMessage = request.messages.find(
        (msg) =>
          msg.role === "user" &&
          typeof msg.content === "object" &&
          msg.content[0].type === "text" &&
          msg.content[0].text.includes("temp-delete-test.txt"),
      );
      expect(contextUpdateMessage).toBeTruthy();
      const content0 = contextUpdateMessage!.content[0];
      expect(
        (content0 as Extract<typeof content0, { type: "text" }>).text,
      ).toContain(
        "- `temp-delete-test.txt`\nThis file has been deleted and removed from context.",
      );
      request.respond({
        stopReason: "end_turn",
        text: "I can see the file has been deleted from context.",
        toolRequests: [],
      });

      // Verify the display shows the deletion indicator
      await driver.assertDisplayBufferContains(`\
# user:
Context Updates:
- \`temp-delete-test.txt\` [ deleted ]

What happened to the file?

# assistant:
I can see the file has been deleted from context.`);
    });

    it("handles web search results and citations together", async () => {
      await withDriver({}, async (driver) => {
        await driver.showSidebar();
        await driver.inputMagentaText(
          `Compare TypeScript and JavaScript for large projects`,
        );
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingRequest();

        // Create server tool use event (web search)
        const serverToolUseIndex = 0;
        request.onStreamEvent({
          type: "content_block_start",
          index: serverToolUseIndex,
          content_block: {
            type: "server_tool_use",
            id: "search_1",
            name: "web_search",
            input: {},
          },
        });
        request.onStreamEvent({
          type: "content_block_delta",
          index: serverToolUseIndex,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify({
              query: "TypeScript vs JavaScript large projects",
            }),
          },
        });
        request.onStreamEvent({
          type: "content_block_stop",
          index: serverToolUseIndex,
        });

        // Create web search result event
        const searchResultIndex = 1;
        request.onStreamEvent({
          type: "content_block_start",
          index: searchResultIndex,
          content_block: {
            type: "web_search_tool_result",
            tool_use_id: "search_1",
            content: [
              {
                type: "web_search_result",
                title:
                  "TypeScript vs JavaScript: Which Is Better for Your Project?",
                url: "https://example.com/typescript-vs-javascript",
                encrypted_content: "",
                page_age: "3 months ago",
              },
            ] as WebSearchResultBlock[],
          },
        });
        request.onStreamEvent({
          type: "content_block_stop",
          index: searchResultIndex,
        });

        // Create text content with citations
        const textIndex = 2;
        request.onStreamEvent({
          type: "content_block_start",
          index: textIndex,
          content_block: {
            type: "text",
            text: "",
            citations: null,
          },
        });
        request.onStreamEvent({
          type: "content_block_delta",
          index: textIndex,
          delta: {
            type: "text_delta",
            text: "TypeScript offers significant advantages for large projects compared to JavaScript.",
          },
        });
        request.onStreamEvent({
          type: "content_block_delta",
          index: textIndex,
          delta: {
            type: "citations_delta",
            citation: {
              type: "web_search_result_location",
              cited_text: "TypeScript offers significant advantages",
              encrypted_index: "1",
              title: "Microsoft Dev Blog",
              url: "https://devblogs.microsoft.com/typescript/benefits-large-projects",
            },
          },
        });
        request.onStreamEvent({
          type: "content_block_stop",
          index: textIndex,
        });

        // Finish the response
        request.finishResponse("end_turn");

        await driver.assertDisplayBufferContains(`\
# user:
Compare TypeScript and JavaScript for large projects

# assistant:
🔍 Searching TypeScript vs JavaScript large projects...
🌐 Search results:
- [TypeScript vs JavaScript: Which Is Better for Your Project?](https://example.com/typescript-vs-javascript) (3 months ago)

TypeScript offers significant advantages for large projects compared to JavaScript.[Microsoft Dev Blog](https://devblogs.microsoft.com/typescript/benefits-large-projects)

Stopped (end_turn) [input: 0, output: 0]`);
      });
    });
  });
});
