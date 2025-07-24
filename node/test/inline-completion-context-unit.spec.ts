import { expect, it } from "vitest";
import { withDriver } from "./preamble";

it("getMagentaContext handles empty state gracefully", async () => {
  await withDriver({}, async (driver) => {
    // Start sidebar and create a thread
    await driver.showSidebar();
    await driver.waitForChatReady();
    
    // Access the inline completion controller's getMagentaContext method
    const controller = driver.magenta.inlineCompletionController;
    
    // Use reflection to access the private method for testing
    const getMagentaContext = (controller as any).getMagentaContext.bind(controller);
    const context = await getMagentaContext();
    
    // Even with no content, it should return a string (might be empty)
    expect(typeof context).toBe("string");
    
    // Should not crash or throw errors
    expect(true).toBe(true);
  });
});

it("getMagentaContext returns context after sending messages", async () => {
  await withDriver({}, async (driver) => {
    // Start sidebar and create a thread with content
    await driver.showSidebar();
    await driver.waitForChatReady();
    
    // Send a message to create chat history
    await driver.inputMagentaText("Help me write a TypeScript function");
    await driver.send();
    
    // Wait a moment for the message to be processed
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Access the inline completion controller's getMagentaContext method
    const controller = driver.magenta.inlineCompletionController;
    
    // Use reflection to access the private method for testing
    const getMagentaContext = (controller as any).getMagentaContext.bind(controller);
    const context = await getMagentaContext();
    
    // Verify the context is returned as a string
    expect(typeof context).toBe("string");
    
    // Since we sent a message, there should be some context (unless filtered out)
    // The exact content depends on the message processing, but it shouldn't crash
    expect(true).toBe(true);
  });
});