import type {
  BashCommand,
  CompletedToolInfo,
  DisplayContext,
  ToolRequest as UnionToolRequest,
} from "@magenta/core";
import type { OutputLine } from "../capabilities/shell.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { MagentaOptions } from "../options.ts";
import {
  d,
  type VDOMNode,
  withBindings,
  withCode,
  withInlineCode,
} from "../tea/view.ts";
import type { HomeDir, NvimCwd, UnresolvedFilePath } from "../utils/files.ts";

type BashProgress = BashCommand.BashProgress;

import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";

type Input = {
  command: string;
};

export type RenderContext = {
  getDisplayWidth: () => number;
  nvim: Nvim;
  cwd: NvimCwd;
  homeDir: HomeDir;
  options: MagentaOptions;
};

export function renderSummary(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
): VDOMNode {
  const input = request.input as Input;
  return d`⚡ ${withInlineCode(d`\`${input.command}\``)}`;
}

export function renderInput(
  _request: UnionToolRequest,
  _displayContext: DisplayContext,
  _expanded: boolean,
): VDOMNode | undefined {
  return undefined;
}

export function renderProgress(
  _request: UnionToolRequest,
  progress: BashProgress,
  context: RenderContext,
  expanded: boolean,
): VDOMNode | undefined {
  if (!expanded) {
    const formattedOutput = formatOutputPreview(
      progress.liveOutput,
      context.getDisplayWidth,
    );
    const timing =
      progress.startTime !== undefined
        ? d`(${String(Math.floor((Date.now() - progress.startTime) / 1000))}s / 300s) `
        : d``;
    return formattedOutput
      ? d`${timing}${withCode(
          d`\`\`\`
${formattedOutput}
\`\`\``,
        )}`
      : undefined;
  }

  return renderOutputDetail(progress.liveOutput, undefined, context);
}

export function renderResultSummary(info: CompletedToolInfo): VDOMNode {
  const result = info.result.result;

  if (result.status === "error") {
    return d`${result.error}`;
  }

  let exitCode: number | undefined;
  let signal: string | undefined;

  if (info.structuredResult.toolName === "bash_command") {
    const sr = info.structuredResult as BashCommand.StructuredResult;
    exitCode = sr.exitCode;
    signal = sr.signal;
  }

  if (signal) {
    return d`Terminated by ${signal}`;
  }

  if (exitCode !== undefined && exitCode !== 0) {
    return d`Exit code: ${exitCode.toString()}`;
  }

  return d``;
}

export function renderResult(
  info: CompletedToolInfo,
  context: RenderContext,
  expanded: boolean,
): VDOMNode | undefined {
  if (!expanded) {
    return renderResultPreview(info, context);
  }
  return renderResultDetail(info, context);
}

function renderResultPreview(
  info: CompletedToolInfo,
  context: RenderContext,
): VDOMNode | undefined {
  const result = info.result.result;

  if (result.status !== "ok" || result.value.length === 0) {
    return undefined;
  }

  const firstValue = result.value[0];
  if (firstValue.type !== "text") {
    return undefined;
  }

  const outputText =
    info.structuredResult.toolName === "bash_command"
      ? (info.structuredResult as BashCommand.StructuredResult).outputText
      : firstValue.text;
  const exitCode =
    info.structuredResult.toolName === "bash_command"
      ? (info.structuredResult as BashCommand.StructuredResult).exitCode
      : undefined;
  const logFileView =
    info.structuredResult.toolName === "bash_command"
      ? (() => {
          const sr = info.structuredResult as BashCommand.StructuredResult;
          return sr.logFilePath && sr.logFileLineCount !== undefined
            ? renderLogFileLinkDirect(
                sr.logFilePath,
                sr.logFileLineCount,
                context,
              )
            : d``;
        })()
      : d``;

  const lines = outputText.split("\n");
  const maxLines = 10;
  const maxLength = context.getDisplayWidth() - 5;

  let previewLines = lines.length > maxLines ? lines.slice(-maxLines) : lines;
  previewLines = previewLines.map((line) =>
    line.length > maxLength ? `${line.substring(0, maxLength)}...` : line,
  );

  const previewText = previewLines.join("\n");

  if (exitCode !== undefined && exitCode !== 0) {
    return d`❌ Exit code: ${exitCode.toString()}
${withCode(d`\`\`\`
${previewText}
\`\`\``)}${logFileView}`;
  }

  return d`${withCode(d`\`\`\`
${previewText}
\`\`\``)}${logFileView}`;
}

function renderResultDetail(
  info: CompletedToolInfo,
  context: RenderContext,
): VDOMNode | undefined {
  const input = info.request.input as Input;
  const result = info.result.result;

  if (result.status !== "ok" || result.value.length === 0) {
    return result.status === "error" ? d`❌ ${result.error}` : undefined;
  }

  const firstValue = result.value[0];
  if (firstValue.type !== "text") {
    return undefined;
  }

  const outputText =
    info.structuredResult.toolName === "bash_command"
      ? (info.structuredResult as BashCommand.StructuredResult).outputText
      : firstValue.text;
  const logFileView =
    info.structuredResult.toolName === "bash_command"
      ? (() => {
          const sr = info.structuredResult as BashCommand.StructuredResult;
          return sr.logFilePath && sr.logFileLineCount !== undefined
            ? renderLogFileLinkDirect(
                sr.logFilePath,
                sr.logFileLineCount,
                context,
              )
            : d``;
        })()
      : d``;

  return d`command: ${withInlineCode(d`\`${input.command}\``)}
${withCode(d`\`\`\`
${outputText}
\`\`\``)}${logFileView}`;
}

function formatOutputPreview(
  output: OutputLine[],
  getDisplayWidth: () => number,
): string {
  let formattedOutput = "";
  let currentStream: "stdout" | "stderr" | null = null;
  const lastTenLines = output.slice(-10);

  for (const line of lastTenLines) {
    if (currentStream !== line.stream) {
      formattedOutput += line.stream === "stdout" ? "stdout:\n" : "stderr:\n";
      currentStream = line.stream;
    }
    const displayWidth = getDisplayWidth() - 5;
    const displayText =
      line.text.length > displayWidth
        ? `${line.text.substring(0, displayWidth)}...`
        : line.text;
    formattedOutput += `${displayText}\n`;
  }

  return formattedOutput;
}

function renderOutputDetail(
  output: OutputLine[],
  logFilePath: string | undefined,
  context: RenderContext,
): VDOMNode {
  let formattedOutput = "";
  let currentStream: "stdout" | "stderr" | null = null;

  for (const line of output) {
    if (currentStream !== line.stream) {
      formattedOutput += line.stream === "stdout" ? "stdout:\n" : "stderr:\n";
      currentStream = line.stream;
    }
    formattedOutput += `${line.text}\n`;
  }

  const logFileView = logFilePath
    ? renderLogFileLinkDirect(logFilePath, output.length, context)
    : d``;

  return d`${withCode(d`\`\`\`
${formattedOutput}
\`\`\``)}${logFileView}`;
}

function renderLogFileLinkDirect(
  logFilePath: string,
  lineCount: number,
  context: RenderContext,
): VDOMNode {
  return withBindings(
    d`\nFull output (${lineCount.toString()} lines): ${withInlineCode(d`\`${logFilePath}\``)}`,
    {
      "<CR>": () => {
        openFileInNonMagentaWindow(
          logFilePath as UnresolvedFilePath,
          context,
        ).catch((e: Error) => context.nvim.logger.error(e.message));
      },
    },
  );
}
