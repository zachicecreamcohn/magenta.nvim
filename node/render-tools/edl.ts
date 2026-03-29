import type {
  CompletedToolInfo,
  DisplayContext,
  Edl,
  ToolRequest as UnionToolRequest,
} from "@magenta/core";
import { d, type VDOMNode, withCode } from "../tea/view.ts";

type Input = {
  script: string;
};

const PREVIEW_MAX_LINES = 10;
const PREVIEW_MAX_LINE_LENGTH = 80;

function abridgeScript(script: string): string {
  const lines = script.split("\n");
  const preview = lines
    .slice(0, PREVIEW_MAX_LINES)
    .map((line) =>
      line.length > PREVIEW_MAX_LINE_LENGTH
        ? `${line.substring(0, PREVIEW_MAX_LINE_LENGTH)}...`
        : line,
    );
  if (lines.length > PREVIEW_MAX_LINES) {
    preview.push(`... (${lines.length - PREVIEW_MAX_LINES} more lines)`);
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
    return withCode(d`\`\`\`
${input.script}
\`\`\``);
  }
  const abridged = abridgeScript(input.script);
  return withCode(d`\`\`\`
${abridged}
\`\`\``);
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
    return d`edl: ${String(totalMutations)} mutations in ${String(filesCount)} file${filesCount !== 1 ? "s" : ""}${errorSuffix}`;
  }

  return d`edl script`;
}

export function renderResult(
  info: CompletedToolInfo,
  _context: unknown,
  expanded: boolean,
): VDOMNode | undefined {
  if (expanded) {
    return d`${extractFormattedResult(info)}`;
  }

  const data = extractEdlDisplayData(info);
  if (!data || isError(info.result)) return undefined;

  const lines: string[] = [];

  for (const { path, summary } of data.mutations) {
    const parts: string[] = [];
    if (summary.replacements > 0) parts.push(`${summary.replacements} replace`);
    if (summary.insertions > 0) parts.push(`${summary.insertions} insert`);
    if (summary.deletions > 0) parts.push(`${summary.deletions} delete`);
    lines.push(
      `  ${path}: ${parts.join(", ")} (+${summary.linesAdded}/-${summary.linesRemoved})`,
    );
  }

  if (data.finalSelectionCount !== undefined) {
    lines.push(
      `  Final selection: ${data.finalSelectionCount} range${data.finalSelectionCount !== 1 ? "s" : ""}`,
    );
  }

  if (lines.length === 0) return undefined;

  return d`${lines.join("\n")}`;
}
