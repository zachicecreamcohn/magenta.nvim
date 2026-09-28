import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUI } from "./auth-ui.ts";
import type { ClientCapabilities } from "./capabilities/client.ts";
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
import type { AbsFilePath, Cwd, HomeDir } from "./utils/files.ts";

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
  customCommands: [{ name: "@hi", text: "custom text" }],
};
const editor: ClientCapabilities = {
  neovimVersion: "999",
  createLspClient: () => new NoopLspClient(),
  luaExecutor: { execute: async () => "" } as never,
};

let dir: string;
let mockClient: MockAnthropicClient;
let session: Session;
let host: ServerSessionHost;
let fileIO: InMemoryFileIO;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "server-host-"));
  mockClient = new MockAnthropicClient();
  const provider = createMockProvider(mockClient);
  fileIO = new InMemoryFileIO({ [path.join(dir, "a.txt")]: "hello" });
  host = new ServerSessionHost({
    logger: noopLogger,
    cwd: dir as Cwd,
    homeDir: dir as HomeDir,
    sandbox: new MockSandboxManager(),
    getOptions: () => options,
    getAuthUI: () => undefined,
    getProvider: () => provider,
  });
  session = new Session(host);
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
  session.attachClient(editor);
  const after = await createThread();
  expect(toolNames(before)).not.toContain("hover");
  expect(toolNames(after)).toContain("hover");
});

it("keeps a running submission going when the editor detaches", async () => {
  session.attachClient(editor);
  const thread = await createThread();
  const done = thread.submit({ type: "raw", message: pendingMessage("hi") });
  const stream = await awaitNextStream(mockClient, undefined);
  session.detachClient();
  stream.streamText("still here");
  stream.finishResponse("end_turn");
  await expect(done).resolves.toMatchObject({ type: "completed" });
});

it("wires editor capabilities into threads with the thread's cwd", async () => {
  const threadCwd = path.join(dir, "sub");
  await mkdir(threadCwd);
  const file = path.join(threadCwd, "b.txt");
  await writeFile(file, "hello");
  const onFileWritten = vi.fn(async (_: AbsFilePath) => {});
  const createLspClient = vi.fn(() => new NoopLspClient());
  const spyEditor: ClientCapabilities = {
    ...editor,
    createLspClient,
    onFileWritten,
  };

  const create = async () => {
    const id = await session.createThread({
      profile,
      threadType: "root",
      environmentConfig: { type: "local", cwd: threadCwd as Cwd },
    });
    if (id === ABORTED) throw new Error("aborted");
    const record = session.getThread(id);
    if (record?.state !== "initialized") throw new Error("not initialized");
    return { id, thread: record.thread };
  };
  let last: Awaited<ReturnType<typeof awaitNextStream>> | undefined;
  const runEdit = async (thread: Thread, from: string, to: string) => {
    const done = thread.submit({
      type: "raw",
      message: pendingMessage("edit"),
    });
    const stream = await awaitNextStream(mockClient, last);
    stream.streamToolUse("edl-1" as ToolRequestId, "edl" as ToolName, {
      script: `file \`${file}\`\nnarrow /${from}/\nreplace "${to}"`,
    });
    stream.finishResponse("tool_use");
    const next = await awaitNextStream(mockClient, stream);
    next.finishResponse("end_turn");
    last = next;
    await expect(done).resolves.toMatchObject({ type: "completed" });
  };

  const before = await create();
  session.attachClient(spyEditor);
  await runEdit(before.thread, "hello", "bye");
  expect(onFileWritten).not.toHaveBeenCalled();

  const after = await create();
  expect(createLspClient).toHaveBeenCalledWith(threadCwd, dir);
  expect(host.getPrepared(after.id).systemInfo.neovimVersion).toBe("999");
  await runEdit(after.thread, "bye", "again");
  expect(onFileWritten).toHaveBeenCalledWith(file);
  expect(await readFile(file, "utf8")).toBe("again");
});

