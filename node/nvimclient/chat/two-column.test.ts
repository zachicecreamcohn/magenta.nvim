import {
  ABORTED,
  type ContentBlockIdx,
  type DisplayBufferText,
  type MessageIdx,
  type ThreadId,
} from "@magenta/server";
import { expect, it } from "vitest";
import type { NvimDriver as Driver } from "../test/driver.ts";
import { withDriver } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";

async function setup(
  driver: Driver,
): Promise<{ source: ThreadId; child: ThreadId }> {
  await driver.showSidebar();
  await driver.inputMagentaText("Why?");
  await driver.send();
  const request = await driver.mockAnthropic.awaitPendingStream();
  request.respond({
    stopReason: "end_turn",
    text: "Because.",
    toolRequests: [],
  });
  await driver.assertDisplayBufferContains("Because.");
  const source = driver.magenta.chat.leftThreadId!;
  const child =
    await driver.magenta.serverInternals.internals.session.reflectThread(
      source,
      {
        messageIdx: 1 as MessageIdx,
        contentIdx: 0 as ContentBlockIdx,
        reflectionText: "Because." as DisplayBufferText,
      },
    );
  if (child === ABORTED) throw new Error("aborted");
  await driver.magenta.selectThreadEffect(child);
  return { source, child };
}

async function rightWindows(driver: Driver) {
  return pollUntil(() => {
    const right = driver.magenta.sidebar.getRightWindows();
    if (!right?.inputWindow) throw new Error("right column not open");
    return { display: right.displayWindow, input: right.inputWindow };
  });
}

async function rightClosed(driver: Driver) {
  await pollUntil(() => {
    if (driver.magenta.sidebar.getRightWindows()) {
      throw new Error("right column still open");
    }
  });
}

async function bufName(driver: Driver, winId: number): Promise<string> {
  const buf = (await driver.nvim.call("nvim_win_get_buf", [winId])) as number;
  return (await driver.nvim.call("nvim_buf_get_name", [buf])) as string;
}

it("opens a second column beside the parent with its own input", async () => {
  await withDriver({}, async (driver) => {
    const { source, child } = await setup(driver);
    const { display, input } = await rightWindows(driver);
    const left = driver.getVisibleState();
    expect(await bufName(driver, left.displayWindow.id)).toContain(
      source.replace(/-/g, ""),
    );
    expect(await bufName(driver, display.id)).toContain(
      child.replace(/-/g, ""),
    );
    const leftWidth = (await driver.nvim.call("nvim_win_get_width", [
      left.displayWindow.id,
    ])) as number;
    const rightWidth = (await driver.nvim.call("nvim_win_get_width", [
      display.id,
    ])) as number;
    expect(Math.abs(leftWidth - rightWidth)).toBeLessThanOrEqual(1);
    const winbar = (await driver.nvim.call("nvim_win_get_option", [
      input.id,
      "winbar",
    ])) as string;
    expect(winbar).toContain("Magenta Input");

    // - in the right input (normal mode) pops one level: closes the column.
    await driver.nvim.call("nvim_set_current_win", [input.id]);
    await driver.nvim.call("nvim_command", ["normal -"]);
    await rightClosed(driver);
    expect(driver.magenta.chat.leftThreadId).toBe(source);
  });
});

it(":q on a right window clears the right pane", async () => {
  await withDriver({}, async (driver) => {
    const { source } = await setup(driver);
    const { display } = await rightWindows(driver);
    await driver.nvim.call("nvim_win_close", [display.id, true]);
    await rightClosed(driver);
    expect(driver.magenta.chat.state).toEqual({
      state: "thread-selected",
      left: source,
      right: undefined,
    });
    expect(
      await driver.nvim.call("nvim_win_is_valid", [
        driver.getVisibleState().displayWindow.id,
      ]),
    ).toBe(true);
  });
});

it(":bd on the reflection closes the column without deleting it", async () => {
  await withDriver({}, async (driver) => {
    const { source, child } = await setup(driver);
    const { display } = await rightWindows(driver);
    const buf = await driver.nvim.call("nvim_win_get_buf", [display.id]);
    await driver.nvim.call("nvim_command", [`bd! ${buf}`]);
    await rightClosed(driver);
    expect(driver.magenta.chat.leftThreadId).toBe(source);
    expect(driver.magenta.chat.session.getThread(child)).toBeDefined();
    await driver.magenta.selectThreadEffect(child);
    const reopened = await rightWindows(driver);
    await pollUntil(async () => {
      const b = await driver.nvim.call("nvim_win_get_buf", [
        reopened.display.id,
      ]);
      const lines = (await driver.nvim.call("nvim_buf_get_lines", [
        b,
        0,
        -1,
        false,
      ])) as string[];
      if (!lines.join("\n").includes("[thread context]")) {
        throw new Error(lines.join("\n"));
      }
    });
  });
});

