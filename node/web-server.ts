import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Nvim } from "./nvim/nvim-node/index.ts";
import { detectReachableHost } from "./utils/network.ts";

// Status describes the currently-available actions for the web client. Slice 2
// only needs `running`; later slices extend it (e.g. pendingApproval).
export type ThreadInfo = {
  id: string;
  title: string;
  status: string;
  active: boolean;
};

export type Status = {
  running: boolean;
  pendingApproval?: { id: string; toolName: string };
  threads: ThreadInfo[];
};

// Action describes an upstream command from the web client. Slice 3 only needs
// `send`; later slices extend this union (abort, approve, reject).
export type Action =
  | { type: "send"; text: string }
  | { type: "abort" }
  | { type: "approve"; id: string }
  | { type: "reject"; id: string }
  | { type: "new-thread" }
  | { type: "select-thread"; id: string };

// The single served URL for this process's web server (one server per process).
// Set once the port resolves; read by the thread view to render a header.
let servedUrl: string | undefined;

export function getServedUrl(): string | undefined {
  return servedUrl;
}

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
  private resolvedPort: number | undefined = undefined;
  private listeningResolve: ((port: number) => void) | undefined;
  private listening = new Promise<number>((resolve) => {
    this.listeningResolve = resolve;
  });

  constructor(
    private nvim: Nvim,
    private onAction: (action: Action) => void,
    private getStatus: () => Status,
  ) {
    this.server = createServer((req, res) => {
      const path = req.url
        ? new URL(req.url, "http://localhost").pathname
        : "/";

      const method = req.method ?? "GET";

      if (method === "POST" && path === "/action") {
        this.handleAction(req, res);
        return;
      }

      if (method === "GET" && path === "/events") {
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

  private handleAction(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      // Guard against unbounded request bodies (1MB cap is plenty for a prompt).
      if (chunks.reduce((n, c) => n + c.length, 0) > 1_000_000) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooLarge) {
        this.respondError(res, 413, "request body too large");
        return;
      }

      const body = Buffer.concat(chunks).toString("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        this.respondError(res, 400, "invalid JSON");
        return;
      }

      const action = this.parseAction(parsed);
      if (!action) {
        this.respondError(res, 400, "unknown action");
        return;
      }

      try {
        this.onAction(action);
      } catch (err) {
        this.nvim.logger.error(
          `WebServer: onAction threw: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.respondError(res, 500, "internal error");
        return;
      }

      res.writeHead(204);
      res.end();
    });
    req.on("error", (err) => {
      this.nvim.logger.error(`WebServer: request error: ${err.message}`);
    });
  }

  private parseAction(value: unknown): Action | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const obj = value as { type?: unknown; text?: unknown; id?: unknown };
    if (obj.type === "send" && typeof obj.text === "string") {
      return { type: "send", text: obj.text };
    }
    if (obj.type === "abort") {
      return { type: "abort" };
    }
    if (obj.type === "new-thread") {
      return { type: "new-thread" };
    }
    if (obj.type === "select-thread" && typeof obj.id === "string") {
      return { type: "select-thread", id: obj.id };
    }
    if (
      (obj.type === "approve" || obj.type === "reject") &&
      typeof obj.id === "string"
    ) {
      return { type: obj.type, id: obj.id };
    }
    return undefined;
  }

  private respondError(
    res: ServerResponse,
    status: number,
    message: string,
  ): void {
    this.nvim.logger.warn(`WebServer: /action ${status}: ${message}`);
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(message);
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
    return { chatText: this.latestChatText, status: this.getStatus() };
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

  getPort(): number | undefined {
    return this.resolvedPort;
  }

  // Resolves with the OS-assigned port once `listen(0)` has bound.
  whenListening(): Promise<number> {
    return this.listening;
  }

  start(): void {
    this.server.listen(0, "0.0.0.0", () => {
      const address: string | AddressInfo | null = this.server.address();
      if (
        address !== null &&
        typeof address === "object" &&
        typeof address.port === "number"
      ) {
        this.resolvedPort = address.port;
        servedUrl = `http://${detectReachableHost()}:${address.port}`;
        this.nvim.logger.info(`Magenta web server listening on ${servedUrl}`);
        this.listeningResolve?.(address.port);
      } else {
        this.nvim.logger.error(
          `WebServer: failed to resolve listening port from address: ${JSON.stringify(address)}`,
        );
      }
    });
  }

  close(): void {
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
    this.server.close();
    servedUrl = undefined;
  }
}