describe("submission resolution", () => {
  const userText = (stream: {
    messages: { role: string; content: unknown }[];
  }) => JSON.stringify(stream.messages.filter((m) => m.role === "user"));

  it("adds @file: context through the thread's fileIO and expands custom commands", async () => {
    const thread = await createThread();
    const abs = path.join(dir, "a.txt");
    const done = thread.submit({
      type: "raw",
      message: pendingMessage(`look @file:${abs} @hi`),
    });
    const stream = await awaitNextStream(mockClient, undefined);
    expect(thread.contextFiles.files[abs as AbsFilePath]).toBeDefined();
    expect(userText(stream)).toContain("custom text");
    stream.finishResponse("end_turn");
    await done;
  });

  it("reports a missing @file:", async () => {
    const thread = await createThread();
    const missing = path.join(dir, "missing.txt");
    const done = thread.submit({
      type: "raw",
      message: pendingMessage(`@file:${missing}`),
    });
    const stream = await awaitNextStream(mockClient, undefined);
    expect(userText(stream)).toContain(
      `Error adding file to context for ${missing}: File ${missing} does not exist`,
    );
    stream.finishResponse("end_turn");
    await done;
  });

  it("expands @diff in a real git repo", async () => {
    const git = (...args: string[]) =>
      promisify(execFile)("git", args, { cwd: dir });
    await git("init", "-q");
    await git("config", "user.email", "t@t");
    await git("config", "user.name", "t");
    await writeFile(path.join(dir, "d.txt"), "one\n");
    await git("add", ".");
    await git("commit", "-qm", "init");
    await writeFile(path.join(dir, "d.txt"), "two\n");
    const thread = await createThread();
    const done = thread.submit({
      type: "raw",
      message: pendingMessage("@diff:d.txt"),
    });
    const stream = await awaitNextStream(mockClient, undefined);
    expect(userText(stream)).toContain("+two");
    stream.finishResponse("end_turn");
    await done;
  });

  it("expands @staged in a real git repo", async () => {
    const git = (...args: string[]) =>
      promisify(execFile)("git", args, { cwd: dir });
    await git("init", "-q");
    await git("config", "user.email", "t@t");
    await git("config", "user.name", "t");
    await writeFile(path.join(dir, "s.txt"), "one\n");
    await git("add", ".");
    await git("commit", "-qm", "init");
    await writeFile(path.join(dir, "s.txt"), "staged\n");
    await git("add", "s.txt");
    await writeFile(path.join(dir, "s.txt"), "unstaged\n");
    const thread = await createThread();
    const done = thread.submit({
      type: "raw",
      message: pendingMessage("@staged:s.txt"),
    });
    const stream = await awaitNextStream(mockClient, undefined);
    const text = userText(stream);
    expect(text).toContain("+staged");
    expect(text).not.toContain("+unstaged");
    stream.finishResponse("end_turn");
    await done;
  });
});

describe("auth UI", () => {
  function makeHost(getAuthUI: () => AuthUI | undefined, logger = noopLogger) {
    return new ServerSessionHost({
      logger,
      cwd: dir as Cwd,
      homeDir: dir as HomeDir,
      sandbox: new MockSandboxManager(),
      getOptions: () => options,
      getAuthUI,
    });
  }
  it("throws for OAuth and logs errors/progress when no client is attached", () => {
    const logged: string[] = [];
    const h = makeHost(() => undefined, {
      ...noopLogger,
      error: (m: string) => logged.push(`error:${m}`),
      info: (m: string) => logged.push(`info:${m}`),
    });
    expect(() => h.authUI.showOAuthFlow("https://x")).toThrow(
      /attached client/,
    );
    h.authUI.showError("bad");
    h.authUI.showLoginProgress("step");
    expect(logged).toEqual(["error:bad", "info:step"]);
  });
  it("uses the UI attached at login time, not at construction", () => {
    let ui: AuthUI | undefined;
    const h = makeHost(() => ui);
    const calls: string[] = [];
    ui = {
      showOAuthFlow: (url) => {
        calls.push(url);
        return Promise.resolve("code");
      },
      showError: (m) => calls.push(m),
      showLoginProgress: (m) => calls.push(m),
    } as AuthUI;
    void h.authUI.showOAuthFlow("https://x");
    h.authUI.showError("e");
    expect(calls).toEqual(["https://x", "e"]);
  });
  it("builds a real provider without the test override", () => {
    const h = makeHost(() => undefined);
    expect(h.getProvider({ ...profile, name: "smoke-real" })).toBeDefined();
  });
});
