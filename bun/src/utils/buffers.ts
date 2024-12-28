import { NvimBuffer } from "../nvim/buffer.ts";
import * as path from "path";
import { getAllBuffers, getcwd } from "../nvim/nvim.ts";
import type { Nvim } from "bunvim";

export async function getBufferIfOpen({
  relativePath,
  context,
}: {
  relativePath: string;
  context: { nvim: Nvim };
}): Promise<
  | { status: "ok"; result: string; buffer: NvimBuffer }
  | { status: "error"; error: string }
  | { status: "not-found" }
> {
  // Get all buffers and nvim's cwd
  const [buffers, cwd] = await Promise.all([
    getAllBuffers(context.nvim),
    getcwd(context.nvim),
  ]);

  // Convert relative path to absolute
  context.nvim.logger?.debug(`getcwd: ${cwd}`);
  context.nvim.logger?.debug(`relativePath: ${relativePath}`);
  const absolutePath = path.resolve(cwd, relativePath);

  // Security check: ensure the resolved path is within cwd
  if (!absolutePath.startsWith(cwd)) {
    return { status: "error", error: "The path must be inside of neovim cwd" };
  }

  // Find buffer with matching path
  for (const buffer of buffers) {
    const bufferName = await buffer.getName();

    if (bufferName === absolutePath) {
      // Get buffer lines and join them with newlines
      const lines = await buffer.getLines({ start: 0, end: -1 });
      return { status: "ok", result: lines.join("\n"), buffer };
    }
  }

  return { status: "not-found" };
}

export async function getOrOpenBuffer({
  relativePath,
  context,
}: {
  relativePath: string;
  context: { nvim: Nvim };
}): Promise<
  | { status: "ok"; result: string; buffer: NvimBuffer }
  | { status: "error"; error: string }
> {
  // First try to get the buffer if it's already open
  const existingBuffer = await getBufferIfOpen({ relativePath, context });

  if (existingBuffer.status === "error") {
    return existingBuffer;
  }

  if (existingBuffer.status === "ok") {
    return existingBuffer;
  }

  const cwd = await getcwd(context.nvim);
  const absolutePath = path.resolve(cwd, relativePath);

  if (!absolutePath.startsWith(cwd)) {
    return { status: "error", error: "The path must be inside of neovim cwd" };
  }

  try {
    await NvimBuffer.bufadd(absolutePath, context.nvim);

    const existingBuffer = await getBufferIfOpen({ relativePath, context });
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
