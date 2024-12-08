import * as Anthropic from '@anthropic-ai/sdk'
import { Context } from './types'
import { getBufferIfOpen } from './utils/buffers';
import { ToolResultBlockParam } from '@anthropic-ai/sdk/resources';
import fs from 'fs'
import path from 'path'

export class FileTool {
  constructor() { }

  async execRequest(request: GetFileToolUseRequest, context: Context): Promise<ToolResultBlockParam> {
    const { nvim } = context;
    const filePath = request.input.path;
    const bufferContents = await getBufferIfOpen({ nvim, path: filePath });

    if (bufferContents.status === 'ok') {
      return {
        type: 'tool_result',
        tool_use_id: request.id,
        content: bufferContents.result,
        is_error: false
      };
    }

    if (bufferContents.status === 'error') {
      return {
        type: 'tool_result',
        tool_use_id: request.id,
        content: bufferContents.error,
        is_error: true
      };
    }

    // If buffer not found, try reading from filesystem
    try {
      const cwd = await nvim.call('getcwd') as string;
      const absolutePath = path.resolve(cwd, filePath);

      // Security check: ensure the path is within cwd
      if (!absolutePath.startsWith(cwd)) {
        return {
          type: 'tool_result',
          tool_use_id: request.id,
          content: 'The path must be inside of neovim cwd',
          is_error: true
        };
      }

      const fileContent = await fs.promises.readFile(absolutePath, 'utf-8');
      return {
        type: 'tool_result',
        tool_use_id: request.id,
        content: fileContent,
        is_error: false
      };
    } catch (error) {
      return {
        type: 'tool_result',
        tool_use_id: request.id,
        content: `Failed to read file: ${(error as Error).message}`,
        is_error: true
      };
    }
  }

  spec(): Anthropic.Anthropic.Tool {
    return {
      name: 'get_file',
      description: `Get the full contents of a file in the project directory.`,
      input_schema: {
        type: 'object',
        properties: {
          'path': {
            type: 'string',
            description: 'the path, relative to the project root, of the file. e.g. ./src/index.js'
          }
        },
        required: ['path']
      }
    }
  }
}

export const TOOLS = {
  'get_file': new FileTool()
}

export type GetFileToolUseRequest = {
  type: "tool_use"
  id: string //"toolu_01UJtsBsBED9bwkonjqdxji4"
  name: "get_file"
  input: {
    path: string //"./src/index.js"
  }
}
