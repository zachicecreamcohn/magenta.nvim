import { describe, expect, it } from "vitest";
import { getToolSpecs, type MCPToolManager } from "./toolManager.ts";

const mockMcpToolManager: MCPToolManager = {
  getToolSpecs: () => [],
};

describe("docker_root tool specs", () => {
  it("includes root tools plus yield_to_parent", () => {
    const specs = getToolSpecs("docker_root", mockMcpToolManager);
    const names = specs.map((s) => s.name);

    expect(names).toContain("get_file");
    expect(names).toContain("bash_command");
    expect(names).toContain("spawn_subagent");
    expect(names).toContain("spawn_foreach");
    expect(names).toContain("wait_for_subagents");
    expect(names).toContain("edl");
    expect(names).toContain("yield_to_parent");
  });

  it("excludes lsp and diagnostics when those capabilities are missing", () => {
    const dockerCapabilities = new Set<
      "lsp" | "shell" | "diagnostics" | "threads" | "file-io"
    >(["file-io", "shell", "threads"]);

    const specs = getToolSpecs(
      "docker_root",
      mockMcpToolManager,
      dockerCapabilities,
    );
    const names = specs.map((s) => s.name);

    expect(names).not.toContain("hover");
    expect(names).not.toContain("find_references");
    expect(names).not.toContain("diagnostics");
    expect(names).toContain("get_file");
    expect(names).toContain("bash_command");
    expect(names).toContain("yield_to_parent");
  });
});
