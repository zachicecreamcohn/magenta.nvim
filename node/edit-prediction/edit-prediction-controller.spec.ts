import { test, expect } from "vitest";
import { withDriver } from "../test/preamble";

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
    expect(systemPrompt).toContain("predict the user's next edit");
    expect(systemPrompt).not.toContain("▐"); // Specific content should not be in system prompt

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
