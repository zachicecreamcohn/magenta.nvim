// Core highlight types and interfaces for the magenta.nvim VDOM system

/**
 * Union type of all available highlight groups for type safety.
 * Includes standard Neovim groups, Treesitter groups, LSP semantic tokens, and dynamic groups.
 */
/**
 * All available highlight groups for type safety.
 * Includes standard Neovim groups, Treesitter groups, and LSP semantic tokens.
 */
export const HL_GROUPS = [
  // Standard Neovim highlight groups
  "ErrorMsg",
  "WarningMsg",
  "Directory",
  "String",
  "Comment",
  "Bold",
  "Identifier",
  "Underlined",
  "Normal",
  "Function",
  // Treesitter groups
  "@variable",
  "@function.call",
  "@keyword",
  "@string",
  "@comment",
  "@type",
  "@constant",
  // LSP semantic token groups
  "@lsp.type.variable",
  "@lsp.type.function",
  "@lsp.type.keyword",
  "@lsp.type.string",
  "@lsp.type.comment",
  "@lsp.type.type",
  "@lsp.type.constant",
] as const;

/**
 * Union type of all available highlight groups for type safety.
 */
export type HLGroup = (typeof HL_GROUPS)[number];

/**
 * Text styling options for bold, italic, underline, etc.
 */
export type TextStyle = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
};

/**
 * Custom color styling when semantic groups aren't sufficient.
 * Use sparingly to maintain colorscheme compatibility.
 */
export type ColorStyle = {
  fg?: string;
  bg?: string;
};

/**
 * Branded type for tracking extmark IDs from Neovim.
 */
export type ExtmarkId = number & { __extmarkId: true };

/**
 * Comprehensive options for nvim_buf_set_extmark.
 * Covers all available extmark functionality.
 */
export type ExtmarkOptions = {
  // Basic highlighting
  hl_group?: HLGroup | TextStyleGroup;
  hl_eol?: boolean;
  hl_mode?: "replace" | "combine" | "blend";
  priority?: number;

  // Line-level styling
  line_hl_group?: HLGroup;

  // Sign column
  sign_text?: string;
  sign_hl_group?: HLGroup;

  // Line number styling
  number_hl_group?: HLGroup;

  // Advanced features
  conceal?: string;
  url?: string;

  // Position control
  right_gravity?: boolean;
  end_right_gravity?: boolean;
  strict?: boolean;

  // Persistence
  undo_restore?: boolean;
  invalidate?: boolean;
  ephemeral?: boolean;
};

export type TextStyleGroup = string & { __textStyleGroup: true };

/**
 * Create a text style highlight group dynamically.
 * Returns highlight group name for use in ExtmarkOptions.
 * Note: This creates dynamic highlight groups that may need to be registered with Neovim.
 */
export function createTextStyleGroup(style: TextStyle): TextStyleGroup {
  const parts: string[] = [];
  if (style.bold) parts.push("bold");
  if (style.italic) parts.push("italic");
  if (style.underline) parts.push("underline");
  if (style.strikethrough) parts.push("strikethrough");
  return parts.join(",") as TextStyleGroup;
}

/**
 * Compare two ExtmarkOptions objects for equality.
 * Used for efficient diffing during updates to avoid unnecessary extmark operations.
 */
export function extmarkOptionsEqual(
  options1: ExtmarkOptions | undefined,
  options2: ExtmarkOptions | undefined,
): boolean {
  // Both undefined - equal
  if (options1 === undefined && options2 === undefined) {
    return true;
  }

  // One undefined, one defined - not equal
  if (options1 === undefined || options2 === undefined) {
    return false;
  }

  // Compare all relevant properties
  return (
    options1.hl_group === options2.hl_group &&
    options1.hl_eol === options2.hl_eol &&
    options1.hl_mode === options2.hl_mode &&
    options1.priority === options2.priority &&
    options1.line_hl_group === options2.line_hl_group &&
    options1.sign_text === options2.sign_text &&
    options1.sign_hl_group === options2.sign_hl_group &&
    options1.number_hl_group === options2.number_hl_group &&
    options1.conceal === options2.conceal &&
    options1.url === options2.url &&
    options1.right_gravity === options2.right_gravity &&
    options1.end_right_gravity === options2.end_right_gravity &&
    options1.strict === options2.strict &&
    options1.undo_restore === options2.undo_restore &&
    options1.invalidate === options2.invalidate &&
    options1.ephemeral === options2.ephemeral
  );
}
