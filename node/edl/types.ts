/** 1-indexed line, 0-indexed column */
export type Pos = { line: number; col: number };

/** Character offset range, end-exclusive */
export type Range = { start: number; end: number };

export type TraceEntry = {
  command: string;
  ranges: Range[];
  snippet: string;
};

export type FileMutationSummary = {
  insertions: number;
  deletions: number;
  replacements: number;
  linesAdded: number;
  linesRemoved: number;
};

export type ScriptResult = {
  trace: TraceEntry[];
  finalSelection: { ranges: Range[]; snippet: string } | undefined;
  mutations: Map<string, FileMutationSummary>;
};
