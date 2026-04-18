# context

## Objective

Ship magenta.nvim to end-users as a single pre-built bundle invoked by `node` directly, collapsing the import-graph file-open count from thousands of files to one. This eliminates the intermittent 10x startup slowdowns on macOS caused by host-level file scanners (Spotlight / Gatekeeper / XProtect / EDR agents) that synchronously gate file opens.

For local plugin development, an env var flag (`MAGENTA_DEV=1`) switches the lua-side `jobstart` command to invoke the source entry point instead, preserving the edit-and-reload dev loop.

## Relevant files

- `lua/magenta/init.lua` — builds the `jobstart` command. Currently invokes `node --experimental-transform-types --import boot.mjs node/index.ts`. This is where the dev/bundle branch lives.
- `node/index.ts` — entry point; will become the esbuild input.
- `node/boot.mjs` — only relevant in dev mode (captures pre-import timestamp for the timing harness). Irrelevant to the bundled path.
- `package.json` — `scripts.start` currently runs the source. Needs a new `build` script; `esbuild` moves into `dependencies` so `npm ci --production` still fetches it.
- `README.md` (line ~175) — lazy.nvim install snippet. Needs the `build` hook updated.
- `doc/magenta.txt` (lines ~63, ~75) — equivalent snippets for lazy.nvim and packer. Needs the same update.
- `node/utils/pdf.ts` — the one import of `pdfjs-dist`. Relevant because pdfjs pulls in `@napi-rs/canvas` (native `.node` binary) and therefore must be handled specially in esbuild config.
- `.gitignore` — must ignore `dist/` (we are NOT committing the bundle; the install hook builds it).

## Native / unbundlable deps (surveyed)

Currently in `node_modules`:

