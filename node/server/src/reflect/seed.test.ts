import { describe, expect, it } from "vitest";
import type { DisplayBufferText } from "../chat-types.ts";
import type {
  NativeMessageIdx,
  ProviderMessage,
} from "../providers/provider-types.ts";
import type { ToolName, ToolRequestId } from "../tool-types.ts";
import { buildReflectSeed, renderReflectHistory } from "./seed.ts";

const idx = 0 as NativeMessageIdx;
const text = (role: "user" | "assistant", t: string): ProviderMessage => ({
  role,
  content: [{ type: "text", text: t, nativeMessageIdx: idx }],
});
const toolUse = (
  id: string,
  toolName: string,
  input: unknown,
): ProviderMessage => ({
  role: "assistant",
  content: [
    {
      type: "tool_use",
      nativeMessageIdx: idx,
      id: id as ToolRequestId,
      name: toolName as ToolName,
      request: {
        status: "ok",
        value: {
          id: id as ToolRequestId,
          toolName: toolName as ToolName,
          input: input as Record<string, unknown>,
        },
      },
    },
  ],
});
const toolResult = (id: string, t: string): ProviderMessage => ({
  role: "user",
  content: [
    {
      type: "tool_result",
      nativeMessageIdx: idx,
      id: id as ToolRequestId,
      result: { status: "ok", value: [{ type: "text", text: t }] },
    },
  ],
});
const anchor = (messageIdx: number, t: string) => ({
  messageIdx,
  contentIdx: 0,
  reflectionText: t as DisplayBufferText,
});

describe("buildReflectSeed", () => {
  const history: ProviderMessage[] = [
    text("user", "read the config"),
    toolUse("t1", "get_files", { files: [{ filePath: "src/config.ts" }] }),
    toolResult("t1", "SECRET FILE CONTENTS"),
    toolUse("t2", "bash_command", { command: "npm test" }),
    toolResult("t2", "x".repeat(5000)),
    text("assistant", "The config sets the port to 8080."),
    text("user", "LATER MESSAGE"),
  ];

  it("renders history up to the anchor, then the selection", () => {
    const seed = buildReflectSeed({
      history,
      anchor: anchor(5, "port\nto 8080"),
    });
    expect(seed).toHaveLength(2);
    const [context, selection] = seed.map((s) =>
      s.type === "text" ? s.text : "",
    );
    expect(context.startsWith("<thread-context>\n")).toBe(true);
    expect(context.endsWith("</thread-context>")).toBe(true);
    expect(context).toContain("read the config");
    expect(context).toContain("src/config.ts");
    expect(context).not.toContain("SECRET FILE CONTENTS");
    expect(context).toContain(
      '[tool_use: bash_command {"command":"npm test"}]',
    );
    expect(context).toContain("[… 4000 chars omitted]");
    expect(context).toContain("The config sets the port to 8080.");
    expect(context).not.toContain("LATER MESSAGE");
    expect(context).not.toContain("The user selected");
    expect(selection).toBe("The user selected:\n> port\n> to 8080");
  });

  it("composes through nested reflections", () => {
    const rootSeed = buildReflectSeed({
      history: [
        text("user", "ROOT ASK"),
        text("assistant", "ROOT ANSWER"),
        text("user", "ROOT LATER"),
      ],
      anchor: anchor(1, "ROOT ANSWER"),
    });
    const firstReflect: ProviderMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "thread_context",
            text: (rootSeed[0] as { text: string }).text,
            nativeMessageIdx: idx,
          },
          {
            type: "text",
            text: (rootSeed[1] as { text: string }).text,
            nativeMessageIdx: idx,
          },
          { type: "text", text: "FIRST QUESTION", nativeMessageIdx: idx },
        ],
      },
      text("assistant", "FIRST REPLY"),
      text("user", "FIRST LATER"),
    ];
    const [context] = buildReflectSeed({
      history: firstReflect,
      anchor: anchor(1, "FIRST REPLY"),
    }).map((s) => (s.type === "text" ? s.text : ""));
    const order = [
      "ROOT ASK",
      "ROOT ANSWER",
      "> ROOT ANSWER",
      "FIRST QUESTION",
      "FIRST REPLY",
    ].map((t) => context.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(context).not.toContain("ROOT LATER");
    expect(context).not.toContain("FIRST LATER");
  });
});

describe("renderReflectHistory budget", () => {
  it("drops old tool results, then old messages, keeping the last", () => {
    const messages: ProviderMessage[] = [
      text("user", "OLD ASK"),
      toolUse("t1", "bash_command", { command: "ls" }),
      toolResult("t1", "R".repeat(900)),
      text("assistant", "A".repeat(600)),
      text("assistant", "FINAL ANSWER"),
    ];
    const dropped = renderReflectHistory(messages, 800);
    expect(dropped).not.toContain("RRRR");
    expect(dropped).toContain("OLD ASK");
    expect(dropped).toContain("FINAL ANSWER");

    const tight = renderReflectHistory(messages, 100);
    expect(tight).toContain("earlier messages omitted]");
    expect(tight).not.toContain("OLD ASK");
    expect(tight).toContain("FINAL ANSWER");
  });
});
