import { render } from "./render.js";
import {
  ComponentVDOMNode,
  MountedVDOM,
  MountPoint,
  Position,
  StringVDOMNode,
  VDOMNode,
} from "./view.js";

export async function update({
  currentRoot,
  nextRoot,
  mount,
}: {
  currentRoot: MountedVDOM;
  nextRoot: VDOMNode;
  mount: MountPoint;
}): Promise<MountedVDOM> {
  // keep track of the edits that have happened in the doc so far, so we can apply them to future nodes.
  const accumulatedEdit: {
    deltaRow: number;
    deltaCol: number;
    lastEditRow: number;
  } = {
    deltaRow: 0,
    deltaCol: 0,
    lastEditRow: 0,
  };

  function updatePos(curPos: Position) {
    const pos = { ...curPos };
    if (pos.row == accumulatedEdit.lastEditRow) {
      pos.row += accumulatedEdit.deltaRow;
      pos.col += accumulatedEdit.deltaCol;
    } else {
      pos.row += accumulatedEdit.deltaRow;
    }
    return pos;
  }

  function updateNodePos(node: MountedVDOM): MountedVDOM {
    return {
      ...node,
      startPos: updatePos(node.startPos),
      endPos: updatePos(node.endPos),
    };
  }

  async function replaceNode(
    current: MountedVDOM,
    next: VDOMNode,
  ): Promise<MountedVDOM> {
    // shift the node based on previous edits, so we replace the right range.
    const nextPos = updateNodePos(current);

    // replace the range with the new vdom
    const rendered = await render({
      vdom: next,
      mount: {
        ...mount,
        startPos: nextPos.startPos,
        endPos: nextPos.endPos,
      },
    });

    const oldEndPos = current.endPos;
    const newEndPos = rendered.endPos;

    if (newEndPos.row > oldEndPos.row) {
      accumulatedEdit.deltaRow += newEndPos.row - oldEndPos.row;
      // things on this endRow at pos X are at delta = X - oldEndPos.col
      // they will now be in a new row at newEndPos.col + delta
      //   = X + newEndPos.col - oldEndPos.col
      // so we need to save newEndPos.col - oldEndPos.col
      accumulatedEdit.deltaCol = newEndPos.col - oldEndPos.col;
    } else {
      // this is a single-line edit. We just need to adjust the column
      accumulatedEdit.deltaCol += newEndPos.col - oldEndPos.col;
    }

    accumulatedEdit.lastEditRow = oldEndPos.row;
    return rendered;
  }

  async function visitNode(
    current: MountedVDOM,
    next: VDOMNode,
  ): Promise<MountedVDOM> {
    if (current.type != next.type) {
      return await replaceNode(current, next);
    }

    switch (current.type) {
      case "string":
        if (current.content == (next as StringVDOMNode).content) {
          return updateNodePos(current);
        } else {
          return await replaceNode(current, next);
        }

      case "node": {
        const nextNode = next as ComponentVDOMNode;
        // have to update startPos before processing the children since we assume that positions are always processed
        // in document order!
        const startPos = updatePos(current.startPos);
        const nextChildren = [];
        if (current.template == nextNode.template) {
          if (current.children.length != nextNode.children.length) {
            throw new Error(
              `Expected VDOM components with the same template to have the same number of children.`,
            );
          }

          for (let i = 0; i < current.children.length; i += 1) {
            const currentChild = current.children[i];
            const nextChild = nextNode.children[i];
            nextChildren.push(await visitNode(currentChild, nextChild));
          }

          const nextMountedNode = {
            ...current,
            children: nextChildren,
            startPos,
            endPos: nextChildren[nextChildren.length - 1].endPos,
          };
          return nextMountedNode;
        } else {
          return await replaceNode(current, next);
        }
      }
    }
  }

  return await visitNode(currentRoot, nextRoot);
}
