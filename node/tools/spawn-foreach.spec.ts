import { withDriver } from "../test/preamble.ts";
import { it, expect } from "vitest";
import type { ToolRequestId } from "./toolManager.ts";
import type { ToolName } from "./types.ts";

it("respects maxConcurrentSubagents limit and processes elements in batches", async () => {
  await withDriver(
    {
      options: { maxConcurrentSubagents: 3 },
    },
    async (driver) => {
      await driver.showSidebar();

      // Create a foreach request with 4 elements (more than the limit of 3)
      await driver.inputMagentaText(
        "Use spawn_foreach to process 4 elements concurrently.",
      );
      await driver.send();

      const request1 =
        await driver.mockAnthropic.awaitPendingRequestWithText(
          "Use spawn_foreach",
        );
      request1.respond({
        stopReason: "tool_use",
        text: "I'll use spawn_foreach to process 4 elements in parallel.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-foreach" as ToolRequestId,
              toolName: "spawn_foreach" as ToolName,
              input: {
                prompt: "Process this element and yield the result",
                elements: ["element1", "element2", "element3", "element4"],
              },
            },
          },
        ],
      });

      // The first 3 subagents should start running
      const subagent1Request =
        await driver.mockAnthropic.awaitPendingRequestWithText("element1");
      const subagent2Request =
        await driver.mockAnthropic.awaitPendingRequestWithText("element2");
      const subagent3Request =
        await driver.mockAnthropic.awaitPendingRequestWithText("element3");

      // Now we should see 3 running and 1 pending
      await driver.assertDisplayBufferContains("🤖⏳ Foreach subagents (0/4):");
      await driver.assertDisplayBufferContains("- element1: ⏳");
      await driver.assertDisplayBufferContains("- element2: ⏳");
      await driver.assertDisplayBufferContains("- element3: ⏳");
      await driver.assertDisplayBufferContains("- element4: ⏸️");

      // Complete the first subagent
      subagent1Request.respond({
        stopReason: "tool_use",
        text: "I'll yield the result for element1.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-element1" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result: "Processed element1 successfully",
              },
            },
          },
        ],
      });

      // After element1 completes, element4 should start and element1 should show as completed
      await driver.assertDisplayBufferContains("🤖⏳ Foreach subagents (1/4):");
      await driver.assertDisplayBufferContains("- element1: ✅");

      // The 4th subagent should now start
      const subagent4Request =
        await driver.mockAnthropic.awaitPendingRequestWithText("element4");

      // Verify element4 is now running
      await driver.assertDisplayBufferContains("- element4: ⏳");

      // Complete the remaining 3 subagents
      subagent2Request.respond({
        stopReason: "tool_use",
        text: "I'll yield the result for element2.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-element2" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result: "Processed element2 successfully",
              },
            },
          },
        ],
      });

      subagent3Request.respond({
        stopReason: "tool_use",
        text: "I'll yield the result for element3.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-element3" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result: "Processed element3 successfully",
              },
            },
          },
        ],
      });

      subagent4Request.respond({
        stopReason: "tool_use",
        text: "I'll yield the result for element4.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-element4" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result: "Processed element4 successfully",
              },
            },
          },
        ],
      });

      // All elements should now be completed
      await driver.assertDisplayBufferContains("🤖✅ Foreach subagents (4/4)");

      // The parent thread should receive the foreach tool result
      const parentRequest =
        await driver.mockAnthropic.awaitPendingRequestWithText(
          "Foreach subagent execution completed",
        );

      // Verify the tool response contains all subagent results
      const toolResponses = parentRequest.getToolResponses();
      const foreachResponse = toolResponses.find(
        (response) => response.tool_use_id === "test-foreach",
      );

      expect(foreachResponse).toBeDefined();
      expect(foreachResponse!.content).toContain("Total elements: 4");
      expect(foreachResponse!.content).toContain("Successful: 4");
      expect(foreachResponse!.content).toContain("Failed: 0");
      expect(foreachResponse!.content).toContain(
        "- element1: Processed element1 successfully",
      );
      expect(foreachResponse!.content).toContain(
        "- element2: Processed element2 successfully",
      );
      expect(foreachResponse!.content).toContain(
        "- element3: Processed element3 successfully",
      );
      expect(foreachResponse!.content).toContain(
        "- element4: Processed element4 successfully",
      );

      parentRequest.streamText(
        "All foreach subagents have completed successfully.",
      );
      parentRequest.finishResponse("end_turn");
    },
  );
});

it("handles subagent errors gracefully and continues processing remaining elements", async () => {
  await withDriver(
    {
      options: { maxConcurrentSubagents: 1 },
    },
    async (driver) => {
      await driver.showSidebar();

      // Create a foreach request with 2 elements, first will error
      await driver.inputMagentaText(
        "Use spawn_foreach to process 2 elements, first will fail.",
      );
      await driver.send();

      const request1 =
        await driver.mockAnthropic.awaitPendingRequestWithText(
          "Use spawn_foreach",
        );
      request1.respond({
        stopReason: "tool_use",
        text: "I'll use spawn_foreach to process 2 elements.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-foreach-error" as ToolRequestId,
              toolName: "spawn_foreach" as ToolName,
              input: {
                prompt: "Process this element",
                elements: ["error_element", "success_element"],
              },
            },
          },
        ],
      });

      // First subagent should start (error_element)
      const subagent1Request =
        await driver.mockAnthropic.awaitPendingRequestWithText("error_element");

      // Verify initial state: 1 running, 1 pending
      await driver.assertDisplayBufferContains("🤖⏳ Foreach subagents (0/2):");
      await driver.assertDisplayBufferContains("- error_element: ⏳");
      await driver.assertDisplayBufferContains("- success_element: ⏸️");

      // First subagent encounters an error
      subagent1Request.respondWithError(new Error("Simulated subagent error"));

      // Verify error_element shows as error state
      await driver.assertDisplayBufferContains("- error_element: ❌");

      // After error_element fails, success_element should start
      const subagent2Request =
        await driver.mockAnthropic.awaitPendingRequestWithText(
          "success_element",
        );

      // Second subagent succeeds
      subagent2Request.respond({
        stopReason: "tool_use",
        text: "I'll yield a successful result.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-success" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result: "Successfully processed success_element",
              },
            },
          },
        ],
      });

      // All elements should now be completed (1 success, 1 error)
      await driver.assertDisplayBufferContains("🤖✅ Foreach subagents (2/2)");

      // The parent thread should receive the foreach tool result
      const parentRequest =
        await driver.mockAnthropic.awaitPendingRequestWithText(
          "Foreach subagent execution completed",
        );

      // Verify the tool response contains results from both subagents
      const toolResponses = parentRequest.getToolResponses();
      const foreachResponse = toolResponses.find(
        (response) => response.tool_use_id === "test-foreach-error",
      );

      expect(foreachResponse).toBeDefined();

      expect(foreachResponse!.content).toContain("Total elements: 2");
      expect(foreachResponse!.content).toContain("Successful: 1");
      expect(foreachResponse!.content).toContain("Failed: 1");
      expect(foreachResponse!.content).toContain(
        "- success_element: Successfully processed success_element",
      );
      expect(foreachResponse!.content).toContain("- error_element:");

      parentRequest.streamText(
        "Foreach subagents completed with mixed results.",
      );
      parentRequest.finishResponse("end_turn");
    },
  );
});
