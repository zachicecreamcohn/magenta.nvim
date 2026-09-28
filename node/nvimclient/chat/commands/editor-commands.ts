import { getQuickfixList, quickfixListToString } from "../../nvim/nvim.ts";
import type { Nvim } from "../../nvim/nvim-node/index.ts";
import { getDiagnostics } from "../../utils/diagnostics.ts";
import {
  AT_FILE_PATTERN,
  extractFileRefPath,
  formatFileRef,
  type HomeDir,
  type NvimCwd,
  resolveFilePath,
  type UnresolvedFilePath,
} from "../../utils/files.ts";
import { getBuffersList } from "../../utils/listBuffers.ts";

export type EditorCommandContext = {
  nvim: Nvim;
  cwd: NvimCwd;
  homeDir: HomeDir;
};

type EditorCommand = {
  pattern: RegExp;
  label: string;
  expand(context: EditorCommandContext): Promise<string>;
};

const buffers = (context: EditorCommandContext) => getBuffersList(context.nvim);
const quickfix = async ({ nvim }: EditorCommandContext) =>
  quickfixListToString(await getQuickfixList(nvim), nvim);
const diagnostics = ({ nvim, cwd, homeDir }: EditorCommandContext) =>
  getDiagnostics(nvim, cwd, homeDir);

const EDITOR_COMMANDS: EditorCommand[] = [
  { pattern: /@buf\b/, label: "buffers list", expand: buffers },
  { pattern: /@buffers\b/, label: "buffers list", expand: buffers },
  { pattern: /@qf\b/, label: "quickfix list", expand: quickfix },
  { pattern: /@quickfix\b/, label: "quickfix list", expand: quickfix },
  { pattern: /@diag\b/, label: "diagnostics", expand: diagnostics },
  { pattern: /@diagnostics\b/, label: "diagnostics", expand: diagnostics },
];

/** Rewrites every `@file:` ref to an absolute path against Neovim's cwd. */
export function absolutizeFileRefs(
  text: string,
  cwd: NvimCwd,
  homeDir: HomeDir,
): string {
  let result = "";
  let last = 0;
  for (const match of text.matchAll(AT_FILE_PATTERN)) {
    const path = extractFileRefPath(match) as UnresolvedFilePath;
    result += text.slice(last, match.index);
    result += formatFileRef(resolveFilePath(cwd, path, homeDir));
    last = match.index + match[0].length;
  }
  return result + text.slice(last);
}
/** Expands commands that read editor state into text, and makes `@file:`
 * paths absolute against Neovim's cwd, since the server knows neither. The
 * fs/git commands stay in the text for the server to resolve at delivery. */
export async function expandEditorCommands(
  text: string,
  context: EditorCommandContext,
): Promise<string> {
  const withAbsFiles = absolutizeFileRefs(text, context.cwd, context.homeDir);
  const expansions: string[] = [];
  for (const command of EDITOR_COMMANDS) {
    const matches = withAbsFiles.match(new RegExp(command.pattern.source, "g"));
    for (const _ of matches ?? []) {
      try {
        expansions.push(
          `Current ${command.label}:\n${await command.expand(context)}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        context.nvim.logger.error(
          `Failed to fetch ${command.label} for message: ${message}`,
        );
        expansions.push(`Error fetching ${command.label}: ${message}`);
      }
    }
  }
  return [withAbsFiles, ...expansions].join("\n\n");
}