it("toggle hides both columns and restores the right one", async () => {
  await withDriver({}, async (driver) => {
    await setup(driver);
    await rightWindows(driver);
    await driver.magenta.command("toggle");
    expect(driver.magenta.sidebar.getRightWindows()).toBeUndefined();
    await driver.magenta.command("toggle");
    await rightWindows(driver);
  });
});

it("dd in the reflection overview deletes the reflection", async () => {
  await withDriver({}, async (driver) => {
    const { source, child } = await setup(driver);
    await driver.magenta.showReflectionsOverview(source);
    const display = await pollUntil(() => {
      const right = driver.magenta.sidebar.getRightWindows();
      if (!right || right.inputWindow) throw new Error("overview not shown");
      return right.displayWindow;
    });
    await driver.nvim.call("nvim_win_set_cursor", [display.id, [3, 0]]);
    await driver.nvim.call("nvim_command", ["normal dd"]);
    await pollUntil(() => {
      if (driver.magenta.chat.session.getThread(child)) {
        throw new Error("still exists");
      }
    });
    expect(driver.magenta.chat.session.listDerived(source, "reflect")).toEqual(
      [],
    );
  });
});
it(":bd on the reflections overview closes the right column", async () => {
  await withDriver({}, async (driver) => {
    const { source } = await setup(driver);
    await driver.magenta.showReflectionsOverview(source);
    const display = await pollUntil(() => {
      const right = driver.magenta.sidebar.getRightWindows();
      if (!right || right.inputWindow) throw new Error("overview not shown");
      return right.displayWindow;
    });
    const buf = await driver.nvim.call("nvim_win_get_buf", [display.id]);
    await driver.nvim.call("nvim_command", [`bd! ${buf}`]);
    await rightClosed(driver);
    expect(driver.magenta.chat.state).toEqual({
      state: "thread-selected",
      left: source,
      right: undefined,
    });
    // Re-opening and closing again must not trip over the retired overview.
    await driver.magenta.showReflectionsOverview(source);
    await pollUntil(() => {
      if (!driver.magenta.sidebar.getRightWindows()) throw new Error("closed");
    });
    await driver.magenta.command("threads-navigate-up");
    await rightClosed(driver);
  });
});
it(":bd on the left thread's buffer shows the thread overview", async () => {
  await withDriver({}, async (driver) => {
    const { source } = await setup(driver);
    await rightWindows(driver);
    const buf = await driver.nvim.call("nvim_win_get_buf", [
      driver.getVisibleState().displayWindow.id,
    ]);
    await driver.nvim.call("nvim_command", [`bd! ${buf}`]);
    await pollUntil(() => {
      if (driver.magenta.chat.state.state !== "thread-overview") {
        throw new Error(JSON.stringify(driver.magenta.chat.state));
      }
    });
    await rightClosed(driver);
    expect(driver.magenta.chat.session.getThread(source)).toBeDefined();
  });
});
it("entering right-column windows does not change the panes", async () => {
  await withDriver({}, async (driver) => {
    const { source, child } = await setup(driver);
    const { display, input } = await rightWindows(driver);
    const expected = {
      state: "thread-selected",
      left: source,
      right: { type: "reflection", threadId: child },
    };
    expect(driver.magenta.chat.state).toEqual(expected);
    for (const win of [display, input, display]) {
      await driver.nvim.call("nvim_set_current_win", [win.id]);
      await new Promise((r) => setTimeout(r, 100));
      expect(driver.magenta.chat.state).toEqual(expected);
    }
    await driver.magenta.showReflectionsOverview(source);
    const overview = await pollUntil(() => {
      const right = driver.magenta.sidebar.getRightWindows();
      if (!right || right.inputWindow) throw new Error("overview not shown");
      return right.displayWindow;
    });
    await driver.nvim.call("nvim_set_current_win", [overview.id]);
    await new Promise((r) => setTimeout(r, 100));
    expect(driver.magenta.chat.state).toEqual({
      state: "thread-selected",
      left: source,
      right: { type: "reflections-overview" },
    });
  });
});
it("overview -> thread reuses the display window and opens a sized input", async () => {
  await withDriver({}, async (driver) => {
    const { source, child } = await setup(driver);
    const { display: firstDisplay } = await rightWindows(driver);
    await driver.magenta.showReflectionsOverview(source);
    await pollUntil(() => {
      const right = driver.magenta.sidebar.getRightWindows();
      if (!right || right.inputWindow) throw new Error("overview not shown");
    });
    await driver.magenta.selectThreadEffect(child);
    const { display, input } = await rightWindows(driver);
    expect(display.id).toBe(firstDisplay.id);
    expect(await bufName(driver, display.id)).not.toMatch(/reflections/i);
    const leftInput = driver.getVisibleState().inputWindow.id;
    expect(await driver.nvim.call("nvim_win_get_height", [input.id])).toBe(
      await driver.nvim.call("nvim_win_get_height", [leftInput]),
    );
    const winbar = await driver.nvim.call("nvim_win_get_option", [
      input.id,
      "winbar",
    ]);
    expect(winbar).not.toBe("");
  });
});
