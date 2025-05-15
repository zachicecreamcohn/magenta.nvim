import type { ByteIdx, Position0Indexed, Row0Indexed } from "../nvim/window.ts";
import { render } from "./render.ts";
import { replaceBetweenPositions } from "./util.ts";
import {
  type ArrayVDOMNode,
  type ComponentVDOMNode,
  type MountedVDOM,
  type MountPoint,
  type StringVDOMNode,
  type VDOMNode,
} from "./view.ts";

// a number in the coordinate system of the buffer before the update
type CurrentByteIdx = ByteIdx & { __current: true };
type CurrentRow = Row0Indexed & { __current: true };

type NextByteIdx = ByteIdx & { __next: true };
export type NextRow = Row0Indexed & { __next: true };
export type CurrentPosition = {
  row: CurrentRow;
  col: CurrentByteIdx;
};

export type NextPosition = {
  row: NextRow;
  col: NextByteIdx;
};

type CurrentMountedVDOM = Omit<MountedVDOM, "startPos" | "endPos"> & {
  startPos: CurrentPosition;
  endPos: CurrentPosition;
};

type NextMountedVDOM = Omit<MountedVDOM, "startPos" | "endPos"> & {
  startPos: NextPosition;
  endPos: NextPosition;
};

export type AccumulatedEdit = {
  deltaRow: number;
  deltaCol: number;
  /** In the new file, as we're editing, keep track of the last edit row that the edit has happened on, and how
   * the columns in that row have shifted.
   */
  lastEditRow: NextRow;
};

/** We are traversing the DOM in-order.
 * This function tracks how positions shift as we make edits to the document.
 */
export function updateAccumulatedEdit(
  accumulatedEdit: AccumulatedEdit,
  oldPos: {
    startPos: CurrentPosition;
    endPos: CurrentPosition;
  },
  remappedOldPos: {
    startPos: NextPosition;
    endPos: NextPosition;
  },
  newPos: {
    startPos: NextPosition;
    endPos: NextPosition;
  },
) {
  if (newPos.endPos.row == accumulatedEdit.lastEditRow) {
    // this view post-render is all on the final line, so we just need to adjust the col delta by the view
    // before replacing the node:
    //
    // render so far <old view old view old view> ... <next view>
    //
    // after replacing the node:
    //
    // render so far <updated view> ... <next view>
    // next view's pos used to be at oldPos.endPos + delta, and now it's at newPos.endpos + delta, so we need to adjust it by
    // newPos.endpos - oldPos.endpos, in addition to whatever delta we have for the last line so far
    accumulatedEdit.deltaCol += newPos.endPos.col - remappedOldPos.endPos.col;
  } else {
    // previously rendered state:
    //  <previous node> <current node> ... <next node>
    //
    // before rendering current node
    // <re-rendered previous node> <current node> ... <next node>
    //
    // after re-rendering current node
    // <re-rendered previous node> <re-rendered
    //  current node> ... <next node>
    //
    //  nextNode's remappedStartCol = nextNode.startCol - oldPos.endCol + newPos.endCol
    accumulatedEdit.deltaCol = newPos.endPos.col - oldPos.endPos.col;
  }

  accumulatedEdit.lastEditRow = newPos.endPos.row;
  accumulatedEdit.deltaRow += newPos.endPos.row - remappedOldPos.endPos.row;
}

/** We've partially re-rendered the DOM up to this node, so this node probably shifted
 * around, and we need to figure out where its new position is.
 */
