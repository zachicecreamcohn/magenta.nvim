import type { DisplayBufferText } from "@magenta/server";
import { describe, expect, it } from "vitest";
import { MAGENTA_REFLECT_NAMESPACE, NvimBuffer } from "../nvim/buffer.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { withNvimClient } from "../test/preamble.ts";
import { getBinding } from "./bindings.ts";
import { getHighlightPos } from "./highlights.ts";
import {
  d,
  mountView,
  type NodeHighlight,
  pos,
  type VDOMNode,
  withHighlights,
} from "./view.ts";

function hl(id: string, text: string, onR?: () => void): NodeHighlight {
  return {
    id,
    text: text as DisplayBufferText,
    extmarkOptions: { hl_group: "MagentaReflect" },
    fallback: { virt_lines: [[["fallback", "MagentaReflect"]]] },
    ...(onR ? { bindings: { r: onR } } : {}),
  };
}

type Props = { before: string; body: string; highlights: NodeHighlight[] };

async function mount(nvim: Nvim, view: (p: Props) => VDOMNode, props: Props) {
  const buffer = await NvimBuffer.create(false, true, nvim);
  await buffer.setOption("modifiable", false);
  const mounted = await mountView({
    view,
    props,
    mount: { nvim, buffer, startPos: pos(0, 0), endPos: pos(0, 0) },
  });
  return { buffer, mounted };
}

const view = (p: Props) =>
  d`${p.before}\n${withHighlights(d`${p.body}\n`, p.highlights)}tail`;

describe("withHighlights", () => {
  it("places matches (multibyte), fallbacks, and follows edits", async () => {
    await withNvimClient(async (nvim) => {
      const { buffer, mounted } = await mount(nvim, view, {
        before: "top",
        body: "é hello world",
        highlights: [hl("a", "world"), hl("b", "missing")],
      });
      const marks = () => buffer.getExtmarks(MAGENTA_REFLECT_NAMESPACE);
      let ms = await marks();
      expect(ms).toHaveLength(2);
      const a = ms.find((m) => m.options.hl_group === "MagentaReflect")!;
      expect(a.startPos).toEqual({ row: 1, col: 9 });
      expect(a.endPos).toEqual({ row: 1, col: 14 });
      const b = ms.find((m) => m.options.virt_lines)!;
      expect(b.startPos.row).toBe(1);
      const aId = a.id;

      // an earlier node grows: no re-placement, position tracks
      await mounted.render({
        before: "top\nmore",
        body: "é hello world",
        highlights: [hl("a", "world"), hl("b", "missing")],
      });
      ms = await marks();
      expect(ms.map((m) => m.id)).toContain(aId);
      expect(ms.find((m) => m.id === aId)!.startPos).toEqual({
        row: 2,
        col: 9,
      });
      expect(getHighlightPos(mounted._getMountedNode(), "a")).toEqual({
        startPos: { row: 2, col: 9 },
        endPos: { row: 2, col: 14 },
      });

      // changing the node's text re-places the mark
      await mounted.render({
        before: "top\nmore",
        body: "world first",
        highlights: [hl("a", "world")],
      });
      ms = await marks();
      expect(ms).toHaveLength(1);
      expect(ms[0].startPos).toEqual({ row: 2, col: 0 });

      // removing the highlights deletes the marks
      await mounted.render({
        before: "top\nmore",
        body: "world first",
        highlights: [],
      });
      expect(await marks()).toHaveLength(0);
    });
  });

  it("routes normal-mode bindings on a match", async () => {
    await withNvimClient(async (nvim) => {
      let hits = 0;
      const { mounted } = await mount(nvim, view, {
        before: "top",
        body: "hello world",
        highlights: [hl("a", "world", () => hits++)],
      });
      const root = mounted._getMountedNode();
      expect(getBinding(root, pos(1, 7), "n", "r")).toBeDefined();
      expect(getBinding(root, pos(1, 2), "n", "r")).toBeUndefined();
      expect(getBinding(root, pos(1, 7), "v", "r")).toBeUndefined();
      getBinding(root, pos(1, 7), "n", "r")!();
      expect(hits).toBe(1);
    });
  });
  it("keeps fallback highlights' bindings inactive", async () => {
    await withNvimClient(async (nvim) => {
      const { mounted } = await mount(nvim, view, {
        before: "top",
        body: "hello world",
        highlights: [hl("a", "missing", () => {})],
      });
      const root = mounted._getMountedNode();
      expect(getHighlightPos(root, "a")).toEqual({
        startPos: { row: 1, col: 11 },
        endPos: { row: 1, col: 11 },
      });
      for (const col of [10, 11]) {
        expect(getBinding(root, pos(1, col), "n", "r")).toBeUndefined();
      }
    });
  });
  it("tracks a node starting mid-line when its prefix changes", async () => {
    await withNvimClient(async (nvim) => {
      const inline = (p: Props) =>
        d`${p.before}${withHighlights(d`${p.body}`, p.highlights)}\ntail`;
      const { buffer, mounted } = await mount(nvim, inline, {
        before: "ab",
        body: "x world",
        highlights: [hl("a", "world", () => {})],
      });
      await mounted.render({
        before: "abcdef",
        body: "x world",
        highlights: [hl("a", "world", () => {})],
      });
      const root = mounted._getMountedNode();
      expect(getHighlightPos(root, "a")).toEqual({
        startPos: { row: 0, col: 8 },
        endPos: { row: 0, col: 13 },
      });
      const [m] = await buffer.getExtmarks(MAGENTA_REFLECT_NAMESPACE);
      expect(m.startPos).toEqual({ row: 0, col: 8 });
      expect(getBinding(root, pos(0, 9), "n", "r")).toBeDefined();
      expect(getBinding(root, pos(0, 4), "n", "r")).toBeUndefined();
    });
  });
});
