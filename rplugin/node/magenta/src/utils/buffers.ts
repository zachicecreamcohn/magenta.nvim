import { Buffer } from "neovim";
import * as path from "path";
import { Context } from "../types.ts";

export async function getBufferIfOpen({
  context,
  relativePath,
}: {
  context: Context;
  relativePath: string;
}): Promise<
  | { status: "ok"; result: string; buffer: Buffer }
  | { status: "error"; error: string }
  | { status: "not-found" }
> {
  // Get all buffers and nvim's cwd
  const [buffers, cwd] = await Promise.all([
    context.nvim.buffers,
    context.nvim.call("getcwd") as Promise<string>,
  ]);

  // Convert relative path to absolute
  context.logger.trace(`getcwd: ${cwd}`);
  context.logger.trace(`relativePath: ${relativePath}`);
  const absolutePath = path.resolve(cwd, relativePath);

  // Security check: ensure the resolved path is within cwd
  if (!absolutePath.startsWith(cwd)) {
    return { status: "error", error: "The path must be inside of neovim cwd" };
  }

  // Find buffer with matching path
  for (const buffer of buffers) {
    const bufferName = await buffer.name;

    if (bufferName === absolutePath) {
      // Get buffer lines and join them with newlines
      const lines = await buffer.lines;
      return { status: "ok", result: lines.join("\n"), buffer };
    }
  }

  return { status: "not-found" };
}
