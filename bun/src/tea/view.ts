import { render } from "./render.ts";
import { update } from "./update.ts";
import { type Bindings } from "./bindings.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { context } from "../context.ts";
import type { NvimBuffer } from "../nvim/buffer.ts";
import { type Position0Indexed } from "../nvim/window.ts";

export function pos(row: number, col: number) {
  return { row, col } as Position0Indexed;
}

export interface MountPoint {
  buffer: NvimBuffer;
  startPos: Position0Indexed;
  endPos: Position0Indexed;
}

export type View<P> = (props: P) => VDOMNode;
export type StringVDOMNode = {
  type: "string";
  content: string;
  bindings?: Bindings | undefined;
};
export type ComponentVDOMNode = {
  type: "node";
  children: VDOMNode[];
  template: TemplateStringsArray;
  bindings?: Bindings;
};
export type ArrayVDOMNode = {
  type: "array";
  children: VDOMNode[];
  bindings?: Bindings;
};

export type VDOMNode = StringVDOMNode | ComponentVDOMNode | ArrayVDOMNode;

export type MountedStringNode = {
  type: "string";
  content: string;
  startPos: Position0Indexed;
  endPos: Position0Indexed;
  bindings?: Bindings | undefined;
};

export type MountedComponentNode = {
  type: "node";
  template: TemplateStringsArray;
  children: MountedVDOM[];
  startPos: Position0Indexed;
  endPos: Position0Indexed;
  bindings?: Bindings | undefined;
};

export type MountedArrayNode = {
  type: "array";
  children: MountedVDOM[];
  startPos: Position0Indexed;
  endPos: Position0Indexed;
  bindings?: Bindings | undefined;
};

export type MountedVDOM =
  | MountedStringNode
  | MountedComponentNode
  | MountedArrayNode;

export function prettyPrintMountedNode(root: MountedVDOM) {
  const stack: { node: MountedVDOM; indent: number }[] = [
    { node: root, indent: 0 },
  ];
  const output: string[] = [];
  while (stack.length) {
    const { node, indent } = stack.pop()!;

    let body = "";
    switch (node.type) {
      case "string":
        body = JSON.stringify(node.content);
        break;
      case "node":
      case "array": {
        for (
          let childIdx = node.children.length - 1;
          childIdx >= 0;
          childIdx--
        ) {
          stack.push({ node: node.children[childIdx], indent: indent + 2 });
        }
        break;
      }
      default:
        assertUnreachable(node);
    }

    const bindings = node.bindings
      ? `{${Object.keys(node.bindings).join(", ")}}`
      : "";

    output.push(
      `${" ".repeat(indent)}${prettyPrintPos(node.startPos)}-${prettyPrintPos(node.endPos)} (${node.type})  ${bindings} ${body}`,
    );
  }

  return output.join("\n");
}

function prettyPrintPos(pos: Position0Indexed) {
  return `[${pos.row}, ${pos.col}]`;
}

export type MountedView<P> = {
  render(props: P): Promise<void>;
  unmount(): void;
  /** for testing */
  _getMountedNode(): MountedVDOM;
};

export async function mountView<P>({
  view,
  mount,
  props,
}: {
  view: View<P>;
  mount: MountPoint;
  props: P;
}): Promise<MountedView<P>> {
  let mountedNode = await render({ vdom: view(props), mount });

  return {
    async render(props) {
      const next = view(props);
      mountedNode = await update({
        currentRoot: mountedNode,
        nextRoot: next,
        mount,
      });
    },
    unmount() {
      // TODO
    },
    _getMountedNode: () => mountedNode,
  };
}

export function d(
  template: TemplateStringsArray,
  ...values: (VDOMNode[] | VDOMNode | string)[]
): VDOMNode {
  const children: VDOMNode[] = [];
  if (template[0].length) {
    children.push({ type: "string", content: template[0] });
  }
  for (let i = 0; i < values.length; i++) {
    if (typeof values[i] == "string") {
      children.push({ type: "string", content: values[i] as string });
    } else if (Array.isArray(values[i])) {
      children.push({ type: "array", children: values[i] as VDOMNode[] });
    } else {
      children.push(values[i] as VDOMNode);
    }
    if (template[i + 1].length > 0) {
      children.push({ type: "string", content: template[i + 1] });
    }
  }

  return { type: "node", children: children, template: template };
}

/** Replace the bindings for this node
 */
export function withBindings(node: VDOMNode, bindings: Bindings) {
  return {
    ...node,
    bindings,
  };
}
