import { Neovim, Buffer as NvimBuffer } from "neovim";
import { Logger } from "./logger.ts";

export class Lsp {
  private requestCounter = 0;
  private requests: {
    [requestId: string]: {
      type: "hover";
      resolve: (result: LspHoverResponse) => void;
      reject: (err: Error) => void;
    };
  } = {};

  constructor(
    private nvim: Neovim,
    private logger: Logger,
  ) {}

  requestHover(
    buffer: NvimBuffer,
    row: number,
    col: number,
  ): Promise<LspHoverResponse> {
    return new Promise((resolve, reject) => {
      const requestId = this.getRequestId();
      this.requests[requestId] = { type: "hover", resolve, reject };

      this.logger.log(`Initiating hover command...`);
      this.nvim
        .lua(
          `
        vim.lsp.buf_request_all(${buffer.id}, 'textDocument/hover', {
          textDocument = {
              uri = vim.uri_from_bufnr(${buffer.id})
          },
          position = {
              line = ${row},
              character = ${col}
          }
        }, function(responses)
          vim.fn.Magenta_lsp_response("${requestId}", responses)
        end)
      `,
        )
        .catch((err) => {
          this.rejectRequest(requestId, err as Error);
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

  onLspResponse(result: [number, unknown]) {
    const [requestId, res] = result;
    const request = this.requests[requestId];
    if (!request) {
      throw new Error(
        `Expected to find lsp request with id ${requestId} but found none.`,
      );
    }

    request.resolve(res as LspHoverResponse);
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
//             '\n```typescript\ntype Model = {\n    type: "hover";\n    autoRespond: boolean;\n    request: HoverToolUseRequest;\n    state: {\n        state: "processing";\n    } | {\n        state: "done";\n        result: ToolResultBlockParam;\n    };\n}\n```\n',
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
