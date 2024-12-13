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

export type VDOMNode = StringVDOMNode | ComponentVDOMNode;

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

export type MountedVDOM = MountedStringNode | MountedComponentNode;

export async function mountView<P>({
  view,
  mount,
  props,
}: {
  view: View<P>;
  mount: MountPoint;
  props: P;
}): Promise<{
  render(props: P): Promise<void>;
  /** for testing
   */
  _getMountedNode(): MountedVDOM;
}> {
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
    _getMountedNode: () => mountedNode,
  };
}

export function d(
  template: TemplateStringsArray,
  ...values: (VDOMNode | string)[]
): VDOMNode {
  const children: VDOMNode[] = [{ type: "string", content: template[0] }];

  for (let i = 0; i < values.length; i++) {
    if (typeof values[i] == "string") {
      children.push({ type: "string", content: values[i] as string });
    } else {
      children.push(values[i] as VDOMNode);
    }
    children.push({ type: "string", content: template[i + 1] });
  }

  return { type: "node", children: children, template: template };
}
