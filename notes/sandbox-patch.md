# Sandbox Runtime Patch

We patch `@anthropic-ai/sandbox-runtime` to add missing macOS Seatbelt allowlist entries:

- `com.apple.FSEvents` (mach-lookup) — needed for Node.js file watching (fsevents)
- `sysctl.oidfmt.*` (sysctl-read) — needed for sysctl OID format metadata lookups

The patch lives in `patches/@anthropic-ai+sandbox-runtime+<version>.patch` and is applied automatically on `npm install` via the `postinstall` script (using `patch-package`).

The version in `package.json` is pinned to an exact version since the patch is version-specific.

## Upgrading sandbox-runtime

1. Update the version in `package.json`
2. Delete the old patch file: `rm patches/@anthropic-ai+sandbox-runtime+*.patch`
3. Run `npm install` (the postinstall will warn that no patch exists — that's fine)
4. Check if the upstream version now includes the fixes. If so, you're done — remove the patch infrastructure if no other patches exist.
5. If the fixes are still needed, re-apply the edits to `node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js`:
   - Add `'  (global-name "com.apple.FSEvents")',` to the mach-lookup allowlist
   - Add `'  (sysctl-name-prefix "sysctl.oidfmt.")',` to the sysctl-read allowlist
6. Regenerate the patch: `npx patch-package @anthropic-ai/sandbox-runtime`
7. Verify: `npm ci && npx patch-package` should apply cleanly
