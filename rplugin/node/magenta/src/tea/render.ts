import { Line } from "../chat/part.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { Bindings } from "./bindings.ts";
import {
  calculatePosition,
  replaceBetweenPositions,
  strWidthInBytes,
} from "./util.ts";
import { MountedVDOM, MountPoint, VDOMNode } from "./view.ts";

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
        start: number;
        end: number;
        bindings?: Bindings;
      }
    | {
        type: "node";
        template: TemplateStringsArray;
        children: NodePosition[];
        start: number;
        end: number;
        bindings?: Bindings;
      }
    | {
        type: "array";
        children: NodePosition[];
        start: number;
        end: number;
        bindings?: Bindings;
      };

  // First pass: build the complete string and create tree structure with positions
  let content = "";

  function traverse(node: VDOMNode): NodePosition {
    switch (node.type) {
      case "string": {
        const start = strWidthInBytes(content);
        content += node.content;
        return {
          type: "string",
          content: node.content,
          start,
          end: strWidthInBytes(content),
          bindings: node.bindings,
        };
      }
      case "node": {
        const start = strWidthInBytes(content);
        const children = node.children.map(traverse);
        return {
          type: "node",
          template: node.template,
          children,
          start,
          end: strWidthInBytes(content),
          bindings: node.bindings,
        };
      }
      case "array": {
        const start = strWidthInBytes(content);
        const children = node.children.map(traverse);
        return {
          type: "array",
          children,
          start,
          end: strWidthInBytes(content),
          bindings: node.bindings,
        };
      }
      default: {
        assertUnreachable(node);
      }
    }
  }

  const positionTree = traverse(vdom);

  await replaceBetweenPositions({
    ...mount,
    lines: content.split("\n") as Line[],
  });

  const mountPos = mount.startPos;
  function assignPositions(node: NodePosition): MountedVDOM {
    const startPos = calculatePosition(mountPos, content, node.start);
    const endPos = calculatePosition(mountPos, content, node.end);

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
