import { spawn, type ChildProcess } from "node:child_process";
import type { ThreadId } from "@magenta/core";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { MagentaOptions } from "../options.ts";
import { getSandboxState, updateSandboxConfigIfChanged } from "../sandbox-manager.ts";
import { withTimeout } from "../utils/async.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import type { SandboxViolationHandler } from "./sandbox-violation-handler.ts";
import type { OutputLine, Shell, ShellResult } from "./shell.ts";
import {
  createLogWriter,
  escalateToSigkill,
  processStreamData,
  terminateProcess,
} from "./shell-utils.ts";

export class SandboxShell implements Shell {
  private runningProcess: ChildProcess | undefined;

  constructor(
    private context: {
      cwd: NvimCwd;
      homeDir: HomeDir;
      threadId: ThreadId;
      getOptions: () => MagentaOptions;
    },
    private violationHandler: SandboxViolationHandler,
  ) {}

  terminate(): void {
    const childProcess = this.runningProcess;
    if (!childProcess) return;

    terminateProcess(childProcess);

    setTimeout(() => {
      if (this.runningProcess === childProcess) {
        escalateToSigkill(childProcess);
      }
    }, 1000);
  }

  private async spawnCommand(
    command: string,
    opts: {
      toolRequestId: string;
      onOutput?: (line: OutputLine) => void;
      onStart?: () => void;
    },
  ): Promise<ShellResult> {
    const logWriter = createLogWriter(
      this.context.threadId,
      opts.toolRequestId,
      command,
    );

    const output: OutputLine[] = [];
    const startTime = Date.now();

    try {
      const result = await withTimeout(
        new Promise<{
          code: number | undefined;
          signal: NodeJS.Signals | undefined;
        }>((resolve, reject) => {
          const childProcess = spawn("bash", ["-c", command], {
            stdio: ["ignore", "pipe", "pipe"],
            cwd: this.context.cwd,
            env: process.env,
            detached: true,
          });
          this.runningProcess = childProcess;
          opts.onStart?.();

          childProcess.stdout?.on("data", (data: Buffer) => {
            processStreamData("stdout", data, output, logWriter, opts.onOutput);
          });

          childProcess.stderr?.on("data", (data: Buffer) => {
            processStreamData("stderr", data, output, logWriter, opts.onOutput);
          });

          childProcess.on(
            "close",
            (code: number | null, signal: NodeJS.Signals | null) => {
              resolve({
                code: code ?? undefined,
                signal: signal ?? undefined,
              });
            },
          );

          childProcess.on("error", (error: Error) => {
            reject(error);
          });
        }),
        300000,
      );

      const durationMs = Date.now() - startTime;

      if (result.signal) {
        logWriter.writeRaw(`terminated by signal ${result.signal}\n`);
      } else {
        logWriter.writeRaw(`exit code ${result.code}\n`);
      }
      logWriter.end();
      this.runningProcess = undefined;

      return {
        exitCode: result.code ?? -1,
        signal: result.signal,
        output,
        logFilePath: logWriter.filePath,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;

      if (this.runningProcess) {
        this.runningProcess.kill();
        this.runningProcess = undefined;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      output.push({ stream: "stderr", text: errorMessage });
      logWriter.write("stderr", errorMessage);
      logWriter.writeRaw("exit code 1\n");
      logWriter.end();

      return {
        exitCode: 1,
        signal: undefined,
        output,
        logFilePath: logWriter.filePath,
        durationMs,
      };
    }
  }

  async execute(
    command: string,
    opts: {
      toolRequestId: string;
      onOutput?: (line: OutputLine) => void;
      onStart?: () => void;
    },
  ): Promise<ShellResult> {
    const sandboxState = getSandboxState();

    if (sandboxState.status !== "ready") {
      return this.violationHandler.promptForApproval(command, () =>
        this.spawnCommand(command, opts),
      );
    }

    const options = this.context.getOptions();
    updateSandboxConfigIfChanged(
      options.sandbox,
      this.context.cwd,
      this.context.homeDir,
    );

    const store = SandboxManager.getSandboxViolationStore();
    const preCount = store.getTotalCount();

    const wrapped = await SandboxManager.wrapWithSandbox(command);
    const result = await this.spawnCommand(wrapped, opts);

    const postCount = store.getTotalCount();
    if (postCount > preCount && result.exitCode !== 0) {
      const newViolations = store.getViolations(postCount - preCount);
      const stderr = result.output
        .filter((l) => l.stream === "stderr")
        .map((l) => l.text)
        .join("\n");
      const annotated = SandboxManager.annotateStderrWithSandboxFailures(
        command,
        stderr,
      );

      return this.violationHandler.addViolation(
        { command, violations: newViolations, stderr: annotated },
        () => this.spawnCommand(command, opts),
      );
    }

    SandboxManager.cleanupAfterCommand();
    return result;
  }
}
