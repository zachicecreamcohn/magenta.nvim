import { context } from "../context.ts";
import type { Line } from "../nvim/buffer.ts";
import type { ByteIdx } from "../nvim/window.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { type Bindings } from "./bindings.ts";
import { calculatePosition, replaceBetweenPositions } from "./util.ts";
import { type MountedVDOM, type MountPoint, type VDOMNode } from "./view.ts";

export async function render({
  vdom,
  mount,
}: {
  vdom: VDOMNode;
  mount: MountPoint;
}): Promise<MountedVDOM> {
  type NodePosition =
    | {
        type: "string";
        content: string;
        start: ByteIdx;
        end: ByteIdx;
        bindings?: Bindings | undefined;
      }
    | {
        type: "node";
        template: TemplateStringsArray;
        children: NodePosition[];
        start: ByteIdx;
        end: ByteIdx;
        bindings?: Bindings | undefined;
      }
    | {
        type: "array";
        children: NodePosition[];
        start: ByteIdx;
        end: ByteIdx;
        bindings?: Bindings | undefined;
      };

  // First pass: build the complete string and create tree structure with positions
  const contents: string[] = [];
  let currentByteWidth: ByteIdx = 0 as ByteIdx;

  function traverse(node: VDOMNode): NodePosition {
    context.nvim.logger?.debug(`traversing node ${JSON.stringify(node)}`);
    switch (node.type) {
      case "string": {
        const start = currentByteWidth;
        contents.push(node.content);
        currentByteWidth = (currentByteWidth +
          Buffer.byteLength(node.content, "utf8")) as ByteIdx;

        return {
          type: "string",
          content: node.content,
          start,
          end: currentByteWidth,
          bindings: node.bindings,
        };
      }
      case "node": {
        const start = currentByteWidth;
        const children = node.children.map(traverse);
        return {
          type: "node",
          template: node.template,
          children,
          start,
          end: currentByteWidth,
          bindings: node.bindings,
        };
      }
      case "array": {
        const start = currentByteWidth;
        const children = node.children.map(traverse);
        return {
          type: "array",
          children,
          start,
          end: currentByteWidth,
          bindings: node.bindings,
        };
      }
      default: {
        assertUnreachable(node);
      }
    }
  }

  const positionTree = traverse(vdom);

  const content = contents.join("");
  context.nvim.logger?.debug(`content: "${content}"`);
  await replaceBetweenPositions({
    ...mount,
    lines: content.split("\n") as Line[],
  });

  const mountPos = mount.startPos;
  const contentBuf = Buffer.from(content, "utf-8");
  context.nvim.logger?.debug(`contentBuf: "${contentBuf.toString()}"`);
  function assignPositions(node: NodePosition): MountedVDOM {
    const startPos = calculatePosition(mountPos, contentBuf, node.start);
    const endPos = calculatePosition(mountPos, contentBuf, node.end);

    switch (node.type) {
      case "string":
        return {
          type: "string",
          content: node.content,
          startPos,
          endPos,
          bindings: node.bindings,
        };
      case "node":
        return {
          type: "node",
          template: node.template,
          children: node.children.map(assignPositions),
          startPos,
          endPos,
          bindings: node.bindings,
        };
      case "array":
        return {
          type: "array",
          children: node.children.map(assignPositions),
          startPos,
          endPos,
          bindings: node.bindings,
        };
      default:
        assertUnreachable(node);
    }
  }

  return assignPositions(positionTree);
}
