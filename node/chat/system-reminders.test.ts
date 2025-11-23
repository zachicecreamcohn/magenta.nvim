import { test, expect } from "vitest";
import { withDriver } from "../test/preamble.ts";
import type { ToolName, ToolRequestId } from "../tools/types.ts";

test("user-submitted messages should include system reminder", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Send a user message
    await driver.inputMagentaText("Hello");
    await driver.send();

    // Get the request
    const request = await driver.mockAnthropic.awaitPendingRequest();

    // Check the last message (user message) has system reminder
    const userMessage = request.messages[request.messages.length - 1];
    expect(userMessage.role).toBe("user");

    // Find system reminder in content
    const systemReminder = userMessage.content.find(
      (c) => c.type === "system_reminder",
    );
    expect(systemReminder).toBeDefined();
    expect(systemReminder?.type).toBe("system_reminder");

    if (systemReminder && systemReminder.type === "system_reminder") {
      expect(systemReminder.text).toContain("<system-reminder>");
      expect(systemReminder.text).toContain("Remember to use skills");
    }
  });
});

test("auto-respond messages should NOT include system reminder", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Send a user message
    await driver.inputMagentaText("Use a tool");
    await driver.send();

    // Get the request
    const request = await driver.mockAnthropic.awaitPendingRequest();

    // Respond with a tool use
    request.respond({
      stopReason: "tool_use",
      text: "I'll use get_file",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "tool_1" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: { filePath: "./poem.txt" },
          },
        },
      ],
    });

    // Wait for the auto-respond (tool result message)
    const autoRespondRequest = await driver.mockAnthropic.awaitPendingRequest();

    // The last message should be a user message with tool result
    const userMessage =
      autoRespondRequest.messages[autoRespondRequest.messages.length - 1];
    expect(userMessage.role).toBe("user");

    // This auto-respond message should NOT have a system reminder
    const systemReminder = userMessage.content.find(
      (c) => c.type === "system_reminder",
    );
    expect(systemReminder).toBeUndefined();
  });
});

test("root thread should get base reminder", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("Hello");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingRequest();
    const userMessage = request.messages[request.messages.length - 1];

    const systemReminder = userMessage.content.find(
      (c) => c.type === "system_reminder",
    ) as Extract<
      (typeof userMessage.content)[number],
      { type: "system_reminder" }
    >;

    expect(systemReminder).toBeDefined();
    expect(systemReminder.text).toContain("Remember to use skills");
    // Root thread should NOT have yield_to_parent reminder
    expect(systemReminder.text).not.toContain("yield_to_parent");
    expect(systemReminder.text).not.toContain("notes/");
    expect(systemReminder.text).not.toContain("plans/");
  });
});

test("system reminder should be collapsed by default in UI", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("Hello");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingRequest();
    request.respond({
      stopReason: "end_turn",
      text: "Response",
      toolRequests: [],
    });

    // Check that the collapsed reminder is shown
    await driver.assertDisplayBufferContains("📋 [System Reminder]");

    // Check that the full text is NOT shown initially
    const displayBuffer = await driver.getDisplayBufferText();
    expect(displayBuffer).not.toContain("Remember to use skills");
  });
});

test("system reminder is rendered in UI", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("Hello");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingRequest();
    request.respond({
      stopReason: "end_turn",
      text: "Response",
      toolRequests: [],
    });

    // Verify the system reminder is displayed in the UI
    await driver.assertDisplayBufferContains("📋 [System Reminder]");
  });
});

test("system reminder content appears after context updates", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Add a file to context
    await driver.magenta.command("add-file ./poem.txt");

    // Send a user message
    await driver.inputMagentaText("Hello");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingRequest();
    const userMessage = request.messages[request.messages.length - 1];

    expect(userMessage.role).toBe("user");

    // Find context update and system reminder
    const contextUpdate = userMessage.content.find((c) => c.type === "text");
    const systemReminder = userMessage.content.find(
      (c) => c.type === "system_reminder",
    );

    expect(contextUpdate).toBeDefined();
    expect(systemReminder).toBeDefined();

    // System reminder should come after context update
    const contextIdx = userMessage.content.indexOf(contextUpdate!);
    const reminderIdx = userMessage.content.indexOf(systemReminder!);
    expect(reminderIdx).toBeGreaterThan(contextIdx);
  });
});

test("multiple user messages each get their own system reminder", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // First message
    await driver.inputMagentaText("First message");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingRequest();
    const userMessage1 = request1.messages[request1.messages.length - 1];
    const reminder1 = userMessage1.content.find(
      (c) => c.type === "system_reminder",
    );
    expect(reminder1).toBeDefined();

    request1.respond({
      stopReason: "end_turn",
      text: "Response 1",
      toolRequests: [],
    });

    // Second message
    await driver.inputMagentaText("Second message");
    await driver.send();

    const request2 = await driver.mockAnthropic.awaitPendingRequest();
    const userMessage2 = request2.messages[request2.messages.length - 1];
    const reminder2 = userMessage2.content.find(
      (c) => c.type === "system_reminder",
    );
    expect(reminder2).toBeDefined();
  });
});
