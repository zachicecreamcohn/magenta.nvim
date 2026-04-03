import { type ChildProcess, spawn } from "node:child_process";
import type { ThreadId } from "@magenta/core";
import type { MagentaOptions } from "../options.ts";
import type { Sandbox } from "../sandbox-manager.ts";
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

/** Grace period (ms) after first violation before terminating the process */
export const VIOLATION_GRACE_PERIOD_MS = 5000;
/** Interval (ms) between violation store polls during execution */
export const VIOLATION_POLL_INTERVAL_MS = 100;

export class SandboxShell implements Shell {
  private runningProcess: ChildProcess | undefined;
  private violationGracePeriodMs: number;
  private violationPollIntervalMs: number;

  constructor(
    private context: {
      cwd: NvimCwd;
      homeDir: HomeDir;
      threadId: ThreadId;
      getOptions: () => MagentaOptions;
    },
    private sandbox: Sandbox,
    private violationHandler: SandboxViolationHandler,
    opts?: {
      violationGracePeriodMs?: number;
      violationPollIntervalMs?: number;
    },
  ) {
    this.violationGracePeriodMs =
      opts?.violationGracePeriodMs ?? VIOLATION_GRACE_PERIOD_MS;
    this.violationPollIntervalMs =
      opts?.violationPollIntervalMs ?? VIOLATION_POLL_INTERVAL_MS;
  }

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
    if (this.sandbox.getState().status !== "ready") {
      return this.violationHandler.promptForApproval(command, () =>
        this.spawnCommand(command, opts),
      );
    }

    const options = this.context.getOptions();
    this.sandbox.updateConfigIfChanged(
      options.sandbox,
      this.context.cwd,
      this.context.homeDir,
    );

    const store = this.sandbox.getViolationStore();
    const preCount = store.getTotalCount();

    const wrapped = await this.sandbox.wrapWithSandbox(command);

    // Monitor violations during execution and terminate early if a violation
    // is detected and the process doesn't finish within the grace period.
    // This prevents commands from spinning for minutes hitting the same
    // denied syscall repeatedly.
    const monitor = this.startViolationMonitor(store, preCount);
    const result = await this.spawnCommand(wrapped, opts);
    monitor.stop();

    // If the monitor didn't catch a violation during execution, poll briefly
    // for late-arriving violation events from the macOS `log stream` monitor
    if (result.exitCode !== 0 && !monitor.violationDetected) {
      const deadline = Date.now() + 100;
      while (store.getTotalCount() === preCount && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    const postCount = store.getTotalCount();
    if (postCount > preCount && result.exitCode !== 0) {
      const newViolations = store.getViolations(postCount - preCount);
      const stderr = result.output
        .filter((l) => l.stream === "stderr")
        .map((l) => l.text)
        .join("\n");
      const annotated = this.sandbox.annotateStderrWithSandboxFailures(
        command,
        stderr,
      );

      return this.violationHandler.addViolation(
        { command, violations: newViolations, stderr: annotated, result },
        () => this.spawnCommand(command, opts),
      );
    }

    this.sandbox.cleanupAfterCommand();
    return result;
  }

  private startViolationMonitor(
    store: ReturnType<Sandbox["getViolationStore"]>,
    preCount: number,
  ): { stop: () => void; violationDetected: boolean } {
    let stopped = false;
    let violationDetected = false;
    let graceTimeout: ReturnType<typeof setTimeout> | undefined;

    const pollInterval = setInterval(() => {
      if (stopped) return;
      if (store.getTotalCount() > preCount && !graceTimeout) {
        violationDetected = true;
        graceTimeout = setTimeout(() => {
          if (!stopped) {
            this.terminate();
          }
        }, this.violationGracePeriodMs);
      }
    }, this.violationPollIntervalMs);

    return {
      get violationDetected() {
        return violationDetected;
      },
      stop: () => {
        stopped = true;
        clearInterval(pollInterval);
        if (graceTimeout) clearTimeout(graceTimeout);
      },
    };
  }
}
