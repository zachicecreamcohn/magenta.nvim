import type { ThreadId } from "@magenta/core";
import { expect, it } from "vitest";
import { withDriver } from "./test/preamble.ts";
import { pollUntil } from "./utils/async.ts";

it("thread display and input buffers are listed", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const threadId = driver.magenta.chat.getActiveThread().id;
    const buffers = driver.magenta.bufferManager.getThreadBuffers(threadId)!;
    expect(buffers).toBeDefined();

    const displayListed = await buffers.displayBuffer.getOption("buflisted");
    const inputListed = await buffers.inputBuffer.getOption("buflisted");
    expect(displayListed).toBe(true);
    expect(inputListed).toBe(true);
  });
});

it("setting a thread title renames both buffers", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const thread = driver.magenta.chat.getActiveThread();
    const threadId = thread.id;
    const buffers = driver.magenta.bufferManager.getThreadBuffers(threadId)!;

    thread.core.setTitle("My Cool Title");

    await pollUntil(async () => {
      const displayName = (await driver.nvim.call("nvim_buf_get_name", [
        buffers.displayBuffer.id,
      ])) as string;
      if (!displayName.includes("My Cool Title")) {
        throw new Error(`display name not updated: ${displayName}`);
      }
    });

    const displayName = (await driver.nvim.call("nvim_buf_get_name", [
      buffers.displayBuffer.id,
    ])) as string;
    const inputName = (await driver.nvim.call("nvim_buf_get_name", [
      buffers.inputBuffer.id,
    ])) as string;
    expect(displayName).toContain("My Cool Title");
    expect(inputName).toContain("My Cool Title");
    // input name must still contain the completion-detection substring
    expect(inputName).toContain("Magenta Input");
    // names stay globally unique
    expect(displayName).not.toBe(inputName);
  });
});

it(":bd of a thread display buffer removes the thread", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const threadId = driver.magenta.chat.getActiveThread().id;
    const buffers = driver.magenta.bufferManager.getThreadBuffers(threadId)!;

    await driver.command(`bd! ${buffers.displayBuffer.id}`);

    await pollUntil(() => {
      if (threadId in driver.magenta.chat.threadWrappers) {
        throw new Error("thread still present");
      }
    });
    expect(threadId in driver.magenta.chat.threadWrappers).toBe(false);
    expect(driver.magenta.bufferManager.getThreadBuffers(threadId)).toBe(
      undefined,
    );
  });
});

it(":bd of a thread input buffer removes the thread", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const threadId = driver.magenta.chat.getActiveThread().id;
    const buffers = driver.magenta.bufferManager.getThreadBuffers(threadId)!;

    await driver.command(`bd! ${buffers.inputBuffer.id}`);

    await pollUntil(() => {
      if (threadId in driver.magenta.chat.threadWrappers) {
        throw new Error("thread still present");
      }
    });
    expect(threadId in driver.magenta.chat.threadWrappers).toBe(false);
  });
});

it("wiping an overview buffer does not remove threads and recovers", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const threadId: ThreadId = driver.magenta.chat.getActiveThread().id;
    const overview = driver.magenta.bufferManager.getOverviewBuffers();
    const oldDisplayId = overview.displayBuffer.id;

    await driver.command(`bwipeout! ${overview.displayBuffer.id}`);

    await pollUntil(() => {
      const fresh = driver.magenta.bufferManager.getOverviewBuffers();
      if (fresh.displayBuffer.id === oldDisplayId) {
        throw new Error("overview not recreated yet");
      }
    });

    // the thread is untouched
    expect(threadId in driver.magenta.chat.threadWrappers).toBe(true);

    // overview is re-mountable
    await driver.magenta.bufferManager.ensureOverviewMounted();
  });
});
