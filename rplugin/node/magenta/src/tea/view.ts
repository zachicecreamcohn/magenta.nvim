import { Buffer, Neovim } from "neovim";
import { render } from "./render.js";
import { update } from "./update.js";

export type Position = {
  row: number;
  col: number;
};

export interface MountPoint {
  nvim: Neovim;
  buffer: Buffer;
  startPos: Position;
  endPos: Position;
}

export type View<P> = (props: P) => VDOMNode;
export type StringVDOMNode = { type: "string"; content: string };
export type ComponentVDOMNode = {
  type: "node";
  children: VDOMNode[];
  template: TemplateStringsArray;
};
export type ArrayVDOMNode = {
  type: "array";
  children: VDOMNode[];
};

export type VDOMNode = StringVDOMNode | ComponentVDOMNode | ArrayVDOMNode;

export type MountedStringNode = {
  type: "string";
  content: string;
  startPos: Position;
  endPos: Position;
};

export type MountedComponentNode = {
  type: "node";
  template: TemplateStringsArray;
  children: MountedVDOM[];
  startPos: Position;
  endPos: Position;
};

export type MountedArrayNode = {
  type: "array";
  children: MountedVDOM[];
  startPos: Position;
  endPos: Position;
};

export type MountedVDOM =
  | MountedStringNode
  | MountedComponentNode
  | MountedArrayNode;

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
  const children: VDOMNode[] = [{ type: "string", content: template[0] }];

  for (let i = 0; i < values.length; i++) {
    if (typeof values[i] == "string") {
      children.push({ type: "string", content: values[i] as string });
    } else if (Array.isArray(values[i])) {
      children.push({ type: "array", children: values[i] as VDOMNode[] });
    } else {
      children.push(values[i] as VDOMNode);
    }
    children.push({ type: "string", content: template[i + 1] });
  }

  return { type: "node", children: children, template: template };
}
