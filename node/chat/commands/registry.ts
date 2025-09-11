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

    // Find all command matches in the text
    for (const command of this.commands.values()) {
      const regex = new RegExp(command.pattern.source, "g");
      let match;
      while ((match = regex.exec(text)) !== null) {
        const content = await command.execute(match, context);
        additionalContent.push(...content);
      }
    }

    // Special handling for @async - strip it from the beginning
    const processedText = text.trim().startsWith("@async")
      ? text.replace(/^\s*@async\s*/, "")
      : text;

    return { processedText, additionalContent };
  }
}
