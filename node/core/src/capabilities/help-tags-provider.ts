export interface HelpTagsProvider {
  /** Absolute paths to all discovered `doc/tags` files on the runtime path. */
  listTagFiles(): Promise<string[]>;
}
