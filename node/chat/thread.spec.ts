import { TMP_DIR, withDriver } from "../test/preamble.ts";
import { LOGO } from "./thread.ts";
import { type ToolRequestId } from "../tools/toolManager.ts";
import { describe, expect, it } from "vitest";
import type { UnresolvedFilePath } from "../utils/files.ts";
import { type Input as CompactThreadInput } from "../tools/compact-thread";
import type { ToolName } from "../tools/types.ts";
import { pollUntil } from "../utils/async.ts";

describe("node/chat/thread.spec.ts", () => {
  it("chat render and a few updates", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText("Can you run a simple command for me?");
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      const toolRequestId = "test-bash-command" as ToolRequestId;

      request.respond({
        stopReason: "end_turn",
        text: "Sure, let me run a simple bash command for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "bash_command" as ToolName,
              input: { command: "echo 'Hello from bash!'" },
            },
          },
        ],
      });

      // Check that the buffer contains the expected content during tool execution
      await driver.assertDisplayBufferContains(
        "Can you run a simple command for me?",
      );
      await driver.assertDisplayBufferContains(
        "Sure, let me run a simple bash command for you.",
      );

      // After the tool executes
      await driver.assertDisplayBufferContains("Hello from bash!");
    });
  });

  it("chat clear", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText("Can you look at my list of buffers?");
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();

      request.respond({
        stopReason: "end_turn",
        text: "Sure, let me use the list_buffers tool.",
        toolRequests: [],
      });

      await driver.assertDisplayBufferContains(
        "Can you look at my list of buffers?",
      );
      await driver.assertDisplayBufferContains(
        "Sure, let me use the list_buffers tool.",
      );

      await driver.clear();
      await driver.assertDisplayBufferContains(LOGO.split("\n")[0]);
    });
  });

  it("getMessages correctly interleaves tool requests and responses", async () => {
    await withDriver({}, async (driver) => {
      // Create a more complex conversation with multiple tool uses
      await driver.showSidebar();
      await driver.inputMagentaText("Can you help me with my code?");
      await driver.send();

      const request1 = await driver.mockAnthropic.awaitPendingRequest();

      const toolRequestId1 = "tool-1" as ToolRequestId;
      const toolRequestId2 = "tool-2" as ToolRequestId;

      // First response with bash_command tool use
      request1.respond({
        stopReason: "tool_use",
        text: "I'll help you. Let me check your project first.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId1,
              toolName: "bash_command" as ToolName,
              input: { command: "echo 'Project files summary'" },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("Project files summary");

      const request2 = await driver.mockAnthropic.awaitPendingRequest();
      request2.respond({
        stopReason: "tool_use",
        text: "Now let me check your project structure.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId2,
              toolName: "bash_command" as ToolName,
              input: { command: "echo 'Project structure summary'" },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("Project structure summary");

      // Final part of the assistant's response
      const request3 = await driver.mockAnthropic.awaitPendingRequest();
      request3.respond({
        stopReason: "end_turn",
        text: "Based on these results, I can help you.",
        toolRequests: [],
      });

      // Verify all parts of the conversation are present
      await driver.assertDisplayBufferContains("Can you help me with my code?");
      await driver.assertDisplayBufferContains(
        "I'll help you. Let me check your project first.",
      );
      await driver.assertDisplayBufferContains(
        "Now let me check your project structure.",
      );
      await driver.assertDisplayBufferContains(
        "Based on these results, I can help you.",
      );

      const thread = driver.magenta.chat.getActiveThread();
      const messages = thread.getMessages();

      expect(messages.length).toBe(6);
      expect(
        messages.flatMap((m) => m.content.map((b) => m.role + ":" + b.type)),
      ).toEqual([
        "user:text",
        "assistant:text",
        "assistant:tool_use",
        "user:tool_result",
        "assistant:text",
        "assistant:tool_use",
        "user:tool_result",
        "assistant:text",
      ]);
    });
  });

  it("handles errors during streaming response", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText("Test error handling during response");
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();

      // Simulate an error during streaming
      const errorMessage = "Simulated error during streaming";
      request.respondWithError(new Error(errorMessage));

      // Verify the error is handled and displayed to the user
      await driver.assertDisplayBufferContains(
        "Test error handling during response",
      );

      // Verify error message is displayed in the UI
      await driver.assertDisplayBufferContains("Error");
      await driver.assertDisplayBufferContains(errorMessage);
    });
  });

  it("compacts a thread with multiple messages into a new thread", async () => {
    await withDriver({}, async (driver) => {
      // 1. Open the sidebar
      await driver.showSidebar();

      // 2. Create a thread with multiple messages and tool uses
      await driver.inputMagentaText("What is the capital of France?");
      await driver.send();

      // Wait for the request and respond
      const request1 = await driver.mockAnthropic.awaitPendingRequest({
        message: "initial request",
      });
      request1.respond({
        stopReason: "end_turn",
        text: "The capital of France is Paris.",
        toolRequests: [],
      });

      // Add a second message with a tool use
      await driver.inputMagentaText("What about Germany?");
      await driver.send();
      // Wait for the request and respond with a tool use (bash_command)
      const request2 = await driver.mockAnthropic.awaitPendingRequest({
        message: "followup request",
      });
      const firstBashToolId = "first-bash-tool" as ToolRequestId;
      request2.respond({
        stopReason: "tool_use",
        text: "Let me check if I can find some information about Germany in your system.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: firstBashToolId,
              toolName: "bash_command" as ToolName,
              input: { command: "echo 'Information about Germany'" },
            },
          },
        ],
      });

      const request3 = await driver.mockAnthropic.awaitPendingRequest({
        message: "first-bash auto-response",
      });
      const secondBashToolId = "second-bash-tool" as ToolRequestId;
      request3.respond({
        stopReason: "tool_use",
        text: "Let me check for more details about European countries.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: secondBashToolId,
              toolName: "bash_command" as ToolName,
              input: { command: "echo 'European countries information'" },
            },
          },
        ],
      });

      const request4 = await driver.mockAnthropic.awaitPendingRequest({
        message: "second-bash auto-response",
      });
      const bashToolId = "bash-tool" as ToolRequestId;
      request4.respond({
        stopReason: "tool_use",
        text: "test bash tool",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: bashToolId,
              toolName: "bash_command" as ToolName,
              input: {
                command: "echo test",
              },
            },
          },
        ],
      });

      const request5 = await driver.mockAnthropic.awaitPendingRequest({
        message: "bash auto-response",
      });
      request5.respond({
        stopReason: "end_turn",
        text: "The capital of Germany is Berlin.",
        toolRequests: [],
      });

      // 3. Initiate thread compaction
      await driver.inputMagentaText("@compact Tell me about Italy");
      await driver.send();

      // 4. Verify the forceToolUse request for compact_thread was made
      const request =
        await driver.mockAnthropic.awaitPendingForceToolUseRequest(
          "compact request",
        );

      expect(request.messages).toMatchSnapshot("forced-tool-request-messages");

      const contextFiles = [
        `${TMP_DIR}/poem.txt` as unknown as UnresolvedFilePath,
        `${TMP_DIR}/poem2.txt` as unknown as UnresolvedFilePath,
      ];

      const compactInput: CompactThreadInput = {
        contextFiles,
        summary:
          "We discussed European capitals (France: Paris, Germany: Berlin) and examined your project structure, which contains TypeScript files.",
      };

      const toolRequestId = "compact-thread-tool" as ToolRequestId;
      await driver.mockAnthropic.respondToForceToolUse({
        stopReason: "end_turn",
        toolRequest: {
          status: "ok",
          value: {
            id: toolRequestId,
            toolName: "compact_thread" as ToolName,
            input: compactInput,
          },
        },
      });

      // 6. Verify a new thread was created and is active
      // Check that the new thread contains the summary and the latest message
      await driver.assertDisplayBufferContains(
        "We discussed European capitals",
      );
      await driver.assertDisplayBufferContains("Tell me about Italy");

      // 7. Respond to the new thread's initial message
      const request6 = await driver.mockAnthropic.awaitPendingRequest();
      request6.respond({
        stopReason: "end_turn",
        text: "Italy's capital is Rome. It's known for its rich history, art, and cuisine.",
        toolRequests: [],
      });

      // 8. Verify the complete conversation flow
      await driver.assertDisplayBufferContains("Tell me about Italy");
      await driver.assertDisplayBufferContains("Italy's capital is Rome");

      // 9. Get the current thread and check its state
      const thread = driver.magenta.chat.getActiveThread();

      // Check that the first message contains the context from compaction
      expect(thread.state.messages[0].state.content).toBeDefined();

      // The original thread should have been replaced
      // Since we can't directly check the buffer doesn't contain text, assert it does contain
      // text we expect, which would replace the text from the old thread
      await driver.assertDisplayBufferContains("Tell me about Italy");

      // Get the context manager from the thread directly
      const contextManager = thread.contextManager;

      // Verify that contextManager.files contains the two poem files we added
      const files = contextManager.files;
      expect(Object.keys(files).length).toBe(2);

      // 10. Verify the thread's message structure after compaction
      const messages = thread.getMessages();

      expect(messages).toMatchSnapshot("compacted-thread-messages");

      // First message should be the summary (context), second should be the user's question about Italy
      expect(messages.length).toBe(2);

      // Verify we captured expected message structure (user->assistant)
      expect(
        messages.flatMap((m) => m.content.map((b) => m.role + ":" + b.type)),
      ).toEqual([
        "user:text", // Context files added to the new thread
        "user:text", // The compacted thread summary (system message)
        "user:text", // The user question about Italy
        "assistant:text", // The assistant response about Rome
      ]);
    });
  });

  it(
    "processes @diag keyword to include diagnostics in message",
    { timeout: 10000 },
    async () => {
      await withDriver({}, async (driver) => {
        // Create a file with syntax errors to generate diagnostics
        await driver.editFile("node/test/fixtures/test.ts");
        await driver.showSidebar();

        // Wait for diagnostics to be available
        await pollUntil(
          async () => {
            const diagnostics = (await driver.nvim.call("nvim_exec_lua", [
              `return vim.diagnostic.get(nil)`,
              [],
            ])) as unknown[];

            if (diagnostics.length === 0) {
              throw new Error("No diagnostics available yet");
            }
          },
          { timeout: 5000 },
        );

        // Send a message with @diag keyword
        await driver.inputMagentaText("Help me fix this issue @diag");
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingRequest();
        request.respond({
          stopReason: "end_turn",
          text: "I can see the diagnostics you've provided. Let me help you fix the issue.",
          toolRequests: [],
        });

        // Verify the original message is displayed
        await driver.assertDisplayBufferContains(
          "Help me fix this issue @diag",
        );

        // Verify the diagnostics are appended as a separate content block
        await driver.assertDisplayBufferContains("Current diagnostics:");
        await driver.assertDisplayBufferContains(
          "Property 'd' does not exist on type",
        );
        await driver.assertDisplayBufferContains("node/test/fixtures/test.ts");

        // Check the thread message structure
        const thread = driver.magenta.chat.getActiveThread();
        const messages = thread.getMessages();

        // Should have user message and assistant response
        expect(messages.length).toBe(2);

        // The user message should have two content blocks: original text + diagnostics
        expect(messages[0].content.length).toBe(2);
        const content0 = messages[0].content[0];
        expect(content0.type).toBe("text");
        expect(
          (content0 as Extract<typeof content0, { type: "text" }>).text,
        ).toBe("Help me fix this issue @diag");
        const content1 = messages[0].content[1];
        expect(content1.type).toBe("text");
        expect(
          (content1 as Extract<typeof content1, { type: "text" }>).text,
        ).toContain("Current diagnostics:");
        expect(
          (content1 as Extract<typeof content1, { type: "text" }>).text,
        ).toContain("Property 'd' does not exist on type");
      });
    },
  );

  it(
    "processes @diagnostics keyword to include diagnostics in message",
    { timeout: 10000 },
    async () => {
      await withDriver({}, async (driver) => {
        // Create a file with syntax errors to generate diagnostics
        await driver.editFile("node/test/fixtures/test.ts");
        await driver.showSidebar();

        // Wait for diagnostics to be available
        await pollUntil(
          async () => {
            const diagnostics = (await driver.nvim.call("nvim_exec_lua", [
              `return vim.diagnostic.get(nil)`,
              [],
            ])) as unknown[];

            if (diagnostics.length === 0) {
              throw new Error("No diagnostics available yet");
            }
          },
          { timeout: 5000 },
        );

        // Send a message with @diagnostics keyword
        await driver.inputMagentaText("Check these @diagnostics please");
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingRequest();
        request.respond({
          stopReason: "end_turn",
          text: "I can see the diagnostics. Let me analyze them for you.",
          toolRequests: [],
        });

        // Verify the original message is displayed
        await driver.assertDisplayBufferContains(
          "Check these @diagnostics please",
        );

        // Verify the diagnostics are appended as a separate content block
        await driver.assertDisplayBufferContains("Current diagnostics:");
        await driver.assertDisplayBufferContains(
          "Property 'd' does not exist on type",
        );

        // Check the thread message structure
        const thread = driver.magenta.chat.getActiveThread();
        const messages = thread.getMessages();

        // Should have user message and assistant response
        expect(messages.length).toBe(2);

        // The user message should have two content blocks: original text + diagnostics
        expect(messages[0].content.length).toBe(2);
        const content0 = messages[0].content[0];
        expect(content0.type).toBe("text");
        expect(
          (content0 as Extract<typeof content0, { type: "text" }>).text,
        ).toBe("Check these @diagnostics please");
        const content1 = messages[0].content[1];
        expect(content1.type).toBe("text");
        expect(
          (content1 as Extract<typeof content1, { type: "text" }>).text,
        ).toContain("Current diagnostics:");
      });
    },
  );
  it(
    "processes @qf keyword to include quickfix list in message",
    { timeout: 10000 },
    async () => {
      await withDriver({}, async (driver) => {
        // Create some test quickfix entries
        await driver.nvim.call("nvim_command", [
          "call setqflist([" +
            "{'filename': 'test1.ts', 'lnum': 10, 'col': 5, 'text': 'Error: undefined variable'}," +
            "{'filename': 'test2.js', 'lnum': 25, 'col': 12, 'text': 'Warning: unused import'}" +
            "])",
        ]);

        await driver.showSidebar();

        // Send a message with @qf keyword
        await driver.inputMagentaText("Help me fix these issues @qf");
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingRequest();
        request.respond({
          stopReason: "end_turn",
          text: "I can see the quickfix list you've provided. Let me help you fix these issues.",
          toolRequests: [],
        });

        // Verify the original message is displayed
        await driver.assertDisplayBufferContains(
          "Help me fix these issues @qf",
        );

        // Verify the quickfix list is appended as a separate content block
        await driver.assertDisplayBufferContains("Current quickfix list:");
        await driver.assertDisplayBufferContains("Error: undefined variable");
        await driver.assertDisplayBufferContains("Warning: unused import");
        await driver.assertDisplayBufferContains("test1.ts:10:5");
        await driver.assertDisplayBufferContains("test2.js:25:12");

        // Check the thread message structure
        const thread = driver.magenta.chat.getActiveThread();
        const messages = thread.getMessages();

        // Should have user message and assistant response
        expect(messages.length).toBe(2);

        // The user message should have two content blocks: original text + quickfix list
        expect(messages[0].content.length).toBe(2);
        const content0 = messages[0].content[0];
        expect(content0.type).toBe("text");
        expect(
          (content0 as Extract<typeof content0, { type: "text" }>).text,
        ).toBe("Help me fix these issues @qf");
        const content1 = messages[0].content[1];
        expect(content1.type).toBe("text");
        expect(
          (content1 as Extract<typeof content1, { type: "text" }>).text,
        ).toContain("Current quickfix list:");
        expect(
          (content1 as Extract<typeof content1, { type: "text" }>).text,
        ).toContain("Error: undefined variable");
        expect(
          (content1 as Extract<typeof content1, { type: "text" }>).text,
        ).toContain("Warning: unused import");
      });
    },
  );

  it(
    "processes @quickfix keyword to include quickfix list in message",
    { timeout: 10000 },
    async () => {
      await withDriver({}, async (driver) => {
        // Create some test quickfix entries
        await driver.nvim.call("nvim_command", [
          "call setqflist([" +
            "{'filename': 'error.py', 'lnum': 42, 'col': 1, 'text': 'SyntaxError: invalid syntax'}," +
            "{'filename': 'warning.js', 'lnum': 15, 'col': 8, 'text': 'Unused variable'}" +
            "])",
        ]);

        await driver.showSidebar();

        // Send a message with @quickfix keyword
        await driver.inputMagentaText("Check these @quickfix entries");
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingRequest();
        request.respond({
          stopReason: "end_turn",
          text: "I can see the quickfix entries. Let me analyze them for you.",
          toolRequests: [],
        });

        // Verify the original message is displayed
        await driver.assertDisplayBufferContains(
          "Check these @quickfix entries",
        );

        // Verify the quickfix list is appended as a separate content block
        await driver.assertDisplayBufferContains("Current quickfix list:");
        await driver.assertDisplayBufferContains("SyntaxError: invalid syntax");
        await driver.assertDisplayBufferContains("Unused variable");
        await driver.assertDisplayBufferContains("error.py:42:1");
        await driver.assertDisplayBufferContains("warning.js:15:8");

        // Check the thread message structure
        const thread = driver.magenta.chat.getActiveThread();
        const messages = thread.getMessages();

        // Should have user message and assistant response
        expect(messages.length).toBe(2);

        // The user message should have two content blocks: original text + quickfix list
        expect(messages[0].content.length).toBe(2);
        const content0 = messages[0].content[0];
        expect(content0.type).toBe("text");
        expect(
          (content0 as Extract<typeof content0, { type: "text" }>).text,
        ).toBe("Check these @quickfix entries");
        const content1 = messages[0].content[1];
        expect(content1.type).toBe("text");
        expect(
          (content1 as Extract<typeof content1, { type: "text" }>).text,
        ).toContain("Current quickfix list:");
        expect(
          (content1 as Extract<typeof content1, { type: "text" }>).text,
        ).toContain("SyntaxError: invalid syntax");
      });
    },
  );

  it(
    "handles empty quickfix list with @qf command",
    { timeout: 10000 },
    async () => {
      await withDriver({}, async (driver) => {
        // Clear quickfix list
        await driver.nvim.call("nvim_command", ["call setqflist([])"]);

        await driver.showSidebar();

        // Send a message with @qf keyword
        await driver.inputMagentaText("Any issues to fix? @qf");
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingRequest();
        request.respond({
          stopReason: "end_turn",
          text: "I can see the quickfix list is empty. No issues to fix right now!",
          toolRequests: [],
        });

        // Verify the original message is displayed
        await driver.assertDisplayBufferContains("Any issues to fix? @qf");

        // Verify the empty quickfix list is handled properly
        await driver.assertDisplayBufferContains("Current quickfix list:");

        // Check the thread message structure
        const thread = driver.magenta.chat.getActiveThread();
        const messages = thread.getMessages();

        // Should have user message and assistant response
        expect(messages.length).toBe(2);

        // The user message should have two content blocks: original text + empty quickfix list
        expect(messages[0].content.length).toBe(2);
        const content1 = messages[0].content[1];
        expect(content1.type).toBe("text");
        expect(
          (content1 as Extract<typeof content1, { type: "text" }>).text,
        ).toBe("Current quickfix list:\n");
      });
    },
  );
});
