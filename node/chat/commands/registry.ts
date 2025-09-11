import type { Command, MessageContext } from "./types.ts";
import type { ProviderMessageContent } from "../../providers/provider-types.ts";
import { forkCommand } from "./fork.ts";
import { fileCommand } from "./file.ts";
import { diffCommand, stagedCommand } from "./diff.ts";
import { diagCommand, diagnosticsCommand } from "./diagnostics.ts";
import { qfCommand, quickfixCommand } from "./quickfix.ts";
import { bufCommand, buffersCommand } from "./buffers.ts";
import { asyncCommand } from "./async.ts";
import type { CustomCommand as CustomCommandConfig } from "../../options.ts";

export class CommandRegistry {
  private commands: Map<string, Command> = new Map();

  constructor() {
    this.registerBuiltinCommands();
  }

  private registerBuiltinCommands(): void {
    const builtinCommands: Command[] = [
      forkCommand,
      fileCommand,
      diffCommand,
      stagedCommand,
      diagCommand,
      diagnosticsCommand,
      qfCommand,
      quickfixCommand,
      bufCommand,
      buffersCommand,
      asyncCommand,
    ];

    for (const command of builtinCommands) {
      this.registerCommand(command);
    }
  }

  registerCommand(command: Command): void {
    if (this.commands.has(command.name)) {
      throw new Error(`Command ${command.name} is already registered`);
    }
    this.commands.set(command.name, command);
  }

  registerCustomCommand(config: CustomCommandConfig): void {
    const command: Command = {
      name: config.name,
      pattern: new RegExp(
        config.name.match(/\w$/)
          ? `${this.escapeRegExp(config.name)}\\b`
          : `${this.escapeRegExp(config.name)}`,
      ),
      execute(): Promise<ProviderMessageContent[]> {
        return Promise.resolve([
          {
            type: "text",
            text: config.text,
          },
        ]);
      },
    };

    if (config.description !== undefined) {
      command.description = config.description;
    }

    this.registerCommand(command);
  }

  private escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  getCommands(): Command[] {
    return Array.from(this.commands.values());
  }

  async processMessage(
    text: string,
    context: MessageContext,
  ): Promise<{
    processedText: string;
    additionalContent: ProviderMessageContent[];
  }> {
    const additionalContent: ProviderMessageContent[] = [];
    let processedText = text;

    // Find all command matches in the text
    const matches: Array<{
      command: Command;
      match: RegExpMatchArray;
      startIndex: number;
      endIndex: number;
    }> = [];

    for (const command of this.commands.values()) {
      const regex = new RegExp(command.pattern.source, "g");
      let match;
      while ((match = regex.exec(text)) !== null) {
        matches.push({
          command,
          match,
          startIndex: match.index,
          endIndex: match.index + match[0].length,
        });
      }
    }

    // Sort matches by start index in reverse order (process from end to beginning)
    matches.sort((a, b) => b.startIndex - a.startIndex);

    // Process matches from end to beginning to avoid offset issues
    const processedRanges: Array<{ start: number; end: number }> = [];
    for (const { command, match, startIndex, endIndex } of matches) {
      // Check if this range overlaps with any already processed range
      const overlaps = processedRanges.some(
        (range) => !(endIndex <= range.start || startIndex >= range.end),
      );

      if (!overlaps) {
        try {
          const content = await command.execute(match, context);
          additionalContent.unshift(...content); // Add to beginning to maintain order
          processedRanges.push({ start: startIndex, end: endIndex });

          // Remove the command from the text (except for @async which needs special handling)
          if (command.name !== "@async") {
            processedText =
              processedText.substring(0, startIndex) +
              processedText.substring(endIndex);
          }
        } catch (error) {
          additionalContent.unshift({
            type: "text",
            text: `Error processing ${command.name}: ${error instanceof Error ? error.message : String(error)}`,
          });
          // Still remove the command from text on error
          processedText =
            processedText.substring(0, startIndex) +
            processedText.substring(endIndex);
        }
      }
    }

    // @async requires special handling - strip the prefix after all processing
    if (processedText.trim().startsWith("@async")) {
      processedText = processedText.replace(/^\s*@async\s*/, "");
    }

    return { processedText, additionalContent };
  }
}