- `@rollup/rollup-darwin-arm64` — dev-only (vitest), not reachable from `node/index.ts`. Ignore.
- `@napi-rs/canvas-darwin-arm64` — reachable via pdfjs-dist. Must be external.
- `@msgpackr-extract/msgpackr-extract-darwin-arm64` — optional speedup for msgpackr; falls back to JS. Must be external (binary can't be bundled).
- `fsevents` — macOS-only optional watcher; falls back. Must be external.

## Design decisions (agreed with user)

1. **Branch lives in lua**, not in `npm run start`, to avoid npm's 300-1500ms startup cost on the fast (bundled) path.
2. **Bundle everything**, with strategic externals only for native modules.
3. **Build hook produces the bundle at install time** (`npm ci && npm run build`). We do NOT commit `dist/` to git.
4. **Dev opt-in via env var** (`MAGENTA_DEV=1`), set by dotfiles when actively hacking on the plugin.
5. **Auto-fallback**: if `dist/magenta.mjs` does not exist, lua falls back to source mode with a one-line warning, so a fresh clone that hasn't run the build yet still works.

# implementation

- [ ] add `esbuild` to `dependencies` in `package.json` so `npm ci --production` fetches it
  - [ ] run `npm install esbuild --save` to pin a current version
  - [ ] verify `npm ci --production` pulls it (dry-run: remove `node_modules/esbuild`, run `npm ci --production`, confirm present)

- [ ] add a `build` script to `package.json`
  - [ ] command: `esbuild node/index.ts --bundle --platform=node --format=esm --outfile=dist/magenta.mjs --external:node:* --external:@napi-rs/canvas --external:@napi-rs/canvas-darwin-arm64 --external:@msgpackr-extract/* --external:fsevents --external:zx`
  - [ ] decision: `--packages=bundle` is the default when `--bundle` is given without `--packages=external`, so all of `node_modules` gets bundled except the explicit externals above.
  - [ ] iterate on the external list until `node dist/magenta.mjs` (with `nvim` listening on a socket) runs end-to-end. If esbuild reports an error about a `.node` file or a dynamic require, add it to externals.

- [ ] add a `scripts/install.mjs` (or `scripts/setup.mjs`) node script that wraps both steps
  - [ ] runs `npm ci --production` then `npm run build`
  - [ ] uses `child_process.spawnSync` with `stdio: "inherit"` and exits non-zero on failure
  - [ ] shebang `#!/usr/bin/env node` and `chmod +x` so it can be invoked directly
  - [ ] expose via `"scripts": { "setup": "node scripts/install.mjs" }` in package.json so lazy.nvim `build = "npm run setup"` works too

- [ ] add `dist/` to `.gitignore`

- [ ] update `lua/magenta/init.lua` `M.start` to branch on `vim.env.MAGENTA_DEV`
  - [ ] if `MAGENTA_DEV` is set → invoke source (current command with `--experimental-transform-types --import boot.mjs node/index.ts`)
  - [ ] otherwise check if `dist/magenta.mjs` exists via `vim.loop.fs_stat`
    - [ ] if yes → invoke `node dist/magenta.mjs`
    - [ ] if no → `vim.notify` a warning ("dist/magenta.mjs missing; falling back to source mode — did you run npm ci?") and invoke source
  - [ ] keep `boot.mjs` usage only in the source path (it's a timing-only concern)

- [ ] update `README.md` install snippet
  - [ ] change `build = "npm ci --production"` to `build = "npm run setup"` (one command, covers install + bundle)
  - [ ] add a short "Development" section noting `MAGENTA_DEV=1 nvim` for source-mode loading

- [ ] update `doc/magenta.txt` lazy.nvim + packer snippets
  - [ ] same change as README (`build = "npm run setup"`)
  - [ ] add a corresponding help entry describing `MAGENTA_DEV`

- [ ] manual timing verification
  - [ ] with a clean filesystem cache (`sudo purge`), `MAGENTA_DEV=1 MAGENTA_TIMINGS=1 nvim` → confirm source path loads; record the pre-import → post-import Δ
  - [ ] with a clean cache, `MAGENTA_TIMINGS=1 nvim` (no MAGENTA_DEV) → confirm bundled path loads; record the same Δ
  - [ ] expect the bundled-path Δ to be << source Δ and, more importantly, to be consistent across 5+ cold runs
  - [ ] if inconsistency persists even with the bundle, fall through to investigating the actual scanner via `sudo fs_usage -w -f filesys -e node`

- [ ] test the install workflow end-to-end
  - [ ] from a fresh clone in a sibling directory: `git clone ... magenta-test && cd magenta-test && npm ci --production && npm run build` → `ls dist/magenta.mjs` succeeds
  - [ ] `NVIM_APPNAME=magenta-test-profile nvim` (or similar isolated profile) pointing at the test clone → startup succeeds, `:Magenta toggle` works

- [ ] tests
  - [ ] **Behavior**: existing vitest suite continues to pass against source (unchanged, since tests don't go through the bundle).
    - [ ] Setup: standard `TEST_MODE=sandbox npx vitest run`.
    - [ ] Assertions: zero regressions.
  - [ ] **Behavior**: lua-side branching picks the right command.
    - [ ] Setup: since this is a pure-lua branch we can't easily unit-test (no existing lua test harness in this repo), verify manually via `MAGENTA_DEV=1 MAGENTA_TIMINGS=1 nvim` and inspect the timing summary for the presence/absence of the `node: boot.mjs loaded (pre-import)` entry (dev mode only).

## Out of scope

- **Committing the bundle.** Rejected: noisy diffs, easy to forget to rebuild. Build at install time instead.
- **Using Vite's `build.lib` mode.** Rejected: Vite uses Rollup for production builds (slower, more config), while we just need esbuild's simple CLI.
- **Deferring node spawn to `VimEnter`.** Already rejected and reverted this session; root cause was not plugin-load contention.
- **Fixing the macOS scanner at the OS level** (Spotlight exclusion, EDR exclusion, quarantine xattr stripping). Useful diagnostic tools but not robust solutions; the bundle makes them unnecessary.

## Notes on externals

- `zx` is used at runtime (`node/chat/commands/diff.ts`). zx does dynamic `require` internally for its globals; plan to mark it `--external:zx` from the start rather than fight it. Since `npm ci` runs on the target machine, the resolved `zx` module will be available at runtime.
- We do not need to chase dropping `@napi-rs/canvas` from externals. `npm ci` runs on the target machine, so `node_modules` is fully populated and external resolution is free.
