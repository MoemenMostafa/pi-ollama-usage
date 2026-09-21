# Footer patches for pi-open-tui

This directory carries the patches that keep the Ollama usage indicator
(`Ollama 5h:3% Wk:0.5%`) **inline in the footer's stats row** when the
[pi-open-tui](https://github.com/OldSuns/pi-open-tui) TUI is installed, instead of on
the separate extension-status line below the footer.

> If you do **not** use pi-open-tui, none of this applies to you — Pi's built-in footer
> picks the status up as-is and this directory can be ignored.

## Why a patch is needed

Pi extensions publish footer items with `ctx.ui.setStatus(key, text)`. Stock pi-open-tui
renders every one of those on the **extension-status line below the footer** (the
`extensionStatuses` footer segment). It has no notion of inlining a status into the
footer's own stats row (`… | tokens | cache | $0.000`), so the Ollama indicator lands on
its own line at the bottom of the screen.

The convention used here: **statuses whose key starts with `stats:` are meant to be
inlined into the stats row.** This extension registers its indicator under
`stats:pi-ollama-usage` (see `extensions/index.ts` → `STATUS_KEY`). pi-open-tui does not
implement that convention natively (verified through **0.3.6**), so a small patch to its
`footer.ts` implements it.

## What the patch changes

All changes are confined to `extensions/open-tui/footer.ts` inside the installed
pi-open-tui package:

1. **New `colorizeStatText()` helper** — in inlined stat text, every embedded percentage
   is colored by usage stress (`accent` → `warning` → `error`, via pi-open-tui's own
   `stressColor()`), surrounding labels in `muted`. This is what makes `5h:42%` turn
   yellow/red as your window fills up.
2. **`renderStatsBlock()` gains an `extraStats: string[]` parameter** — inlined stats are
   appended after the built-in token/cache/cost segments, joined with the same `|`
   separator.
3. **The footer render splits `footerData.getExtensionStatuses()`** — keys starting with
   `stats:` are sanitized and fed to the stats row; every other key continues through
   `renderExtensionStatusLines()` exactly as before, so MCP and other extension statuses
   are unaffected.

Nothing else in pi-open-tui is touched. Pi loads the package's TypeScript source directly
(`package.json` → `"pi": { "extensions": ["./extensions/open-tui/index.ts"] }`), so there
is no build step — editing the installed source file is sufficient.

## Applying

```bash
~/pi-ollama-usage/patches/apply-open-tui-patch.sh
```

The script:

- reads the installed version from
  `~/.pi/agent/npm/node_modules/pi-open-tui/package.json`
- tries the `pi-open-tui-<version>-footer.patch` files newest-first and applies the first
  one that fits (`git apply`, falling back to `patch -p1`)
- is idempotent — if the patch is already in place it prints
  `Footer patch already applied — nothing to do.` and exits 0

**Restart pi afterwards**; the change takes effect on the next launch.

## Why the placement "moves back" over time

pi-open-tui is installed as an npm package, so **any update rewrites its `node_modules`
copy and silently wipes the patch**. The symptom is the indicator suddenly back on the
extension-status line at the bottom of the footer — and without the patch, the footer
also strips the extension's ANSI escapes (`sanitizeStatus()`), so no colors either.

**Self-heal:** pi-ollama-usage's `session_start` hook now runs this same script
automatically whenever the installed footer no longer carries the patch marker
(`statsInline`), so after a pi-open-tui update the patch is restored on the next pi
launch (restart pi once more to load the patched footer). It only notifies when it
actually re-applied something, and stays silent in non-interactive (`pi -p`/JSON) modes.
The same check is available on demand as `/ollama-usage patch`.

Manual fix:

```bash
~/pi-ollama-usage/patches/apply-open-tui-patch.sh
```

If the script instead reports
`No footer patch applies to pi-open-tui <version>.`, that release changed the footer
code enough that no existing patch fits, and a new one must be regenerated (next
section).

## Regenerating the patch for a new pi-open-tui version

Patches are deliberately version-specific and named
`pi-open-tui-<version>-footer.patch`. When a pi-open-tui release no longer matches any
patch here, make a new one:

1. Note the installed version:

   ```bash
   sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' \
     ~/.pi/agent/npm/node_modules/pi-open-tui/package.json
   ```

2. Save a pristine copy of the file to diff against:

   ```bash
   cp ~/.pi/agent/npm/node_modules/pi-open-tui/extensions/open-tui/footer.ts \
     /tmp/footer-pristine.ts
   ```

3. Re-apply the three modifications listed above to the installed file. Use the newest
   existing patch here as the reference implementation. The anchor points have been
   stable between versions so far:
   - end of `renderContextBar()` / start of `renderStatsBlock()` — insert the
     `colorizeStatText()` helper and add the `extraStats` parameter
   - bottom of `renderStatsBlock()` (`return stats.join(...)`) — insert the
     extra-stats loop
   - `const segments = config.footerSegments;` — insert the `stats:*` split
     (`statsInline` vs `regularStatuses`)
   - `renderExtensionStatusLines(theme, footerData.getExtensionStatuses(), …)` —
     pass `regularStatuses` instead
   - `renderStatsBlock(theme, totals, glyphs, segments, …)` call site — pass `statsInline`

4. Generate the diff with `a/`/`b/` path labels so `git apply -p1` works from the
   package root:

   ```bash
   mkdir -p /tmp/pt/a/extensions/open-tui /tmp/pt/b/extensions/open-tui
   cp /tmp/footer-pristine.ts /tmp/pt/a/extensions/open-tui/footer.ts
   cp ~/.pi/agent/npm/node_modules/pi-open-tui/extensions/open-tui/footer.ts \
     /tmp/pt/b/extensions/open-tui/footer.ts
   cd /tmp/pt
   diff -u a/extensions/open-tui/footer.ts b/extensions/open-tui/footer.ts \
     > ~/pi-ollama-usage/patches/pi-open-tui-<version>-footer.patch
   ```

5. Verify against a pristine copy — **not** the live one, which is already patched:

   ```bash
   mkdir -p /tmp/ptverify/extensions/open-tui
   cp /tmp/footer-pristine.ts /tmp/ptverify/extensions/open-tui/footer.ts
   cd /tmp/ptverify
   git apply --check ~/pi-ollama-usage/patches/pi-open-tui-<version>-footer.patch
   git apply ~/pi-ollama-usage/patches/pi-open-tui-<version>-footer.patch
   diff -q extensions/open-tui/footer.ts \
     ~/.pi/agent/npm/node_modules/pi-open-tui/extensions/open-tui/footer.ts
   ```

   The final `diff -q` must report no differences. A TypeScript parse-check of the
   patched file (e.g. transpiling it with `tsc`) is a cheap extra safety net before
   touching the live install.

Keep old patch files when you add a new one — the apply script tries newest-first and
only the file matching the installed version will fit, so old files cost nothing and
document the history.

## Version history

| pi-open-tui | Patch file | Notes |
| --- | --- | --- |
| 0.3.0 | `pi-open-tui-0.3.0-footer.patch` | First version of the patch |
| 0.3.4 | `pi-open-tui-0.3.4-footer.patch` | Regenerated after an auto-update to 0.3.4 wiped the 0.3.0 patch from `node_modules`; identical behavior |
| 0.3.6 | `pi-open-tui-0.3.6-footer.patch` | Regenerated after an auto-update to 0.3.6 wiped the patch again; identical behavior (the 0.3.4 patch also still applies) |
| 0.3.8 | `pi-open-tui-0.3.8-footer.patch` | Regenerated after an auto-update to 0.3.8 wiped the patch; identical behavior. The 0.3.6 patch no longer applies — 0.3.8 restructured footer rendering (`fitInlineLine`/`alignRight` for the stats row, `segments.extensionStatuses` now conditional), so the anchors moved. The inlined stats participate in the inline fit/truncation like the built-in segments |
