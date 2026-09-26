import type { ThreadId, ThreadOrigin } from "@magenta/server";
import { describe, expect, it } from "vitest";
import {
  paneTransition,
  reflectNavigateUp,
  type SidebarState,
  selectThreadPanes,
} from "./chat.ts";

const id = (s: string) => s as ThreadId;
const root = id("root");
const r1 = id("r1");
const r2 = id("r2");
const r3 = id("r3");

const origins: Record<string, ThreadOrigin> = {
  r1: reflect(root),
  r2: reflect(r1),
  r3: reflect(r2),
};
function reflect(source: ThreadId): ThreadOrigin {
  return {
    type: "reflect",
    sourceThreadId: source,
    anchor: {} as never,
  };
}
const getOrigin = (t: ThreadId) => origins[t];

const sel = (left: ThreadId, right?: ThreadId): SidebarState => ({
  state: "thread-selected",
  left,
  ...(right ? { right: { type: "reflection", threadId: right } } : {}),
});

describe("pane transitions", () => {
  it("reflecting from the left opens the child on the right", () => {
    expect(
      paneTransition(sel(root), {
        type: "reflect-created",
        parent: root,
        child: r1,
      }),
    ).toEqual(sel(root, r1));
  });

  it("reflecting from the right descends", () => {
    expect(
      paneTransition(sel(root, r1), {
        type: "reflect-created",
        parent: r1,
        child: r2,
      }),
    ).toEqual(sel(r1, r2));
  });

  it("the overview from the right pane's thread descends", () => {
    expect(
      paneTransition(sel(root, r1), {
        type: "show-reflections-overview",
        thread: r1,
      }),
    ).toEqual({
      state: "thread-selected",
      left: r1,
      right: { type: "reflections-overview" },
    });
  });

  it("- pops one level at a time, down from depth 3", () => {
    let state: SidebarState | undefined = sel(r2, r3);
    state = reflectNavigateUp(state, getOrigin);
    expect(state).toEqual(sel(r1, r2));
    state = reflectNavigateUp(state!, getOrigin);
    expect(state).toEqual(sel(root, r1));
    state = reflectNavigateUp(state!, getOrigin);
    expect(state).toEqual(sel(root));
    expect(reflectNavigateUp(state!, getOrigin)).toBeUndefined();
  });

  it("- closes the overview", () => {
    expect(
      reflectNavigateUp(
        {
          state: "thread-selected",
          left: r1,
          right: { type: "reflections-overview" },
        },
        getOrigin,
      ),
    ).toEqual(sel(r1));
  });

  it("selecting a reflect thread opens it beside its parent", () => {
    expect(selectThreadPanes(r2, getOrigin)).toEqual(sel(r1, r2));
    expect(selectThreadPanes(root, getOrigin)).toEqual(sel(root));
  });

  it("closing the right pane keeps the left", () => {
    expect(paneTransition(sel(root, r1), { type: "close-right-pane" })).toEqual(
      sel(root),
    );
  });
});
