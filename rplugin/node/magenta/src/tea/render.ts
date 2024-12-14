import { Line } from "../chat/part.js";
import { assertUnreachable } from "../utils/assertUnreachable.js";
import { calculatePosition, replaceBetweenPositions } from "./util.js";
import { MountedVDOM, MountPoint, VDOMNode } from "./view.js";

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
      }
    | {
        type: "node";
        template: TemplateStringsArray;
        children: NodePosition[];
        start: number;
        end: number;
      }
    | {
        type: "array";
        children: NodePosition[];
        start: number;
        end: number;
      };

  // First pass: build the complete string and create tree structure with positions
  let content = "";

  function traverse(node: VDOMNode): NodePosition {
    switch (node.type) {
      case "string": {
        const start = content.length;
        content += node.content;
        return {
          type: "string",
          content: node.content,
          start,
          end: content.length,
        };
      }
      case "node": {
        const start = content.length;
        const children = node.children.map(traverse);
        return {
          type: "node",
          template: node.template,
          children,
          start,
          end: content.length,
        };
      }
      case "array": {
        const start = content.length;
        const children = node.children.map(traverse);
        return {
          type: "array",
          children,
          start,
          end: content.length,
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
        };
      case "node":
        return {
          type: "node",
          template: node.template,
          children: node.children.map(assignPositions),
          startPos,
          endPos,
        };
      case "array":
        return {
          type: "array",
          children: node.children.map(assignPositions),
          startPos,
          endPos,
        };
      default:
        assertUnreachable(node);
    }
  }

  return assignPositions(positionTree);
}
