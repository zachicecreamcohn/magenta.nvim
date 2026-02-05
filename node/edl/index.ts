import { parse, ParseError } from "./parser.ts";
import { Executor, ExecutionError } from "./executor.ts";
import type { ScriptResult, TraceEntry, FileMutationSummary } from "./types.ts";

export { ParseError, ExecutionError, Executor };
export type { ScriptResult, TraceEntry, FileMutationSummary } from "./types.ts";

export type EdlResultData = {
  trace: { command: string; snippet: string }[];
  mutations: { path: string; summary: FileMutationSummary }[];
  finalSelection: { count: number; snippet: string } | undefined;
};

export type RunScriptResult =
  | { status: "ok"; data: EdlResultData; formatted: string }
  | { status: "error"; error: string };

function formatTrace(trace: TraceEntry[]): string {
  if (trace.length === 0) return "";
  return trace.map((t) => `  ${t.command} → ${t.snippet}`).join("\n");
}

function formatMutations(mutations: Map<string, FileMutationSummary>): string {
  if (mutations.size === 0) return "No files modified.";
  const lines: string[] = [];
  for (const [path, m] of mutations) {
    const parts: string[] = [];
    if (m.replacements > 0) parts.push(`${m.replacements} replacements`);
    if (m.insertions > 0) parts.push(`${m.insertions} insertions`);
    if (m.deletions > 0) parts.push(`${m.deletions} deletions`);
    parts.push(`+${m.linesAdded}/-${m.linesRemoved} lines`);
    lines.push(`  ${path}: ${parts.join(", ")}`);
  }
  return lines.join("\n");
}

function formatResult(result: ScriptResult): string {
  const sections: string[] = [];

  sections.push(`Trace:\n${formatTrace(result.trace)}`);

  sections.push(`Mutations:\n${formatMutations(result.mutations)}`);

  if (result.finalSelection) {
    sections.push(`Final selection:\n  ${result.finalSelection.snippet}`);
  }

  return sections.join("\n\n");
}

export async function runScript(script: string): Promise<RunScriptResult> {
  try {
    const commands = parse(script);
    const executor = new Executor();
    const result = await executor.execute(commands);

    const data: EdlResultData = {
      trace: result.trace.map((t) => ({
        command: t.command,
        snippet: t.snippet,
      })),
      mutations: Array.from(result.mutations.entries()).map(
        ([path, summary]) => ({
          path,
          summary,
        }),
      ),
      finalSelection: result.finalSelection
        ? {
            count: result.finalSelection.ranges.length,
            snippet: result.finalSelection.snippet,
          }
        : undefined,
    };

    return { status: "ok", data, formatted: formatResult(result) };
  } catch (e) {
    if (e instanceof ParseError) {
      return { status: "error", error: `Parse error: ${e.message}` };
    }
    if (e instanceof ExecutionError) {
      const sections: string[] = [`Error: ${e.message}`];
      if (e.trace.length > 0) {
        sections.push(`Trace:\n${formatTrace(e.trace)}`);
      }
      return { status: "error", error: sections.join("\n\n") };
    }
    return {
      status: "error",
      error: `Unexpected error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
