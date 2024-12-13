import { Buffer, Neovim } from "neovim";
import {
  Mark,
  getExtMark,
  setExtMark,
  replaceBetweenMarks,
} from "../utils/extmarks";
import { Line } from "../part";
import { assertUnreachable } from "../utils/assertUnreachable";

export interface MountPoint {
  nvim: Neovim;
  buffer: Buffer;
  namespace: number;
  startMark: Mark;
  endMark: Mark;
}

export type View<P> = (props: P) => VDOMNode;
type StringVDOMNode = { type: "string"; content: string };
type ComponentVDOMNode = {
  type: "node";
  children: VDOMNode[];
  /** used to make diffing more efficient **/
  template: TemplateStringsArray;
};

export type VDOMNode = StringVDOMNode | ComponentVDOMNode;

type MountedVDOM =
  | { type: "string"; content: string; marks: { start: Mark; end: Mark } }
  | {
      type: "node";
      /** used to make diffing more efficient
       */
      template: TemplateStringsArray;
      children: MountedVDOM[];
      marks: { start: Mark; end: Mark };
    };

export async function mountView<P>({
  view,
  mount,
  props,
}: {
  view: View<P>;
  mount: MountPoint;
  props: P;
}): Promise<{ render(props: P): Promise<void> }> {
  let mountedVdom = await render({ vdom: view(props), mount });
  return {
    async render(props) {
      const next = view(props);
      mountedVdom = await update({ current: mountedVdom, next, mount });
    },
  };
}

async function update({
  current,
  next,
  mount,
}: {
  current: MountedVDOM;
  next: VDOMNode;
  mount: MountPoint;
}): Promise<MountedVDOM> {
  if (current.type == next.type) {
    switch (current.type) {
      case "string":
        if (current.content == (next as StringVDOMNode).content) {
          // nothing todo
          return current;
        } else {
          // TODO maybe another optimization here would be to append the string instead of replacing if the
          // current string starts with the same thing as the next string.
          return render({ mount, vdom: next });
        }

      case "node": {
        const nextNode = next as ComponentVDOMNode;
        if (current.template == nextNode.template) {
          if (current.children.length != nextNode.children.length) {
            throw new Error(
              `Expected VDOM components with the same template to have the same number of children.`,
            );
          }

          const nextChildren = [];
          for (let i = 0; i < current.template.length; i += 1) {
            const currentChild = current.children[i];
            const nextChild = nextNode.children[i];
            nextChildren.push(
              await update({
                current: currentChild,
                next: nextChild,
                mount: {
                  ...mount,
                  startMark: currentChild.marks.start,
                  endMark: currentChild.marks.end,
                },
              }),
            );
          }

          return {
            ...current,
            children: nextChildren,
          };
        } else {
          return render({ mount, vdom: next });
        }
      }

      default:
        assertUnreachable(current);
    }
  } else {
    // replace the node.
    return render({ mount, vdom: next });
  }
}

async function render({
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
      };

  // First pass: build the complete string and create tree structure with positions
  let content = "";

  function traverse(node: VDOMNode): NodePosition {
    if (node.type === "string") {
      const start = content.length;
      content += node.content;
      return {
        type: "string",
        content: node.content,
        start,
        end: content.length,
      };
    } else {
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
  }

  const positionTree = traverse(vdom);

  const startPos = await getExtMark({
    nvim: mount.nvim,
    buffer: mount.buffer,
    namespace: mount.namespace,
    markId: mount.startMark,
  });

  await replaceBetweenMarks({
    ...mount,
    lines: content.split("\n") as Line[],
  });

  // Second pass: create marks for each node, maintaining tree structure
  async function createMarks(node: NodePosition): Promise<MountedVDOM> {
    const startPosition = calculatePosition(startPos, content, node.start);
    const endPosition = calculatePosition(startPos, content, node.end);

    const startMark = await setExtMark({
      nvim: mount.nvim,
      buffer: mount.buffer,
      namespace: mount.namespace,
      row: startPosition[0],
      col: startPosition[1],
    });

    const endMark = await setExtMark({
      nvim: mount.nvim,
      buffer: mount.buffer,
      namespace: mount.namespace,
      row: endPosition[0],
      col: endPosition[1],
    });

    if (node.type === "string") {
      return {
        type: "string",
        content: node.content,
        marks: { start: startMark, end: endMark },
      };
    } else {
      const children = await Promise.all(node.children.map(createMarks));
      return {
        type: "node",
        template: node.template,
        children,
        marks: { start: startMark, end: endMark },
      };
    }
  }

  return createMarks(positionTree);
}

export function d(
  template: TemplateStringsArray,
  ...values: VDOMNode[]
): VDOMNode {
  const children: VDOMNode[] = [{ type: "string", content: template[0] }];

  for (let i = 0; i < values.length; i++) {
    children.push(values[i]);
    children.push({ type: "string", content: template[i + 1] });
  }

  return { type: "node", children: children, template: template };
}

const calculatePosition = (
  startMark: [number, number],
  text: string,
  index: number,
): [number, number] => {
  let [row, col] = startMark;
  let currentIndex = 0;

  while (currentIndex < index) {
    if (text[currentIndex] === "\n") {
      row++;
      col = 0;
    } else {
      col++;
    }
    currentIndex++;
  }

  return [row, col];
};
