import { test, expect } from "vitest";
import { withDriver } from "../test/preamble";
import type { ToolRequestId } from "../tools/types";
import type { ToolName } from "../tools/types";
import { getCurrentBuffer } from "../nvim/nvim";
import type { Row0Indexed } from "../nvim/window";
import type { AbsFilePath } from "../utils/files";

test("prediction after making edits", async () => {
  await withDriver({}, async (driver) => {
    // Open the poem.txt fixture file
    await driver.editFile("poem.txt");

    // Make some real edits to generate change tracking
    // Change "Moonlight" to "Starlight" on the first line
    await driver.command("normal! gg");
    await driver.command("normal! f M");
    await driver.command("normal! ciwStarlight");

    // Position cursor in the middle of line 3 for prediction context
    await driver.command("normal! jj");
    await driver.command("normal! f a");

    // Wait for our edits to be tracked by the change tracker
    // The change tracker may batch rapid edits into a single change
    await driver.assertChangeTrackerHasEdits(1);
    await driver.assertChangeTrackerContains([
      { newText: "Starlight", filePath: "poem.txt" },
    ]);

    // Trigger predict-edit command (ctrl-l)
    await driver.magenta.command("predict-edit");

    // Wait for the mock provider to receive the force tool use request
    const request =
      await driver.mockAnthropic.awaitPendingForceToolUseRequest();

    // Verify the request uses the predict_edit tool
    expect(request.spec.name).toBe("predict_edit");
    expect(request.spec.description).toContain("Predicts the user's next edit");

    // Verify the request is for the fast model
    expect(request.model).toBe("claude-3-5-haiku-latest");

    // Verify we have exactly one user message with context

    // Verify the system prompt contains general instructions
    expect(request.systemPrompt).toBeDefined();
    const systemPrompt = request.systemPrompt!;
    expect(systemPrompt.toLowerCase()).toContain(
      "predict the user's next edit",
    );
    expect(systemPrompt).not.toContain("│"); // Specific content should not be in system prompt

    // Verify the user message contains the specific context
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0].role).toBe("user");
    expect(request.messages[0].content).toHaveLength(1);

    const userMessage = request.messages[0].content[0];
    expect(userMessage.type).toBe("text");

    const text = userMessage.type === "text" ? userMessage.text : "";

    // Should contain buffer content around cursor with cursor marker
    expect(text).toMatchSnapshot();
  });
});

test("context window trims to 10 lines before and after cursor", async () => {
  await withDriver({}, async (driver) => {
    // Create a file with many lines to test context trimming
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);

    // Write the content to a test file
    await driver.command(`edit test-long-file.txt`);
    await driver.command(`call setline(1, ${JSON.stringify(lines)})`);

    // Position cursor at line 25 (middle of file)
    await driver.command("normal! 25G");

    // Generate message via the edit prediction controller
    const userMessage =
      await driver.magenta.editPredictionController.composeUserMessage();

    expect(userMessage).toMatchSnapshot();
  });
});

test("state management through prediction lifecycle", async () => {
  await withDriver({}, async (driver) => {
    const controller = driver.magenta.editPredictionController;

    // Initial state should be idle
    expect(controller.state.type).toBe("idle");

    // Open the poem.txt fixture file
    await driver.editFile("poem.txt");

    // Make some real edits to generate change tracking
    await driver.command("normal! gg");
    await driver.command("normal! f M");
    await driver.command("normal! ciwStarlight");

    // Position cursor for prediction
    await driver.command("normal! jj");
    await driver.command("normal! f a");

    // Trigger predict-edit command
    await driver.magenta.command("predict-edit");

    // Wait for state to transition to awaiting-agent-reply
    await driver.awaitPredictionControllerState("awaiting-agent-reply");

    // State should now be awaiting-agent-reply
    expect(controller.state.type).toBe("awaiting-agent-reply");
    const state = controller.state as Extract<
      typeof controller.state,
      { type: "awaiting-agent-reply" }
    >;
    expect(state.contextWindow).toBeDefined();
    expect(state.requestStartTime).toBeTypeOf("number");

    // Get the pending request
    await driver.mockAnthropic.awaitPendingForceToolUseRequest();

    // Mock a successful response
    await driver.mockAnthropic.respondToForceToolUse({
      stopReason: "end_turn",
      toolRequest: {
        status: "ok",
        value: {
          id: "id" as ToolRequestId,
          toolName: "predict_edit" as ToolName,
          input: {
            find: "ancient",
            replace: "mystical",
          },
        },
      },
    });

    // Give the async response handling time to process
    await new Promise((resolve) => setTimeout(resolve, 10));

    // State should now be displaying-proposed-edit
    expect(controller.state.type).toBe("displaying-proposed-edit");
    const displayState = controller.state as Extract<
      typeof controller.state,
      { type: "displaying-proposed-edit" }
    >;
    expect(displayState.contextWindow).toBeDefined();
    expect(displayState.prediction).toEqual({
      find: "ancient",
      replace: "mystical",
    });
  });
});

