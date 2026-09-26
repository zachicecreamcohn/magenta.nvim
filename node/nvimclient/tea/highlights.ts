import type { DisplayBufferText } from "@magenta/server";
import { MAGENTA_REFLECT_NAMESPACE } from "../nvim/buffer.ts";
import type { ByteIdx, Position0Indexed } from "../nvim/window.ts";
import { calculatePosition } from "./util.ts";
import type {
  HighlightSignature,
  HighlightState,
  MountedVDOM,
  MountPoint,
  NodeHighlight,
  PlacedHighlight,
  RelativePos,
} from "./view.ts";

/** Byte offsets of the first occurrence of `needle` within `haystack`. */
export function findInDisplayBufferText(
  haystack: DisplayBufferText,
  needle: DisplayBufferText,
): { start: ByteIdx; end: ByteIdx } | undefined {
  if (!needle.length) return undefined;
  const idx = haystack.indexOf(needle);
  if (idx === -1) return undefined;
  const start = Buffer.byteLength(haystack.slice(0, idx), "utf8") as ByteIdx;
  return {
    start,
    end: (start + Buffer.byteLength(needle, "utf8")) as ByteIdx,
  };
}

/** The node's text as it appears in the display buffer. */
function mountedText(node: MountedVDOM): DisplayBufferText {
  const parts: string[] = [];
  const walk = (n: MountedVDOM) => {
    if (n.type === "string") parts.push(n.content);
    else for (const c of n.children) walk(c);
  };
  walk(node);
  return parts.join("") as DisplayBufferText;
}

function signatureOf(
  text: string,
  highlights: NodeHighlight[] | undefined,
): HighlightSignature {
  return JSON.stringify([
    text,
    (highlights ?? []).map((h) => [h.id, h.text, h.extmarkOptions, h.fallback]),
  ]) as HighlightSignature;
}

function toRelative(
  origin: Position0Indexed,
  pos: Position0Indexed,
): RelativePos {
  return pos.row === origin.row
    ? { rowDelta: 0, col: (pos.col - origin.col) as ByteIdx }
    : { rowDelta: pos.row - origin.row, col: pos.col };
}

function toAbsolute(
  origin: Position0Indexed,
  rel: RelativePos,
): Position0Indexed {
  return rel.rowDelta === 0
    ? { row: origin.row, col: (origin.col + rel.col) as ByteIdx }
    : {
        row: (origin.row + rel.rowDelta) as Position0Indexed["row"],
        col: rel.col,
      };
}

export async function clearHighlights(
  node: MountedVDOM,
  mount: MountPoint,
): Promise<void> {
  if (!node.highlightState) return;
  for (const placed of node.highlightState.placed.values()) {
    await mount.buffer.deleteExtmark(
      placed.extmarkId,
      MAGENTA_REFLECT_NAMESPACE,
    );
  }
  delete node.highlightState;
}

/** Places extmarks for every node's highlights. A node's marks are only
 * re-placed when its rendered text or its highlights changed; otherwise
 * neovim keeps them attached to the text. */
export async function syncHighlights(
  node: MountedVDOM,
  mount: MountPoint,
): Promise<void> {
  if (node.highlights?.length || node.highlightState) {
    const text = mountedText(node);
    const signature = signatureOf(text, node.highlights);
    if (node.highlightState?.signature !== signature) {
      await clearHighlights(node, mount);
      if (node.highlights?.length) {
        node.highlightState = await placeHighlights(
          node,
          text,
          node.highlights,
          signature,
          mount,
        );
      }
    }
  }
  if (node.type !== "string") {
    for (const child of node.children) await syncHighlights(child, mount);
  }
}

async function placeHighlights(
  node: MountedVDOM,
  text: DisplayBufferText,
  highlights: NodeHighlight[],
  signature: HighlightSignature,
  mount: MountPoint,
): Promise<HighlightState> {
  const buf = Buffer.from(text, "utf8");
  const placed = new Map<string, PlacedHighlight>();
  for (const h of highlights) {
    const match = findInDisplayBufferText(text, h.text);
    let startPos: Position0Indexed;
    let endPos: Position0Indexed;
    if (match) {
      startPos = calculatePosition(node.startPos, buf, match.start);
      endPos = calculatePosition(node.startPos, buf, match.end);
    } else {
      // anchor on the node's last character so virt_lines land below it
      // rather than below the following line
      const last = Math.max(
        0,
        buf.length - (buf[buf.length - 1] === 10 ? 1 : 0),
      ) as ByteIdx;
      startPos = calculatePosition(node.startPos, buf, last);
      endPos = startPos;
    }
    const extmarkId = await mount.buffer.setExtmark({
      startPos,
      endPos,
      options: match ? h.extmarkOptions : h.fallback,
      namespace: MAGENTA_REFLECT_NAMESPACE,
    });
    placed.set(
      h.id,
      match
        ? {
            type: "matched",
            spec: h,
            extmarkId,
            start: toRelative(node.startPos, startPos),
            end: toRelative(node.startPos, endPos),
          }
        : {
            type: "fallback",
            spec: h,
            extmarkId,
            anchor: toRelative(node.startPos, startPos),
          },
    );
  }
  return { signature, placed };
}

export function placedPos(
  node: MountedVDOM,
  placed: PlacedHighlight,
): { startPos: Position0Indexed; endPos: Position0Indexed } {
  if (placed.type === "fallback") {
    const anchor = toAbsolute(node.startPos, placed.anchor);
    return { startPos: anchor, endPos: anchor };
  }
  return {
    startPos: toAbsolute(node.startPos, placed.start),
    endPos: toAbsolute(node.startPos, placed.end),
  };
}

export function getHighlightPos(
  root: MountedVDOM,
  id: string,
): { startPos: Position0Indexed; endPos: Position0Indexed } | undefined {
  const placed = root.highlightState?.placed.get(id);
  if (placed) return placedPos(root, placed);
  if (root.type === "string") return undefined;
  for (const child of root.children) {
    const found = getHighlightPos(child, id);
    if (found) return found;
  }
  return undefined;
}
