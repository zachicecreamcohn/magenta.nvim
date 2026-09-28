import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { EditorCapabilities } from "./capabilities/editor.ts";
import { NoopLspClient } from "./capabilities/noop-lsp-client.ts";
import { InMemoryFileIO } from "./edl/in-memory-file-io.ts";
import type { ProviderProfile } from "./provider-options.ts";
import { MockAnthropicClient } from "./providers/mock-anthropic-client.ts";
import { DEFAULT_SANDBOX_CONFIG } from "./sandbox-config.ts";
import {
  type ServerHostOptions,
  ServerSessionHost,
} from "./server-session-host.ts";
import { Session } from "./session.ts";
import { pendingMessage } from "./submission/index.ts";
import { MockSandboxManager } from "./test/mock-sandbox-manager.ts";
import {
  awaitNextStream,
  createMockProvider,
  noopLogger,
} from "./test-helpers.ts";
import type { Thread } from "./thread.ts";
import { ABORTED } from "./thread-api.ts";
import type { ToolName, ToolRequestId } from "./tool-types.ts";
import type { Cwd, HomeDir } from "./utils/files.ts";

const profile: ProviderProfile = {
  name: "mock",
  provider: "anthropic",
  model: "claude-3-5-sonnet-20241022",
  fastModel: "claude-3-5-haiku-20241022",
  thinkingModel: "claude-3-5-sonnet-20241022",
};
const options: ServerHostOptions = {
  profiles: [profile],
  activeProfile: "mock",
  sandbox: DEFAULT_SANDBOX_CONFIG,
  autoContext: [],
  hierarchyContextFileNames: [],
  skillsPaths: [],
  agentsPaths: [],
  maxConcurrentSubagents: 3,
  maxConcurrentFastSubagents: 8,
  autoCompactThreshold: 100000,
  autoCompactPrompt: "compact",
  mcpServers: {},
};
const editor: EditorCapabilities = {
  neovimVersion: "999",
  createLspClient: () => new NoopLspClient(),
  luaExecutor: { execute: async () => "" } as never,
};

let dir: string;
let mockClient: MockAnthropicClient;
let session: Session;
let fileIO: InMemoryFileIO;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "server-host-"));
  mockClient = new MockAnthropicClient();
  const provider = createMockProvider(mockClient);
  fileIO = new InMemoryFileIO({ [path.join(dir, "a.txt")]: "hello" });
  session = new Session(
    new ServerSessionHost({
      logger: noopLogger,
      cwd: dir as Cwd,
      homeDir: dir as HomeDir,
      sandbox: new MockSandboxManager(),
      getOptions: () => options,
      getProvider: () => provider,
      resolveSubmission: async (message) => ({
        type: "send",
        prompt: { content: [{ type: "text", text: message }], reminders: [] },
      }),
    }),
  );
});
afterEach(async () => {
  await session.dispose();
  await rm(dir, { recursive: true, force: true });
});

async function createThread(): Promise<Thread> {
  const id = await session.createThread({
    profile,
    threadType: "root",
    fileIO,
  });
  if (id === ABORTED) throw new Error("aborted");
  const record = session.getThread(id);
  if (record?.state !== "initialized") throw new Error("not initialized");
  return record.thread;
}
const toolNames = (thread: Thread) => thread.toolSpecs.map((s) => s.name);

it("runs a thread with no attached editor", async () => {
  const thread = await createThread();
  expect(toolNames(thread)).not.toContain("hover");
  expect(toolNames(thread)).toContain("edl");
  const done = thread.submit({ type: "raw", message: pendingMessage("edit") });
  const stream = await awaitNextStream(mockClient, undefined);
  stream.streamToolUse("edl-1" as ToolRequestId, "edl" as ToolName, {
    script: `file \`${path.join(dir, "a.txt")}\`\nnarrow /hello/\nreplace "bye"`,
  });
  stream.finishResponse("tool_use");
  const next = await awaitNextStream(mockClient, stream);
  next.finishResponse("end_turn");
  await expect(done).resolves.toMatchObject({ type: "completed" });
  expect(await fileIO.readFile(path.join(dir, "a.txt"))).toBe("bye");
});

it("gives editor tools only to threads created while attached", async () => {
  const before = await createThread();
  session.attachEditor(editor);
  const after = await createThread();
  expect(toolNames(before)).not.toContain("hover");
  expect(toolNames(after)).toContain("hover");
});

it("keeps a running submission going when the editor detaches", async () => {
  session.attachEditor(editor);
  const thread = await createThread();
  const done = thread.submit({ type: "raw", message: pendingMessage("hi") });
  const stream = await awaitNextStream(mockClient, undefined);
  session.detachEditor();
  stream.streamText("still here");
  stream.finishResponse("end_turn");
  await expect(done).resolves.toMatchObject({ type: "completed" });
});