test("error handling during prediction", async () => {
  await withDriver({}, async (driver) => {
    const controller = driver.magenta.editPredictionController;

    // Open file and position cursor
    await driver.editFile("poem.txt");
    await driver.command("normal! gg");

    // Trigger predict-edit command
    await driver.magenta.command("predict-edit");

    // Wait for state to transition to awaiting-agent-reply
    await driver.awaitPredictionControllerState("awaiting-agent-reply");

    // State should be awaiting-agent-reply
    expect(controller.state.type).toBe("awaiting-agent-reply");

    // Get the pending request
    await driver.mockAnthropic.awaitPendingForceToolUseRequest();

    // Mock an error response
    await driver.mockAnthropic.respondToForceToolUse({
      stopReason: "end_turn",
      toolRequest: {
        status: "error",
        error: "Network timeout",
        rawRequest: {},
      },
    });

    // Give the async error handling time to process
    await new Promise((resolve) => setTimeout(resolve, 10));

    // State should return to idle after error
    expect(controller.state.type).toBe("idle");
  });
});

test("context recent changes to requested count", async () => {
  await withDriver({}, async (driver) => {
    // Open the poem.txt fixture file
    await driver.editFile("poem.txt");

    // Get the current working directory from nvim
    const filePath = `${driver.magenta.cwd}/poem.txt`;

    // Add 10 changes directly to the change tracker using correct API
    for (let i = 0; i < 10; i++) {
      driver.magenta.changeTracker.onTextDocumentDidChange({
        filePath,
        oldText: `${i}`,
        newText: `${i + 1}`,
        range: {
          start: { line: 0, character: i },
          end: { line: 0, character: i + 1 },
        },
      });
    }

    // Generate message via the edit prediction controller
    const userMessage =
      await driver.magenta.editPredictionController.composeUserMessage();

    // Capture the entire user message in a snapshot
    expect(userMessage).toMatchSnapshot();
  });
});

test("new trigger aborts existing requests and starts fresh", async () => {
  await withDriver({}, async (driver) => {
    // Open file and position cursor
    await driver.editFile("poem.txt");
    await driver.command("normal! gg");

    // Trigger first predict-edit command
    await driver.magenta.command("predict-edit");

    // Wait for state to transition to awaiting-agent-reply
    await driver.awaitPredictionControllerState("awaiting-agent-reply");

    // Get the first request
    const firstRequest =
      await driver.mockAnthropic.awaitPendingForceToolUseRequest();
    expect(firstRequest.defer.resolved).toBe(false);

    // Trigger another prediction while awaiting reply
    await driver.magenta.command("predict-edit");

    // Wait for the new state transition
    await driver.awaitPredictionControllerState("awaiting-agent-reply");

    // First request should have been aborted
    expect(firstRequest.defer.resolved).toBe(true);

    // Should now have two requests total (first aborted, second pending)
    expect(driver.mockAnthropic.forceToolUseRequests).toHaveLength(2);

    // The second request should be pending
    const secondRequest = driver.mockAnthropic.forceToolUseRequests[1];
    expect(secondRequest.defer.resolved).toBe(false);
  });
});

test("virtual text preview shows predicted edits", async () => {
  await withDriver({}, async (driver) => {
    const controller = driver.magenta.editPredictionController;

    // Open file with content that can be predicted
    await driver.editFile("poem.txt");
    await driver.command("normal! gg");

    // Trigger prediction
    await driver.magenta.command("predict-edit");
    await driver.awaitPredictionControllerState("awaiting-agent-reply");

    // Mock a response with a simple replacement
    await driver.mockAnthropic.awaitPendingForceToolUseRequest();
    await driver.mockAnthropic.respondToForceToolUse({
      stopReason: "end_turn",
      toolRequest: {
        status: "ok",
        value: {
          id: "id" as ToolRequestId,
          toolName: "predict_edit" as ToolName,
          input: {
            find: "Moonlight",
            replace: "Starlight",
          },
        },
      },
    });

    // Wait for virtual text to be displayed
    await new Promise((resolve) => setTimeout(resolve, 100));

    // State should be displaying proposed edit
    expect(controller.state.type).toBe("displaying-proposed-edit");

    // Verify that extmarks are created in the buffer
    // We can't easily test the visual output, but we can verify state
    const displayState = controller.state as Extract<
      typeof controller.state,
      { type: "displaying-proposed-edit" }
    >;
    expect(displayState.prediction).toEqual({
      find: "Moonlight",
      replace: "Starlight",
    });
  });
});

