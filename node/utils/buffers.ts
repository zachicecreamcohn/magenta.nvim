import { NvimBuffer } from "../nvim/buffer.ts";
import { getAllBuffers, getcwd } from "../nvim/nvim.ts";
import type { Nvim } from "../nvim/nvim-node";
import {
  resolveFilePath,
  type AbsFilePath,
  type RelFilePath,
  type UnresolvedFilePath,
} from "./files.ts";

export async function getBufferIfOpen({
  unresolvedPath,
  context,
}: {
  unresolvedPath: UnresolvedFilePath | AbsFilePath | RelFilePath;
  context: { nvim: Nvim };
}): Promise<
  | { status: "ok"; buffer: NvimBuffer }
  | { status: "error"; error: string }
  | { status: "not-found" }
> {
  // Get all buffers and nvim's cwd
  const [buffers, cwd] = await Promise.all([
    getAllBuffers(context.nvim),
    getcwd(context.nvim),
  ]);

  const absolutePath = resolveFilePath(cwd, unresolvedPath);

  // Security check: ensure the resolved path is within cwd
  if (!absolutePath.startsWith(cwd)) {
    return {
      status: "error",
      error: `The path ${absolutePath} must be inside of neovim cwd ${cwd}`,
    };
  }

  // Find buffer with matching path
  for (const buffer of buffers) {
    const bufferName = await buffer.getName();

    if (resolveFilePath(cwd, bufferName) === absolutePath) {
      return { status: "ok", buffer };
    }
  }

  return { status: "not-found" };
}

export async function getOrOpenBuffer({
  unresolvedPath,
  context,
}: {
  unresolvedPath: UnresolvedFilePath;
  context: { nvim: Nvim };
}): Promise<
  { status: "ok"; buffer: NvimBuffer } | { status: "error"; error: string }
> {
  // First try to get the buffer if it's already open
  const existingBuffer = await getBufferIfOpen({
    unresolvedPath,
    context,
  });

  if (existingBuffer.status === "error") {
    return existingBuffer;
  }

  if (existingBuffer.status === "ok") {
    return existingBuffer;
  }

  const cwd = await getcwd(context.nvim);
  const absolutePath = resolveFilePath(cwd, unresolvedPath);

  if (!absolutePath.startsWith(cwd)) {
    return {
      status: "error",
      error: `The path ${absolutePath} must be inside of neovim cwd ${cwd}`,
    };
  }

  try {
    await NvimBuffer.bufadd(absolutePath, context.nvim);

    const existingBuffer = await getBufferIfOpen({
      unresolvedPath,
      context,
    });
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
