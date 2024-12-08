import { Neovim } from "neovim";
import * as path from 'path';

export async function getBufferIfOpen({
  nvim, path: relativePath
}: {
  nvim: Neovim;
  path: string
}): Promise<{ status: 'ok', result: string } | { status: 'error', error: string } | { status: 'not-found' }> {
  // Get all buffers and nvim's cwd
  const [buffers, cwd] = await Promise.all([
    nvim.buffers,
    nvim.call('getcwd') as Promise<string>
  ]);

  // Convert relative path to absolute
  const absolutePath = path.resolve(cwd, relativePath);

  // Security check: ensure the resolved path is within cwd
  if (!absolutePath.startsWith(cwd)) {
    return { status: 'error', error: 'The path must be inside of neovim cwd' };
  }

  // Find buffer with matching path
  for (const buffer of buffers) {
    const bufferName = await buffer.name;

    if (bufferName === absolutePath) {
      // Get buffer lines and join them with newlines
      const lines = await buffer.lines;
      return { status: 'ok', result: lines.join('\n') };
    }
  }

  return { status: 'not-found' };
}