test("prediction accepted applies edits", async () => {
  await withDriver({}, async (driver) => {
    const controller = driver.magenta.editPredictionController;

    // Open file and position cursor
    await driver.editFile("poem.txt");
    await driver.command("normal! gg");

    // Get original content
    const buffer = await getCurrentBuffer(driver.nvim);

    // Trigger prediction
    await driver.magenta.command("predict-edit");
    await driver.awaitPredictionControllerState("awaiting-agent-reply");

    // Mock response with a replacement
    await driver.mockAnthropic.awaitPendingForceToolUseRequest();
    await driver.mockAnthropic.respondToForceToolUse({
      stopReason: "end_turn",
      toolRequest: {
        status: "ok",
        value: {
          id: "id" as ToolRequestId,
          toolName: "predict_edit" as ToolName,
          input: {
            find: "Moonlight",
            replace: "Starlight",
          },
        },
      },
    });

    // Wait for display state
    await driver.awaitPredictionControllerState("displaying-proposed-edit");

    // Accept the prediction
    await driver.magenta.command("accept-prediction");

    // Wait for prediction to be applied
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify state returned to idle
    expect(controller.state.type).toBe("idle");

    // Verify the edit was applied
    const newLines = await buffer.getLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
    });
    expect(newLines[0]).toContain("Starlight");
    expect(newLines[0]).not.toContain("Moonlight");
  });
});

test("prediction dismissed clears virtual text", async () => {
  await withDriver({}, async (driver) => {
    const controller = driver.magenta.editPredictionController;

    // Open file and position cursor
    await driver.editFile("poem.txt");
    await driver.command("normal! gg");

    // Trigger prediction
    await driver.magenta.command("predict-edit");
    await driver.awaitPredictionControllerState("awaiting-agent-reply");

    // Mock response
    await driver.mockAnthropic.awaitPendingForceToolUseRequest();
    await driver.mockAnthropic.respondToForceToolUse({
      stopReason: "end_turn",
      toolRequest: {
        status: "ok",
        value: {
          id: "id" as ToolRequestId,
          toolName: "predict_edit" as ToolName,
          input: {
            find: "Moonlight",
            replace: "Starlight",
          },
        },
      },
    });

    // Wait for display state
    await driver.awaitPredictionControllerState("displaying-proposed-edit");

    // Dismiss the prediction
    await driver.magenta.command("dismiss-prediction");

    // Wait for dismissal to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify state returned to idle
    expect(controller.state.type).toBe("idle");

    // Verify buffer content unchanged
    const buffer = await getCurrentBuffer(driver.nvim);
    const lines = await buffer.getLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
    });
    expect(lines[0]).toContain("Moonlight");
    expect(lines[0]).not.toContain("Starlight");
  });
});

test("buffer changes auto-dismiss predictions", async () => {
  await withDriver({}, async (driver) => {
    const controller = driver.magenta.editPredictionController;

    // Open file and position cursor
    await driver.editFile("poem.txt");
    await driver.command("normal! gg");

    // Trigger prediction
    await driver.magenta.command("predict-edit");
    await driver.awaitPredictionControllerState("awaiting-agent-reply");

    // Mock response
    await driver.mockAnthropic.awaitPendingForceToolUseRequest();
    await driver.mockAnthropic.respondToForceToolUse({
      stopReason: "end_turn",
      toolRequest: {
        status: "ok",
        value: {
          id: "id" as ToolRequestId,
          toolName: "predict_edit" as ToolName,
          input: {
            find: "Moonlight",
            replace: "Starlight",
          },
        },
      },
    });

    // Wait for display state
    await driver.awaitPredictionControllerState("displaying-proposed-edit");

    // Make a buffer change (this should auto-dismiss the prediction)
    const buffer = await getCurrentBuffer(driver.nvim);
    await driver.command("normal! A edit");
    await driver.command("write");

    // Manually trigger the buffer change event since the test environment
    // might not trigger it automatically
    driver.magenta.onBufferTrackerEvent(
      "write",
      `${driver.magenta.cwd}/poem.txt` as AbsFilePath,
      buffer.id,
    );

    // Wait for buffer change to be processed
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify state returned to idle due to buffer change
    expect(controller.state.type).toBe("idle");
  });
});
