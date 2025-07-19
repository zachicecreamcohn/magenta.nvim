import type { ToolRequestId } from "./toolManager.ts";
import { expect, it, describe } from "vitest";
import {
  withDriver,
  assertToolResultHasImageSource,
  assertToolResultHasDocumentSource,
} from "../test/preamble.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { ToolName } from "./types.ts";

describe("getFile rich content integration tests", () => {
  it("should process image files end-to-end", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Request to read an image file
      await driver.inputMagentaText(`Please analyze the image in test.jpg`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      request.respond({
        stopReason: "tool_use",
        text: "I'll analyze the image for you",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "img_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "test.jpg" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      // Should show successful processing
      await driver.assertDisplayBufferContains(`👀✅ \`test.jpg\``);

      // Verify the tool result contains image content
      const toolResultRequest =
        await driver.mockAnthropic.awaitPendingRequest();
      const toolResultMessage =
        toolResultRequest.messages[toolResultRequest.messages.length - 1];

      if (
        toolResultMessage.role === "user" &&
        Array.isArray(toolResultMessage.content)
      ) {
        const toolResult = toolResultMessage.content[0];
        if (toolResult.type === "tool_result") {
          expect(toolResult.result.status).toBe("ok");

          // The result should be image content, not text
          if (toolResult.result.status === "ok") {
            assertToolResultHasImageSource(toolResult, "image/jpeg");
          }
        }
      }

      // Complete the conversation
      toolResultRequest.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "I can see the image content. It appears to be a test image file.",
      });
    });
  });

  it("should process PDF documents end-to-end", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Request to read a PDF file
      await driver.inputMagentaText(
        `Please read and analyze the PDF document in test.pdf`,
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      request.respond({
        stopReason: "tool_use",
        text: "I'll read the PDF document for you",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "pdf_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "test.pdf" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      // Should show successful processing
      await driver.assertDisplayBufferContains(`👀✅ \`test.pdf\``);

      // Verify the tool result contains document content
      const toolResultRequest =
        await driver.mockAnthropic.awaitPendingRequest();
      const toolResultMessage =
        toolResultRequest.messages[toolResultRequest.messages.length - 1];

      if (
        toolResultMessage.role === "user" &&
        Array.isArray(toolResultMessage.content)
      ) {
        const toolResult = toolResultMessage.content[0];
        if (toolResult.type === "tool_result") {
          expect(toolResult.result.status).toBe("ok");

          // The result should be document content, not text
          if (toolResult.result.status === "ok") {
            assertToolResultHasDocumentSource(toolResult, "application/pdf");
          }
        }
      }

      // Complete the conversation
      toolResultRequest.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "I've successfully processed the PDF document.",
      });
    });
  });

  it("should reject binary files that are not supported", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Request to read an unsupported binary file
      await driver.inputMagentaText(`Please read the file test.bin`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      request.respond({
        stopReason: "tool_use",
        text: "I'll try to read the binary file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "bin_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "test.bin" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      // Should show error for unsupported file type
      await driver.assertDisplayBufferContains(`👀❌ \`test.bin\``);

      // Verify the tool result contains error
      const toolResultRequest =
        await driver.mockAnthropic.awaitPendingRequest();
      const toolResultMessage =
        toolResultRequest.messages[toolResultRequest.messages.length - 1];

      if (
        toolResultMessage.role === "user" &&
        Array.isArray(toolResultMessage.content)
      ) {
        const toolResult = toolResultMessage.content[0];
        if (toolResult.type === "tool_result") {
          expect(toolResult.result.status).toBe("error");

          if (toolResult.result.status === "error") {
            expect(toolResult.result.error).toContain("Unsupported file type");
          }
        }
      }
    });
  });

  it("should add images to context manager", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Verify context is empty initially
      expect(
        driver.magenta.chat.getActiveThread().contextManager.files,
      ).toEqual({});

      // Read an image file
      await driver.inputMagentaText(`Please analyze test.jpg`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      request.respond({
        stopReason: "tool_use",
        text: "I'll analyze the image",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "img_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "test.jpg" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`👀✅ \`test.jpg\``);

      // Handle the auto-respond message
      const toolResultRequest =
        await driver.mockAnthropic.awaitPendingRequest();
      toolResultRequest.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "I've analyzed the image successfully.",
      });

      // Wait for the conversation to complete (animation should stop)
      await driver.assertDisplayBufferDoesNotContain("Streaming response");

      // Context should contain the image
      const contextFiles =
        driver.magenta.chat.getActiveThread().contextManager.files;
      expect(Object.keys(contextFiles)).toHaveLength(1);
      const fileEntry = Object.values(contextFiles)[0];
      expect(fileEntry.relFilePath).toBe("test.jpg");
      expect(fileEntry.fileTypeInfo.category).toBe("image");

      // Context section should be shown
      await driver.assertDisplayBufferContains("# context:");
      await driver.assertDisplayBufferContains("- `test.jpg`");
    });
  });

  it("should add PDFs to context manager", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Verify context is empty initially
      expect(
        driver.magenta.chat.getActiveThread().contextManager.files,
      ).toEqual({});

      // Read a PDF file
      await driver.inputMagentaText(`Please read test.pdf`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      request.respond({
        stopReason: "tool_use",
        text: "I'll read the PDF",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "pdf_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "test.pdf" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`👀✅ \`test.pdf\``);

      // Handle the auto-respond message
      const toolResultRequest =
        await driver.mockAnthropic.awaitPendingRequest();
      toolResultRequest.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "I've read the PDF document successfully.",
      });

      // Wait for the conversation to complete (animation should stop)
      await driver.assertDisplayBufferDoesNotContain("Streaming response");

      // Context should contain the PDF
      const contextFiles =
        driver.magenta.chat.getActiveThread().contextManager.files;
      expect(Object.keys(contextFiles)).toHaveLength(1);
      const fileEntry = Object.values(contextFiles)[0];
      expect(fileEntry.relFilePath).toBe("test.pdf");
      expect(fileEntry.fileTypeInfo.category).toBe("pdf");

      // Context section should be shown
      await driver.assertDisplayBufferContains("# context:");
      await driver.assertDisplayBufferContains("- `test.pdf`");
    });
  });

  it("should continue to add text files to context normally", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Read a text file
      await driver.inputMagentaText(`Please read poem.txt`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      request.respond({
        stopReason: "tool_use",
        text: "I'll read the text file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "text_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "poem.txt" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`👀✅ \`poem.txt\``);

      // Handle the auto-respond message
      const toolResultRequest =
        await driver.mockAnthropic.awaitPendingRequest();
      toolResultRequest.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "I've read the text file successfully.",
      });

      // Text file should be added to context normally
      await driver.assertDisplayBufferContains("# context:");
      await driver.assertDisplayBufferContains("- `poem.txt`");

      const relativeFiles = Object.values(
        driver.magenta.chat.getActiveThread().contextManager.files,
      ).map((f) => f.relFilePath);
      expect(relativeFiles).toContain("poem.txt");
    });
  });

  it("should handle mixed content types in a single conversation", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Read the text file first
      await driver.inputMagentaText(`Please read the poem.txt file`);
      await driver.send();

      const request1 = await driver.mockAnthropic.awaitPendingRequest();
      request1.respond({
        stopReason: "tool_use",
        text: "I'll read the text file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "text_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "poem.txt" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`👀✅ \`poem.txt\``);

      // Handle first auto-respond message
      const toolResultRequest1 =
        await driver.mockAnthropic.awaitPendingRequest();
      toolResultRequest1.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "I've read the text file. Now let me read the images.",
      });

      // Read the image file
      await driver.inputMagentaText(`Now please analyze the test.jpg image`);
      await driver.send();

      const request2 = await driver.mockAnthropic.awaitPendingRequest();
      request2.respond({
        stopReason: "tool_use",
        text: "I'll analyze the image",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "img_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "test.jpg" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`👀✅ \`test.jpg\``);

      // Handle second auto-respond message
      const toolResultRequest2 =
        await driver.mockAnthropic.awaitPendingRequest();
      toolResultRequest2.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "I've analyzed the image. Now let me read the PDF.",
      });

      // Read the PDF file
      await driver.inputMagentaText(
        `Finally, please read the test.pdf document`,
      );
      await driver.send();

      const request3 = await driver.mockAnthropic.awaitPendingRequest();
      request3.respond({
        stopReason: "tool_use",
        text: "I'll read the PDF",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "pdf_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "test.pdf" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`👀✅ \`test.pdf\``);

      // Handle final auto-respond message
      const toolResultRequest3 =
        await driver.mockAnthropic.awaitPendingRequest();
      toolResultRequest3.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "I've successfully processed all three files with different content types.",
      });

      // All files should be in context
      await driver.assertDisplayBufferContains("# context:");
      await driver.assertDisplayBufferContains("- `poem.txt`");
      await driver.assertDisplayBufferContains("- `test.jpg`");
      await driver.assertDisplayBufferContains("- `test.pdf`");

      const relativeFiles = Object.values(
        driver.magenta.chat.getActiveThread().contextManager.files,
      )
        .map((f) => f.relFilePath)
        .sort();
      expect(relativeFiles).toEqual(["poem.txt", "test.jpg", "test.pdf"]);
    });
  });

  it("should handle file size limits appropriately", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          // Create a large fake image file (we'll simulate this by creating content > 10MB)
          const { writeFile } = await import("node:fs/promises");
          const largeFakeImage = Buffer.alloc(11 * 1024 * 1024); // 11MB
          await writeFile(`${tmpDir}/large-image.jpg`, largeFakeImage);
        },
      },
      async (driver) => {
        await driver.showSidebar();

        // The large image file should already be in the test cwd
        await driver.inputMagentaText(
          `Please analyze the large image in large-image.jpg`,
        );
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingRequest();
        request.respond({
          stopReason: "tool_use",
          text: "I'll try to analyze the large image",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "large_img_request" as ToolRequestId,
                toolName: "get_file" as ToolName,
                input: {
                  filePath: "large-image.jpg" as UnresolvedFilePath,
                },
              },
            },
          ],
        });

        // Should show error for file too large
        await driver.assertDisplayBufferContains(`👀❌ \`large-image.jpg\``);

        // Verify the tool result contains error
        const toolResultRequest =
          await driver.mockAnthropic.awaitPendingRequest();
        const toolResultMessage =
          toolResultRequest.messages[toolResultRequest.messages.length - 1];

        if (
          toolResultMessage.role === "user" &&
          Array.isArray(toolResultMessage.content)
        ) {
          const toolResult = toolResultMessage.content[0];
          if (toolResult.type === "tool_result") {
            expect(toolResult.result.status).toBe("error");

            if (toolResult.result.status === "error") {
              expect(toolResult.result.error).toContain("File too large");
            }
          }
        }

        // No cleanup needed since the file is in the temporary test directory
      },
    );
  });
});
