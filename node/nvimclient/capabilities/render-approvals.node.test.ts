import {
  type SandboxViolation,
  SandboxViolationHandler,
  type ShellResult,
} from "@magenta/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApprovals } from "./render-pending-approvals.ts";

function makeShellResult(overrides?: Partial<ShellResult>): ShellResult {
  return {
    exitCode: 0,
    signal: undefined,
    output: [{ stream: "stdout", text: "ok" }],
    logFilePath: undefined,
    durationMs: 100,
    ...overrides,
  };
}

function makeViolation(command = "cat ~/.ssh/id_rsa"): SandboxViolation {
  return {
    command,
    violations: [
      {
        line: "sandbox deny file-read-data /Users/me/.ssh/id_rsa",
        command,
        timestamp: new Date("2026-01-01T00:00:00Z"),
      },
    ],
    stderr:
      "Operation not permitted: read access denied for /Users/me/.ssh/id_rsa",
    result: makeShellResult({
      exitCode: 1,
      output: [
        {
          stream: "stderr",
          text: "Operation not permitted: read access denied for /Users/me/.ssh/id_rsa",
        },
      ],
    }),
  };
}

describe("renderApprovals", () => {
  let handler: SandboxViolationHandler;
  beforeEach(() => {
    handler = new SandboxViolationHandler(vi.fn());
  });
  it("returns empty node when no violations", () => {
    const node = renderApprovals(handler);
    expect(node.type).toBe("node");
    if (node.type === "node") {
      const hasContent = node.children.some(
        (c) => c.type === "string" && c.content.trim().length > 0,
      );
      expect(hasContent).toBe(false);
    }
  });

  it("renders violation with APPROVE/REJECT buttons", () => {
    const retryFn = vi.fn().mockResolvedValue(makeShellResult());
    void handler.addViolation(makeViolation("cat ~/.ssh/id_rsa"), retryFn);

    const node = renderApprovals(handler);
    const text = serializeVDOM(node);

    expect(text).toContain("Sandbox blocked");
    expect(text).toContain("cat ~/.ssh/id_rsa");
    expect(text).toContain("APPROVE");
    expect(text).toContain("REJECT");
  });

  it("renders APPROVE ALL / REJECT ALL for multiple items", () => {
    const retryFn = vi.fn().mockResolvedValue(makeShellResult());
    void handler.addViolation(makeViolation("cmd1"), retryFn);
    void handler.addViolation(makeViolation("cmd2"), retryFn);

    const node = renderApprovals(handler);
    const text = serializeVDOM(node);

    expect(text).toContain("APPROVE ALL");
    expect(text).toContain("REJECT ALL");
  });

  it("does not render ALL buttons for single item", () => {
    const retryFn = vi.fn().mockResolvedValue(makeShellResult());
    void handler.addViolation(makeViolation("cmd1"), retryFn);

    const node = renderApprovals(handler);
    const text = serializeVDOM(node);

    expect(text).not.toContain("APPROVE ALL");
    expect(text).not.toContain("REJECT ALL");
  });
  it("renders host:port prompt", () => {
    void handler.promptForNetworkAccess({ host: "example.com", port: 443 });

    const text = serializeVDOM(renderApprovals(handler));
    expect(text).toContain("Allow network access");
    expect(text).toContain("example.com:443");
    expect(text).toContain("APPROVE");
    expect(text).toContain("REJECT");
  });
  it("renders command prompt", () => {
    void handler.promptForApproval(
      "npm install",
      vi.fn().mockResolvedValue(makeShellResult()),
    );
    const node = renderApprovals(handler);
    const text = serializeVDOM(node);

    expect(text).toContain("May I run command");
    expect(text).toContain("npm install");
    expect(text).toContain("YES");
    expect(text).toContain("NO");
  });
});
function serializeVDOM(node: { type: string; [key: string]: unknown }): string {
  if (node.type === "string") {
    return (node as { type: "string"; content: string }).content;
  }
  if (node.type === "node" || node.type === "array") {
    const children = (
      node as unknown as {
        children: Array<{ type: string; [key: string]: unknown }>;
      }
    ).children;
    return children.map(serializeVDOM).join("");
  }
  return "";
}
