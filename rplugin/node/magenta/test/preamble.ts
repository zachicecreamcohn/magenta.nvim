import { attach, NeovimClient } from "neovim";
import { spawn } from "child_process";

export class NeovimTestHelper {
  private nvimProcess?: ReturnType<typeof spawn>;
  private nvimClient?: NeovimClient;

  startNvim(): Promise<NeovimClient> {
    return new Promise((resolve, reject) => {
      console.log("Starting Neovim");

      this.nvimProcess = spawn(
        "nvim",
        ["--headless", "-n", "--clean", "--embed"],
        {
          env: {
            ...process.env,
            NVIM_LOG_FILE: "/tmp/nvim.log", // Helpful for debugging
          },
        },
      );
      this.nvimProcess.on("error", (err) => {
        reject(err);
      });

      this.nvimProcess.stdout!.on("data", (data) => {
        console.log(`stdout: ${data}`);
      });

      this.nvimProcess.stderr!.on("data", (data) => {
        console.log(`stderr: ${data}`);
      });

      // Wait briefly for process to start
      setTimeout(() => {
        try {
          this.nvimClient = attach({ proc: this.nvimProcess });
          resolve(this.nvimClient);
        } catch (err) {
          reject(err as Error);
        }
      }, 100);
    });
  }

  stopNvim(): void {
    if (this.nvimClient) {
      this.nvimClient.quit();
      this.nvimClient = undefined;
    }

    if (this.nvimProcess) {
      this.nvimProcess.kill();
      this.nvimProcess = undefined;
    }
  }
}
