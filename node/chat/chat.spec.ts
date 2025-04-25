import {
  extractMountTree,
  withNvimClient,
  withDriver,
} from "../test/preamble.ts";
import * as Chat from "./chat.ts";
import { type ToolRequestId } from "../tools/toolManager.ts";
import { createApp } from "../tea/tea.ts";
import { describe, expect, it } from "vitest";
import { pos } from "../tea/view.ts";
import { NvimBuffer, type Line } from "../nvim/buffer.ts";
import type { MessageId } from "./message.ts";
import * as ListDirectory from "../tools/listDirectory.ts";
import * as ListBuffers from "../tools/listBuffers.ts";

describe("tea/chat.spec.ts", () => {
  it("chat render and a few updates", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);
      const chatModel = Chat.init({
        nvim,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
        lsp: undefined as any,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
        options: undefined as any,
      });
      const model = chatModel.initModel({
        name: "claude-3-7",
        provider: "anthropic",
        model: "claude-3-7-latest",
      });

      const app = createApp({
        nvim,
        initialModel: model,
        update: (model, msg) =>
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
          chatModel.update(model, msg, { nvim, options: undefined as any }),
        View: chatModel.view,
        suppressThunks: true,
      });

      const mountedApp = await app.mount({
        nvim,
        buffer,
        startPos: pos(0, 0),
        endPos: pos(-1, -1),
      });

      await mountedApp.waitForRender();

      expect(
        await buffer.getLines({ start: 0, end: -1 }),
        "initial render of chat works",
      ).toEqual(Chat.LOGO.split("\n") as Line[]);

      app.dispatch({
        type: "add-message",
        role: "user",
        content: "Can you look at my list of buffers?",
      });
      await mountedApp.waitForRender();

      app.dispatch({
        type: "stream-response",
        text: "Sure, let me use the list_buffers tool.",
      });
      await mountedApp.waitForRender();

      app.dispatch({
        type: "init-tool-use",
        request: {
          status: "ok",
          value: {
            id: "request-id" as ToolRequestId,
            input: {},
            name: "list_buffers",
          },
        },
      });
      await mountedApp.waitForRender();

      expect(
        await buffer.getLines({ start: 0, end: -1 }),
        "in-progress render is as expected",
      ).toEqual([
        "# user:",
        "Can you look at my list of buffers?",
        "",
        "# assistant:",
        "Sure, let me use the list_buffers tool.",
        "⚙️ Grabbing buffers...",
        "",
        "Stopped (end_turn)",
      ] as Line[]);

      expect(
        await extractMountTree(mountedApp.getMountedNode()),
      ).toMatchSnapshot();

      app.dispatch({
        type: "tool-manager-msg",
        msg: {
          type: "tool-msg",
          id: "request-id" as ToolRequestId,
          msg: {
            type: "list_buffers",
            msg: {
              type: "finish",
              result: {
                status: "ok",
                value: "some buffer content",
              },
            },
          },
        },
      });
      await mountedApp.waitForRender();

      expect(
        await buffer.getLines({ start: 0, end: -1 }),
        "finished render is as expected",
      ).toEqual([
        "# user:",
        "Can you look at my list of buffers?",
        "",
        "# assistant:",
        "Sure, let me use the list_buffers tool.",
        "✅ Finished getting buffers.",
        "",
        "Stopped (end_turn)",
      ] as Line[]);
    });
  });

  it("chat clear", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);
      const chatModel = Chat.init({
        nvim,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
        lsp: undefined as any,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
        options: undefined as any,
      });
      const model = chatModel.initModel({
        name: "claude-3-7",
        provider: "anthropic",
        model: "claude-3-7-latest",
      });

      const app = createApp({
        nvim,
        initialModel: model,
        update: (model, msg) =>
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
          chatModel.update(model, msg, { nvim, options: undefined as any }),
        View: chatModel.view,
        suppressThunks: true,
      });

      const mountedApp = await app.mount({
        nvim,
        buffer,
        startPos: pos(0, 0),
        endPos: pos(-1, -1),
      });

      await mountedApp.waitForRender();

      expect(
        await buffer.getLines({ start: 0, end: -1 }),
        "initial render of chat works",
      ).toEqual(Chat.LOGO.split("\n") as Line[]);

      app.dispatch({
        type: "add-message",
        role: "user",
        content: "Can you look at my list of buffers?",
      });
      await mountedApp.waitForRender();

      app.dispatch({
        type: "stream-response",
        text: "Sure, let me use the list_buffers tool.",
      });
      await mountedApp.waitForRender();

      expect(
        await buffer.getLines({ start: 0, end: -1 }),
        "in-progress render is as expected",
      ).toEqual([
        "# user:",
        "Can you look at my list of buffers?",
        "",
        "# assistant:",
        "Sure, let me use the list_buffers tool.",
        "",
        "Stopped (end_turn)",
      ] as Line[]);

      app.dispatch({
        type: "clear",
        profile: {
          name: "claude-3-7",
          provider: "anthropic",
          model: "claude-3-7-latest",
        },
      });
      await mountedApp.waitForRender();

      expect(
        await buffer.getLines({ start: 0, end: -1 }),
        "finished render is as expected",
      ).toEqual(Chat.LOGO.split("\n") as Line[]);
    });
  });

  it("getMessages correctly interleaves tool requests and responses", async () => {
    await withNvimClient(async (nvim) => {
      const chatModel = Chat.init({
        nvim,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
        lsp: undefined as any,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
        options: undefined as any,
      });
      const model = chatModel.initModel({
        name: "claude-3-7",
        provider: "anthropic",
        model: "claude-3-7-latest",
      });

      model.messages.push({
        id: 1 as MessageId,
        role: "user",
        parts: [{ type: "text", text: "Can you help me with my code?" }],
        edits: {},
      });

      const TOOL1_ID = "tool-1" as ToolRequestId;
      const TOOL2_ID = "tool-2" as ToolRequestId;

      model.messages.push({
        id: 2 as MessageId,
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "I'll help you. Let me check your files first.",
          },
          {
            type: "tool-request",
            requestId: TOOL1_ID,
          },
          { type: "text", text: "Now let me check your buffers too." },
          {
            type: "tool-request",
            requestId: TOOL2_ID,
          },
          { type: "text", text: "Based on these results, I can help you." },
        ],
        edits: {},
      });

      {
        const toolModel = ListDirectory.initModel(
          {
            id: TOOL1_ID,
            name: "list_directory",
            input: {},
          },
          { nvim },
        )[0];
        toolModel.state = {
          state: "done",
          result: {
            type: "tool_result",
            id: TOOL1_ID,
            result: {
              status: "ok",
              value: "list_directory result",
            },
          },
        };

        model.toolManager.toolWrappers[TOOL1_ID] = {
          model: toolModel,
          showRequest: true,
          showResult: true,
        };
      }

      {
        const toolModel = ListBuffers.initModel(
          {
            id: TOOL2_ID,
            name: "list_buffers",
            input: {},
          },
          { nvim },
        )[0];

        toolModel.state = {
          state: "done",
          result: {
            type: "tool_result",
            id: TOOL2_ID,
            result: {
              status: "ok",
              value: "list_buffers result",
            },
          },
        };

        model.toolManager.toolWrappers[TOOL2_ID] = {
          model: toolModel,
          showRequest: true,
          showResult: true,
        };
      }

      const messages = await chatModel.getMessages(model);

      expect(messages).toEqual([
        {
          role: "user",
          content: [{ type: "text", text: "Can you help me with my code?" }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "I'll help you. Let me check your files first.",
            },
            {
              type: "tool_use",
              request: {
                id: "tool-1",
                input: {},
                name: "list_directory",
              },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              id: "tool-1",
              result: {
                status: "ok",
                value: "list_directory result",
              },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Now let me check your buffers too." },
            {
              type: "tool_use",
              request: {
                id: "tool-2",
                input: {},
                name: "list_buffers",
              },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              id: "tool-2",
              result: {
                status: "ok",
                value: "list_buffers result",
              },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Based on these results, I can help you." },
          ],
        },
      ]);
    });
  });

  it("handles errors during streaming response", async () => {
    await withDriver(async (driver) => {
      await driver.showSidebar();

      const userPrompt = "Generate some text for me";
      await driver.inputMagentaText(userPrompt);
      await driver.send();

      const pendingRequest = await driver.mockAnthropic.awaitPendingRequest();

      pendingRequest.onText("I'm generating text for you...");

      await driver.assertDisplayBufferContains(
        "I'm generating text for you...",
      );

      pendingRequest.defer.reject(
        new Error("Connection error during response"),
      );

      await driver.assertDisplayBufferContains(
        "Error Connection error during response",
      );

      // Check that the input buffer is pre-populated with the last user message
      await driver.assertInputBufferContains(userPrompt);
    });
  });
});
