import { readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Nvim } from "./nvim/nvim-node/index.ts";

// Status describes the currently-available actions for the web client. Slice 2
// only needs `running`; later slices extend it (e.g. pendingApproval).
export type Status = {
  running: boolean;
};

type Snapshot = {
  chatText: string;
  status: Status;
};

// At runtime in the bundle, import.meta.url resolves to dist/magenta.mjs, so
// these assets live alongside it in dist/ (see scripts/build.mjs).
const ASSET_DIR = dirname(fileURLToPath(import.meta.url));

const ASSETS: { [path: string]: { file: string; contentType: string } } = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/web-client.js": {
    file: "web-client.js",
    contentType: "text/javascript; charset=utf-8",
  },
};

export class WebServer {
  private server: Server;
  private clients = new Set<ServerResponse>();
  private latestChatText = "";

  constructor(
    private port: number,
    private nvim: Nvim,
  ) {
    this.server = createServer((req, res) => {
      const path = req.url
        ? new URL(req.url, "http://localhost").pathname
        : "/";

      if (path === "/events") {
        this.handleEvents(res);
        return;
      }

      const asset = ASSETS[path];
      if (!asset) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }

      readFile(join(ASSET_DIR, asset.file)).then(
        (body) => {
          res.writeHead(200, { "content-type": asset.contentType });
          res.end(body);
        },
        (err: unknown) => {
          this.nvim.logger.error(
            `WebServer: failed to read ${asset.file}: ${err instanceof Error ? err.message : String(err)}`,
          );
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("internal error");
        },
      );
    });
  }

  private handleEvents(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    this.clients.add(res);
    res.on("close", () => {
      this.clients.delete(res);
    });

    // Immediately push the current snapshot so a new client is up to date.
    this.writeSnapshot(res, this.snapshot());
  }

  private snapshot(): Snapshot {
    // running/pendingApproval land in later slices; slice 2 is a read-only mirror.
    return { chatText: this.latestChatText, status: { running: false } };
  }

  private writeSnapshot(res: ServerResponse, snapshot: Snapshot): void {
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  }

  pushSnapshot(chatText: string): void {
    this.latestChatText = chatText;
    const snapshot = this.snapshot();
    for (const client of this.clients) {
      this.writeSnapshot(client, snapshot);
    }
  }

  start(): void {
    this.server.listen(this.port, "0.0.0.0", () => {
      this.nvim.logger.info(
        `Magenta web server listening on http://0.0.0.0:${this.port}`,
      );
    });
  }

  close(): void {
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
    this.server.close();
  }
}
