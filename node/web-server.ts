import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Nvim } from "./nvim/nvim-node/index.ts";

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

  constructor(
    private port: number,
    private nvim: Nvim,
  ) {
    this.server = createServer((req, res) => {
      const path = req.url
        ? new URL(req.url, "http://localhost").pathname
        : "/";
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

  start(): void {
    this.server.listen(this.port, "0.0.0.0", () => {
      this.nvim.logger.info(
        `Magenta web server listening on http://0.0.0.0:${this.port}`,
      );
    });
  }

  close(): void {
    this.server.close();
  }
}
