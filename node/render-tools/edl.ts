import {
  type CompletedToolInfo,
  type DisplayContext,
  type Edl,
  splitScriptByFile,
  type ToolRequestId,
  type ToolRequest as UnionToolRequest,
} from "@magenta/core";
import type { Msg as ThreadMsg, ToolViewState } from "../chat/thread.ts";
import type { Dispatch } from "../tea/tea.ts";
import { d, type VDOMNode, withBindings, withCode } from "../tea/view.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";

type Input = {
  script: string;
};

const PREVIEW_MAX_LINES = 10;
const PREVIEW_MAX_LINE_LENGTH = 80;

function abridgeScript(script: string): string {
  const lines = script.split("\n");
  const preview = lines
    .slice(-PREVIEW_MAX_LINES)
    .map((line) =>
      line.length > PREVIEW_MAX_LINE_LENGTH
        ? `${line.substring(0, PREVIEW_MAX_LINE_LENGTH)}...`
        : line,
    );
  if (lines.length > PREVIEW_MAX_LINES) {
    preview.unshift(`... (${lines.length - PREVIEW_MAX_LINES} more lines)`);
  }
  return preview.join("\n");
}

function isError(result: CompletedToolInfo["result"]): boolean {
  return result.result.status === "error";
}

function extractEdlDisplayData(
  info: CompletedToolInfo,
): Edl.EdlDisplayData | undefined {
  if (info.structuredResult.toolName === "edl") {
    return (info.structuredResult as Edl.StructuredResult).displayData;
  }
  return undefined;
}

function extractFormattedResult(info: CompletedToolInfo): string {
  if (info.structuredResult.toolName === "edl") {
    return (info.structuredResult as Edl.StructuredResult).formattedResult;
  }
  if (info.result.result.status !== "ok") {
    return info.result.result.error;
  }
  return "";
}

export function renderSummary(
  _request: UnionToolRequest,
  _displayContext: DisplayContext,
): VDOMNode {
  return d`📝 edl script`;
}

export function renderInput(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
  expanded: boolean,
): VDOMNode | undefined {
  const input = request.input as Input;
  if (expanded) {
    return withCode(d`${input.script}`);
  }
  const abridged = abridgeScript(input.script);
  return withCode(d`${abridged}`);
}

export function renderResultSummary(info: CompletedToolInfo): VDOMNode {
  const data = extractEdlDisplayData(info);

  if (data) {
    const totalMutations = data.mutations.reduce(
      (acc, m) =>
        acc +
        m.summary.replacements +
        m.summary.insertions +
        m.summary.deletions,
      0,
    );
    const filesCount = data.mutations.length;
    const fileErrorCount = data.fileErrorCount;
    const errorSuffix =
      fileErrorCount > 0
        ? ` (${String(fileErrorCount)} file error${fileErrorCount !== 1 ? "s" : ""})`
        : "";
    const totalLinesAdded = data.mutations.reduce(
      (acc, m) => acc + m.summary.linesAdded,
      0,
    );
    const totalLinesRemoved = data.mutations.reduce(
      (acc, m) => acc + m.summary.linesRemoved,
      0,
    );
    return d`edl: ${String(totalMutations)} mutations in ${String(filesCount)} file${filesCount !== 1 ? "s" : ""}, +${String(totalLinesAdded)}/-${String(totalLinesRemoved)} lines${errorSuffix}`;
  }

  return d`edl script`;
}

export function renderResult(
  info: CompletedToolInfo,
  context: {
    threadDispatch: Dispatch<ThreadMsg>;
  },
  toolViewState: ToolViewState,
  toolRequestId: ToolRequestId,
): VDOMNode | undefined {
  const expanded = toolViewState.resultExpanded;

  if (expanded) {
    return withBindings(d`${extractFormattedResult(info)}`, {
      "<CR>": () =>
        context.threadDispatch({
          type: "toggle-tool-result",
          toolRequestId,
        }),
    });
  }

  const data = extractEdlDisplayData(info);
  if (!data || isError(info.result)) return undefined;

  const input = info.request.input as Input;
  const segmentsByPath = new Map<string, string>();
  for (const { path, segment } of splitScriptByFile(input.script)) {
    segmentsByPath.set(
      path,
      segmentsByPath.has(path)
        ? `${segmentsByPath.get(path)!}${segment}`
        : segment,
    );
  }

  const rows: VDOMNode[] = [];

  for (const { path, summary } of data.mutations) {
    const parts: string[] = [];
    if (summary.replacements > 0) parts.push(`${summary.replacements} replace`);
    if (summary.insertions > 0) parts.push(`${summary.insertions} insert`);
    if (summary.deletions > 0) parts.push(`${summary.deletions} delete`);
    const rowText = `  ${path}: ${parts.join(", ")} (+${summary.linesAdded}/-${summary.linesRemoved})`;

    const itemExpanded = toolViewState.resultItemExpanded?.[path] || false;
    const segment = segmentsByPath.get(path);

    const content =
      itemExpanded && segment
        ? d`${rowText}\n${withCode(d`${segment}`)}`
        : d`${rowText}`;

    rows.push(
      withBindings(d`${content}\n`, {
        "<CR>": () =>
          context.threadDispatch({
            type: "open-edit-file",
            filePath: path as UnresolvedFilePath,
          }),
        "=": () =>
          context.threadDispatch({
            type: "toggle-tool-result-item",
            toolRequestId,
            itemKey: path,
          }),
      }),
    );
  }

  if (data.finalSelectionCount !== undefined) {
    rows.push(
      d`  Final selection: ${String(data.finalSelectionCount)} range${data.finalSelectionCount !== 1 ? "s" : ""}\n`,
    );
  }

  if (rows.length === 0) return undefined;

  return d`${rows}`;
}
