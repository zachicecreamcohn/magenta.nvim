import type { AbsFilePath, Cwd } from "@magenta/server";

export {
  type AbsFilePath,
  AT_FILE_PATTERN,
  type Cwd,
  categorizeFileType,
  type DisplayPath,
  detectFileType,
  displayPath,
  expandTilde,
  extractFileRefPath,
  FILE_SIZE_LIMITS,
  FileCategory,
  type FileCategory as FileCategoryType,
  type FileTypeInfo,
  formatFileRef,
  type HomeDir,
  isLikelyTextFile,
  MAGENTA_TEMP_DIR,
  type RelFilePath,
  relativePath,
  resolveFilePath,
  shortenPath,
  type UnresolvedFilePath,
  unescapeFenceBody,
  validateFileSize,
} from "@magenta/server";

/** Neovim's cwd. Client-only: used to resolve editor-selected paths and shorten displayed paths. Server code uses `Cwd`. */
export type NvimCwd = AbsFilePath & { __nvim_cwd: true };

/** The one place a client path becomes a server `Cwd`: the client picks the directory a thread it creates will
 * operate in. The thread keeps it for life, independent of later Neovim cwd changes.
 */
export function threadCwdFromNvimCwd(cwd: NvimCwd): Cwd {
  return cwd as AbsFilePath as Cwd;
}
