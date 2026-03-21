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

export function renderInFlightSummary(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
  progress?: BashProgress,
): VDOMNode {
  const input = request.input as Input;
  return progress?.startTime !== undefined
    ? d`⚡⚙️ (${String(Math.floor((Date.now() - progress.startTime) / 1000))}s / 300s) ${withInlineCode(d`\`${input.command}\``)}`
    : d`⚡⏳ ${withInlineCode(d`\`${input.command}\``)}`;
}

export function renderInFlightPreview(
  progress: BashProgress,
  getDisplayWidth: () => number,
): VDOMNode {
  const formattedOutput = formatOutputPreview(
    progress.liveOutput,
    getDisplayWidth,
  );
  return formattedOutput
    ? withCode(
        d`\`\`\`
${formattedOutput}
\`\`\``,
      )
    : d``;
}

export function renderInFlightDetail(
  progress: BashProgress,
  context: RenderContext,
): VDOMNode {
  return renderOutputDetail(progress.liveOutput, undefined, context);
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

export function renderCompletedSummary(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const result = info.result.result;

  if (result.status === "error") {
    return d`⚡❌ ${withInlineCode(d`\`${input.command}\``)} - ${result.error}`;
  }

  let exitCode: number | undefined;
  let signal: string | undefined;

  if (info.resultInfo && info.resultInfo.toolName === "bash_command") {
    const ri = info.resultInfo as BashCommand.ResultInfo;
    exitCode = ri.exitCode;
    signal = ri.signal;
  } else if (result.value.length > 0) {
    const firstValue = result.value[0];
    if (firstValue.type === "text") {
      const exitCodeMatch = firstValue.text.match(/exit code (\d+)/);
      if (exitCodeMatch) {
        exitCode = parseInt(exitCodeMatch[1], 10);
      }
      const signalMatch = firstValue.text.match(/terminated by signal (\w+)/);
      if (signalMatch) {
        signal = signalMatch[1];
      }
    }
  }

  if (signal) {
    return d`⚡❌ ${withInlineCode(d`\`${input.command}\``)} - Terminated by ${signal}`;
  }

  if (exitCode !== undefined && exitCode !== 0) {
    return d`⚡❌ ${withInlineCode(d`\`${input.command}\``)} - Exit code: ${exitCode.toString()}`;
  }

  return d`⚡✅ ${withInlineCode(d`\`${input.command}\``)}`;
}

export function renderCompletedPreview(
  info: CompletedToolInfo,
  context: RenderContext,
): VDOMNode {
  const result = info.result.result;

  if (result.status !== "ok" || result.value.length === 0) {
    return d``;
  }

  const firstValue = result.value[0];
  if (firstValue.type !== "text") {
    return d``;
  }

  let outputText: string;
  let exitCode: number | undefined;
  let logFileView: VDOMNode;

  if (info.resultInfo && info.resultInfo.toolName === "bash_command") {
    const ri = info.resultInfo as BashCommand.ResultInfo;
    outputText = ri.outputText;
    exitCode = ri.exitCode;
    logFileView =
      ri.logFilePath && ri.logFileLineCount !== undefined
        ? renderLogFileLinkDirect(ri.logFilePath, ri.logFileLineCount, context)
        : d``;
  } else {
    const text = firstValue.text;
    outputText = text.replace(/\n?Full output \(\d+ lines\): .+$/m, "");
    const exitCodeMatch = text.match(/exit code (\d+)/);
    exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : undefined;
    logFileView = renderLogFileLink(text, context);
  }

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

function renderLogFileLink(text: string, context: RenderContext): VDOMNode {
  const match = text.match(/Full output \((\d+) lines\): (.+)$/m);
  if (!match) {
    return d``;
  }

  const lineCount = match[1];
  const filePath = match[2];

  return withBindings(
    d`\nFull output (${lineCount} lines): ${withInlineCode(d`\`${filePath}\``)}`,
    {
      "<CR>": () => {
        openFileInNonMagentaWindow(
          filePath as UnresolvedFilePath,
          context,
        ).catch((e: Error) => context.nvim.logger.error(e.message));
      },
    },
  );
}

export function renderCompletedDetail(
  info: CompletedToolInfo,
  context: RenderContext,
): VDOMNode {
  const input = info.request.input as Input;
  const result = info.result.result;

  if (result.status !== "ok" || result.value.length === 0) {
    return d`command: ${withInlineCode(d`\`${input.command}\``)}\n${result.status === "error" ? d`❌ ${result.error}` : d``}`;
  }

  const firstValue = result.value[0];
  if (firstValue.type !== "text") {
    return d`command: ${withInlineCode(d`\`${input.command}\``)}`;
  }

  let outputText: string;
  let logFileView: VDOMNode;

  if (info.resultInfo && info.resultInfo.toolName === "bash_command") {
    const ri = info.resultInfo as BashCommand.ResultInfo;
    outputText = ri.outputText;
    logFileView =
      ri.logFilePath && ri.logFileLineCount !== undefined
        ? renderLogFileLinkDirect(ri.logFilePath, ri.logFileLineCount, context)
        : d``;
  } else {
    outputText = firstValue.text.replace(
      /\n?Full output \(\d+ lines\): .+$/m,
      "",
    );
    logFileView = renderLogFileLink(firstValue.text, context);
  }

  return d`command: ${withInlineCode(d`\`${input.command}\``)}
${withCode(d`\`\`\`
${outputText}
\`\`\``)}${logFileView}`;
}
