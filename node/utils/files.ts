import * as path from "node:path";
export type AbsFilePath = string & { __abs_file_path: true };
export type RelFilePath = string & { __rel_file_path: true };
export type UnresolvedFilePath = string & { __unresolved_file_path: true };

export function resolveFilePath(
  cwd: string,
  filePath: UnresolvedFilePath | AbsFilePath | RelFilePath,
) {
  return path.resolve(cwd, filePath) as AbsFilePath;
}

export function relativePath(
  cwd: string,
  filePath: UnresolvedFilePath | AbsFilePath,
) {
  const absPath = resolveFilePath(cwd, filePath);
  return path.relative(cwd, absPath) as RelFilePath;
}
