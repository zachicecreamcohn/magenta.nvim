import { Buffer } from "neovim";
import * as path from "path";
import { context } from "../context.ts";

export async function getBufferIfOpen({
  relativePath,
}: {
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

export async function getOrOpenBuffer({
  relativePath,
}: {
  relativePath: string;
}): Promise<
  | { status: "ok"; result: string; buffer: Buffer }
  | { status: "error"; error: string }
> {
  // First try to get the buffer if it's already open
  const existingBuffer = await getBufferIfOpen({ relativePath });

  if (existingBuffer.status === "error") {
    return existingBuffer;
  }

  if (existingBuffer.status === "ok") {
    return existingBuffer;
  }

  const cwd = (await context.nvim.call("getcwd")) as string;
  const absolutePath = path.resolve(cwd, relativePath);

  if (!absolutePath.startsWith(cwd)) {
    return { status: "error", error: "The path must be inside of neovim cwd" };
  }

  try {
    const bufnr = await context.nvim.call('bufadd', [absolutePath]) as number;
    await context.nvim.call('bufload', [bufnr]);

    const existingBuffer = await getBufferIfOpen({ relativePath });
    if (existingBuffer.status == "error" || existingBuffer.status == "ok") {
      return existingBuffer;
    } else {
      return { status: "error", error: "Unable to open file." };
    }
  } catch (error) {
    return {
      status: "error",
      error: `Failed to open buffer: ${(error as Error).message}`,
    };
  }
}
