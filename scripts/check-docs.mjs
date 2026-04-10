#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const docDir = join(import.meta.dirname, "..", "doc");
const docsTs = readFileSync(
  join(import.meta.dirname, "..", "node", "core", "src", "tools", "docs.ts"),
  "utf-8",
);

// Get all doc/*.txt files (excluding tags)
const docFiles = readdirSync(docDir)
  .filter((f) => f.endsWith(".txt") && f !== "tags")
  .map((f) => f.replace(/\.txt$/, ""));

// Extract help doc names from BUILTIN_DOCS in docs.ts
const helpDocNames = [];
const regex = /name: "([^"]+)",\s*description: "[^"]*",\s*source: "help"/g;
let match;
while ((match = regex.exec(docsTs)) !== null) {
  helpDocNames.push(match[1]);
}

// Check bidirectional match
const missingEntries = docFiles.filter((f) => !helpDocNames.includes(f));
const missingFiles = helpDocNames.filter((n) => !docFiles.includes(n));

let failed = false;

if (missingEntries.length > 0) {
  console.error(
    `doc/*.txt files without BUILTIN_DOCS entries: ${missingEntries.join(", ")}`,
  );
  failed = true;
}

if (missingFiles.length > 0) {
  console.error(
    `BUILTIN_DOCS entries without doc/*.txt files: ${missingFiles.join(", ")}`,
  );
  failed = true;
}

if (failed) {
  console.error(
    "Update BUILTIN_DOCS in node/core/src/tools/docs.ts to match doc/*.txt files.",
  );
  process.exit(1);
}

console.log(
  `✓ docs check passed (${docFiles.length} help docs match BUILTIN_DOCS)`,
);