export function remapCurrentToNextPos(
  pos: {
    startPos: CurrentPosition;
    endPos: CurrentPosition;
  },
  accumulatedEdit: AccumulatedEdit,
) {
  const startPos = { ...pos.startPos } as unknown as NextPosition;
  const endPos = { ...pos.endPos } as unknown as NextPosition;

  startPos.row = (startPos.row + accumulatedEdit.deltaRow) as NextRow;
  endPos.row = (endPos.row + accumulatedEdit.deltaRow) as NextRow;

  if (startPos.row == accumulatedEdit.lastEditRow) {
    startPos.col = (startPos.col + accumulatedEdit.deltaCol) as NextByteIdx;
  }

  if (endPos.row == accumulatedEdit.lastEditRow) {
    endPos.col = (endPos.col + accumulatedEdit.deltaCol) as NextByteIdx;
  }

  return {
    startPos,
    endPos,
  };
}

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
    /** In the new file, as we're editing, keep track of the last edit row that the edit has happened on, and how
     * the columns in that row have shifted.
     */
    lastEditRow: NextRow;
  } = {
    deltaRow: 0,
    deltaCol: 0,
    lastEditRow: 0 as NextRow,
  };

  function updateNodePos(node: CurrentMountedVDOM): NextMountedVDOM {
    const nextPos = remapCurrentToNextPos(node, accumulatedEdit);
    return {
      ...node,
      startPos: nextPos.startPos,
      endPos: nextPos.endPos,
    };
  }

  async function replaceNode(
    current: CurrentMountedVDOM,
    next: VDOMNode,
  ): Promise<NextMountedVDOM> {
    // udpate the node pos based on previous edits, to see where the content of this node is now, part-way
    // through the update
    const nextPos = updateNodePos(current);

    const rendered = (await render({
      vdom: next,
      mount: {
        ...mount,
        startPos: nextPos.startPos,
        endPos: nextPos.endPos,
      },
    })) as unknown as NextMountedVDOM;

    updateAccumulatedEdit(accumulatedEdit, current, nextPos, rendered);
    return rendered;
  }

  async function renderNode(
    node: VDOMNode,
    currentPos: CurrentPosition,
    pos: NextPosition,
  ): Promise<NextMountedVDOM> {
    const rendered = (await render({
      vdom: node,
      mount: {
        ...mount,
        startPos: pos,
        endPos: pos,
      },
    })) as unknown as NextMountedVDOM;

    updateAccumulatedEdit(
      accumulatedEdit,
      { startPos: currentPos, endPos: currentPos },
      { startPos: pos, endPos: pos },
      rendered,
    );
    return rendered;
  }

  async function deleteTextBetweenPositions(
    currentPos: {
      startPos: CurrentPosition;
      endPos: CurrentPosition;
    },
    nextPos: {
      startPos: NextPosition;
      endPos: NextPosition;
    },
  ) {
    const compareResult = comparePositions(nextPos.startPos, nextPos.endPos);
    if (compareResult == "gt" || compareResult == "eq") {
      return;
    }

    await replaceBetweenPositions({
      ...mount,
      startPos: nextPos.startPos,
      endPos: nextPos.endPos,
      lines: [],
      context: { nvim: mount.nvim },
    });
    updateAccumulatedEdit(accumulatedEdit, currentPos, nextPos, {
      startPos: nextPos.startPos,
      endPos: nextPos.startPos,
    });
  }

  async function visitNode(
    current: MountedVDOM,
    next: VDOMNode,
  ): Promise<NextMountedVDOM> {
    if (current.type != next.type) {
      return await replaceNode(current as unknown as CurrentMountedVDOM, next);
    }

    switch (current.type) {
      case "string":
        if (current.content == (next as StringVDOMNode).content) {
          const updatedNode = updateNodePos(
            current as unknown as CurrentMountedVDOM,
          );
          updatedNode.bindings = next.bindings;
          return updatedNode;
        } else {
          return await replaceNode(
            current as unknown as CurrentMountedVDOM,
            next,
          );
        }

      case "node": {
        const nextNode = next as ComponentVDOMNode;
        // have to update startPos before processing the children since we assume that positions are always processed
        // in document order!
        const preChildrenPos = remapCurrentToNextPos(
          {
            startPos: current.startPos as CurrentPosition,
            endPos: current.endPos as CurrentPosition,
          },
          accumulatedEdit,
        );
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
            startPos: preChildrenPos.startPos,
            endPos: nextChildren.length
              ? nextChildren[nextChildren.length - 1].endPos
              : // if there were no children, then the preChildrenPos is fine
                preChildrenPos.endPos,
            bindings: next.bindings,
          };
          return nextMountedNode;
        } else {
          return await replaceNode(
            current as unknown as CurrentMountedVDOM,
            next,
          );
        }
      }

      case "array": {
        const nextNode = next as ArrayVDOMNode;
        // have to update startPos before processing the children since we assume that positions are always processed
        // in document order!
        const updatedParentPos = remapCurrentToNextPos(
          {
            startPos: current.startPos as CurrentPosition,
            endPos: current.endPos as CurrentPosition,
          },
          accumulatedEdit,
        );
        const nextChildren = [];
        const numChildrenRetained = Math.min(
          current.children.length,
          nextNode.children.length,
        );
        for (let i = 0; i < numChildrenRetained; i += 1) {
          const currentChild = current.children[i];
          const nextChild = nextNode.children[i];
          nextChildren.push(await visitNode(currentChild, nextChild));
        }

        const lastCurrentChild = current.children[current.children.length - 1];
        let nextChildrenEndPos = nextChildren.length
          ? nextChildren[nextChildren.length - 1].endPos
          : updatedParentPos.startPos;

        if (nextNode.children.length < current.children.length) {
          // remove all the text between the end of the last re-rendered child and where the remaining children shifted during
          // re-rendering
          // before: <child 1> <child 2> <child 3>
          // now: <re-rendered child 1> <re-rendered child 2> <child 3>
          // so we want to delete from the end of re-rendered child 2, to the end of child 3
          const firstUnretainedChild = current.children[numChildrenRetained];
          const remappedFirstUnretainedChildPos = remapCurrentToNextPos(
            {
              startPos: firstUnretainedChild.startPos as CurrentPosition,
              endPos: firstUnretainedChild.endPos as CurrentPosition,
            },
            accumulatedEdit,
          );
          const remappedLastChildPos = remapCurrentToNextPos(
            {
              startPos: lastCurrentChild.startPos as CurrentPosition,
              endPos: lastCurrentChild.endPos as CurrentPosition,
            },
            accumulatedEdit,
          );

          await deleteTextBetweenPositions(
            {
              startPos: firstUnretainedChild.startPos as CurrentPosition,
              endPos: lastCurrentChild.endPos as CurrentPosition,
            },
            {
              startPos: remappedFirstUnretainedChildPos.startPos,
              endPos: remappedLastChildPos.endPos,
            },
          );
        }

        if (nextNode.children.length > current.children.length) {
          // we have more children than we used to, so we need to render them.
          for (
            let childIdx = current.children.length;
            childIdx < nextNode.children.length;
            childIdx += 1
          ) {
            const insertPos: NextPosition = nextChildren.length
              ? nextChildren[nextChildren.length - 1].endPos
              : nextChildrenEndPos;
            nextChildren.push(
              await renderNode(
                nextNode.children[childIdx],
                lastCurrentChild
                  ? (lastCurrentChild.endPos as CurrentPosition)
                  : (current.endPos as CurrentPosition),
                insertPos,
              ),
            );
          }
          nextChildrenEndPos = nextChildren[nextChildren.length - 1].endPos;
        }

        const nextMountedNode = {
          ...current,
          children: nextChildren,
          startPos: updatedParentPos.startPos,
          endPos: nextChildrenEndPos,
          bindings: next.bindings,
        };
        return nextMountedNode;
      }
    }
  }

  return (await visitNode(currentRoot, nextRoot)) as unknown as MountedVDOM;
}

function comparePositions(pos1: Position0Indexed, pos2: Position0Indexed) {
  if (pos1.row > pos2.row) {
    return "gt";
  }

  if (pos1.row < pos2.row) {
    return "lt";
  }

  if (pos1.col > pos2.col) {
    return "gt";
  }

  if (pos1.col < pos2.col) {
    return "lt";
  }

  return "eq";
}
