import { readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InstanceEntry } from "./instance-registry.ts";
import type { Nvim } from "./nvim/nvim-node/index.ts";

const ELECTION_INTERVAL_MS = 3000;

// At runtime in the bundle, import.meta.url resolves to dist/magenta.mjs, so
// these assets live alongside it in dist/ (see scripts/build.mjs).
const ASSET_DIR = dirname(fileURLToPath(import.meta.url));

const ASSETS: { [path: string]: { file: string; contentType: string } } = {
  "/": { file: "index-page.html", contentType: "text/html; charset=utf-8" },
  "/index-page.js": {
    file: "index-page.js",
    contentType: "text/javascript; charset=utf-8",
  },
};

// Leadership is the configured index port: instances opportunistically try to
// bind it; whoever succeeds serves the index. When a leader dies (any signal)
// the OS frees the port and a survivor wins on its next election tick.
export class IndexServer {
  private server: Server | undefined;
  private isLeader = false;
  private election: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(
    private nvim: Nvim,
    private indexPort: number,
    private bindHost: string,
    private readInstances: () => InstanceEntry[],
  ) {}

  start(): void {
    this.tryBecomeLeader();
    this.election = setInterval(
      () => this.tryBecomeLeader(),
      ELECTION_INTERVAL_MS,
    );
    this.election.unref();
  }

  private tryBecomeLeader(): void {
    if (this.closed || this.isLeader) return;

    // Fresh Server per attempt: a server that errored on bind must not be reused.
    const server = createServer((req, res) => this.handle(req.url ?? "/", res));

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") return; // someone else leads; retry next tick
      this.nvim.logger.warn(`Magenta index server bind error: ${err.message}`);
    });

    server.listen(this.indexPort, this.bindHost, () => {
      this.isLeader = true;
      this.server = server;
      this.nvim.logger.info(
        `Magenta index server listening on http://${this.bindHost}:${this.indexPort}`,
      );
    });
  }

  private handle(url: string, res: ServerResponse): void {
    const path = new URL(url, "http://localhost").pathname;

    if (path === "/instances") {
      const body = JSON.stringify({
        instances: this.readInstances(),
        self: process.pid,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }

    const asset = ASSETS[path];
    if (!asset) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    readFile(join(ASSET_DIR, asset.file)).then(
      (content) => {
        res.writeHead(200, { "content-type": asset.contentType });
        res.end(content);
      },
      (err: unknown) => {
        this.nvim.logger.error(
          `IndexServer: failed to read ${asset.file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("internal error");
      },
    );
  }

  close(): void {
    this.closed = true;
    if (this.election) {
      clearInterval(this.election);
      this.election = undefined;
    }
    if (this.server) {
      this.server.close();
      this.server = undefined;
    }
    this.isLeader = false;
  }
}
