import { type Nvim } from "bunvim";
import type { NvimBuffer } from "./nvim/buffer.ts";
import type { PositionString } from "./nvim/window.ts";

export class Lsp {
  private requestCounter = 0;
  private requests: {
    [requestId: string]:
      | {
          type: "hover";
          resolve: (result: LspHoverResponse) => void;
          reject: (err: Error) => void;
        }
      | {
          type: "find_references";
          resolve: (result: LspReferencesResponse) => void;
          reject: (err: Error) => void;
        };
  } = {};

  constructor(private nvim: Nvim) {}

  requestHover(
    buffer: NvimBuffer,
    pos: PositionString,
  ): Promise<LspHoverResponse> {
    return new Promise<LspHoverResponse>((resolve, reject) => {
      const requestId = this.getRequestId();
      this.requests[requestId] = { type: "hover", resolve, reject };

      this.nvim.logger?.debug(`Initiating hover command...`);
      this.nvim
        .call("nvim_exec_lua", [
          `require('magenta').lsp_hover_request("${requestId}", ${buffer.id}, ${pos.row}, ${pos.col})`,
          [],
        ])
        .catch((...args: string[][]) => {
          console.log(`lsp request error: ${JSON.stringify(args)}`);
          this.rejectRequest(
            requestId,
            new Error(args[0][1] as unknown as string),
          );
        });
    });
  }

  requestReferences(
    buffer: NvimBuffer,
    pos: PositionString,
  ): Promise<LspReferencesResponse> {
    return new Promise((resolve, reject) => {
      const requestId = this.getRequestId();
      this.requests[requestId] = { type: "find_references", resolve, reject };

      this.nvim.logger?.debug(`Initiating references command...`);
      this.nvim
        .call("nvim_exec_lua", [
          `require('magenta').lsp_references_request("${requestId}", ${buffer.id}, ${pos.row}, ${pos.col})`,
          [],
        ])
        .catch((err: Error) => {
          this.rejectRequest(requestId, err);
        });
    });
  }

  private rejectRequest(requestId: string, error: Error) {
    const request = this.requests[requestId];
    if (request) {
      delete this.requests[requestId];
      request.reject(error);
    }
  }

  private getRequestId() {
    const id = this.requestCounter.toString();
    this.requestCounter += 1;
    return id;
  }

  onLspResponse(result: unknown) {
    this.nvim.logger?.debug(`onLspResponse: ${JSON.stringify(result)}`);
    const [[[requestId, res]]] = result as [[[number, unknown]]];
    const request = this.requests[requestId];
    if (!request) {
      throw new Error(
        `Expected to find lsp request with id ${requestId} but found none.`,
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    request.resolve(res as any);
  }
}

// sample hover request:
// [
//   "0",
//   [
//     null,
//     {
//       result: {
//         range: {
//           end: { character: 17, line: 11 },
//           start: { character: 12, line: 11 },
//         },
//         contents: {
//           kind: "markdown",
//           value:
//             '\n```typescript\ntype Model = {\n    type: "hover";\n    request: HoverToolUseRequest;\n    state: {\n        state: "processing";\n    } | {\n        state: "done";\n        result: ToolResultBlockParam;\n    };\n}\n```\n',
//         },
//       },
//     },
//   ],
// ];
type LspHoverResponse = (null | {
  result: {
    range: {
      start: { character: number; line: number };
      end: { character: number; line: number };
    };
    contents: {
      kind: string;
      value: string;
    };
  };
})[];

type LspReferencesResponse = (null | {
  result: {
    uri: string;
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
  }[];
})[];
