import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ThreadId, ThreadType } from "./chat-types.ts";
import { MAGENTA_TEMP_DIR, threadMetaPath } from "./utils/files.ts";

const UUIDV7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function threadsDir(baseDir: string): string {
  return path.join(baseDir, "threads");
}

/**
 * Decode the creation time of a uuidv7 thread id. The first 48 bits of a
 * uuidv7 encode the milliseconds-since-epoch creation time, so this needs no
 * file I/O.
 */
export function threadCreatedAt(threadId: ThreadId): Date {
  const hex = threadId.replace(/-/g, "").slice(0, 12);
  return new Date(parseInt(hex, 16));
}

/**
 * List archived thread ids, newest-first. Only reads the directory listing
 * (never file contents): names that parse as uuidv7 are kept and sorted
 * descending, which — because uuidv7 is time-ordered — yields most-recent
 * first.
 */
export async function listArchivedThreadIds(
  baseDir: string = MAGENTA_TEMP_DIR,
): Promise<ThreadId[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(threadsDir(baseDir));
  } catch {
    return [];
  }
  return entries
    .filter((name) => UUIDV7_PATTERN.test(name))
    .sort()
    .reverse() as ThreadId[];
}

/**
 * Read a thread's `meta.json` sidecar. Best-effort: a missing or malformed
 * sidecar resolves to `{}` rather than throwing.
 */
export async function readThreadMeta(
  threadId: ThreadId,
  baseDir: string = MAGENTA_TEMP_DIR,
): Promise<{ title?: string; threadType?: ThreadType }> {
  try {
    const contents = await fs.readFile(
      threadMetaPath(threadId, baseDir),
      "utf8",
    );
    const parsed = JSON.parse(contents) as {
      title?: string;
      threadType?: ThreadType;
    };
    const result: { title?: string; threadType?: ThreadType } = {};
    if (parsed.title !== undefined) result.title = parsed.title;
    if (parsed.threadType !== undefined) result.threadType = parsed.threadType;
    return result;
  } catch {
    return {};
  }
}

/**
 * Delete a single thread's archive directory (recursively).
 */
export async function deleteArchivedThread(
  threadId: ThreadId,
  baseDir: string = MAGENTA_TEMP_DIR,
): Promise<void> {
  await fs.rm(path.join(threadsDir(baseDir), threadId), {
    recursive: true,
    force: true,
  });
}
