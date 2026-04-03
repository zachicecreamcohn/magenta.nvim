import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolName, ToolRequestId } from "@magenta/core";
import { describe, expect, it } from "vitest";
import { FULL_CAPABILITIES } from "../test/capabilities.ts";
import { withDriver } from "../test/preamble.ts";

const MINIMAL_DOCKERFILE = `\
FROM node:24-bookworm-slim
WORKDIR /workspace
COPY . .
CMD ["tail", "-f", "/dev/null"]
`;

describe.runIf(FULL_CAPABILITIES)("docker subagent file sync", () => {
  it(
    "files edited and created in docker container are synced back to host on yield",
    async () => {
      await withDriver(
        {
          setupFiles: async (tmpDir: string) => {
            // Create a file that the subagent will modify
            await fs.promises.writeFile(
              path.join(tmpDir, "test-file.txt"),
              "original",
            );

            // Create .magenta/options.json with container config
            const magentaDir = path.join(tmpDir, ".magenta");
            await fs.promises.mkdir(magentaDir, { recursive: true });
            await fs.promises.writeFile(
              path.join(magentaDir, "options.json"),
              JSON.stringify({
                container: {
                  dockerfile: "Dockerfile",
                  workspacePath: "/workspace",
                },
              }),
            );

            // Create a minimal Dockerfile
            await fs.promises.writeFile(
              path.join(tmpDir, "Dockerfile"),
              MINIMAL_DOCKERFILE,
            );
          },
        },
        async (driver, dirs) => {
          await driver.showSidebar();

          await driver.inputMagentaText(
            "Spawn a docker subagent to edit files.",
          );
          await driver.send();

          // Parent thread gets the user message and responds with spawn_subagents
          const request1 =
            await driver.mockAnthropic.awaitPendingStreamWithText(
              "Spawn a docker subagent",
            );
          request1.respond({
            stopReason: "tool_use",
            text: "I'll spawn a docker subagent.",
            toolRequests: [
              {
                status: "ok",
                value: {
                  id: "test-docker-spawn" as ToolRequestId,
                  toolName: "spawn_subagents" as ToolName,
                  input: {
                    agents: [
                      {
                        prompt:
                          "Edit test-file.txt and create new-file.txt, then yield.",
                        environment: "docker_unsupervised",
                      },
                    ],
                  },
                },
              },
            ],
          });

          // The docker subagent gets its prompt and responds with bash_command
          // Needs a long timeout because Docker image build + container start happens first
          const request2 =
            await driver.mockAnthropic.awaitPendingStreamWithText(
              "Edit test-file.txt",
              { timeout: 90_000 },
            );
          request2.respond({
            stopReason: "tool_use",
            text: "I'll edit the files now.",
            toolRequests: [
              {
                status: "ok",
                value: {
                  id: "test-docker-bash" as ToolRequestId,
                  toolName: "bash_command" as ToolName,
                  input: {
                    command:
                      'echo "modified" > /workspace/test-file.txt && echo "new content" > /workspace/new-file.txt',
                  },
                },
              },
            ],
          });

          // After bash_command completes, subagent yields
          const request3 =
            await driver.mockAnthropic.awaitPendingStreamWithText(
              "exit code 0",
              { timeout: 10_000 },
            );
          request3.respond({
            stopReason: "tool_use",
            text: "Files updated. Yielding back to parent.",
            toolRequests: [
              {
                status: "ok",
                value: {
                  id: "test-docker-yield" as ToolRequestId,
                  toolName: "yield_to_parent" as ToolName,
                  input: {
                    result: "Files edited successfully",
                  },
                },
              },
            ],
          });

          // Wait for the parent to get the spawn_subagents result
          // Teardown (docker cp + rsync) may take a few seconds
          await driver.assertDisplayBufferContains("✅ 1 agent", 0, 15_000);

          // Verify files were synced back to the host
          const testFileContent = await fs.promises.readFile(
            path.join(dirs.tmpDir, "test-file.txt"),
            "utf-8",
          );
          expect(testFileContent.trim()).toBe("modified");

          const newFileContent = await fs.promises.readFile(
            path.join(dirs.tmpDir, "new-file.txt"),
            "utf-8",
          );
          expect(newFileContent.trim()).toBe("new content");
        },
      );
    },
    { timeout: 120_000 },
  );
});
