# pi-ollama-usage

A [Pi](https://pi.dev/) extension that shows your [Ollama Cloud](https://ollama.com) quota usage in the **footer status line**:

```text
Mo:13.2%
```

Labels are dimmed and each percentage is color-coded by usage stress — green below 70%, yellow from 70%, red from 90% of the window. Set `NO_COLOR` to disable colors.

Uses the authenticated `GET https://ollama.com/api/usage` surface with your Ollama Cloud API key — the same data as the [ollama.com/settings](https://ollama.com/settings) dashboard:

- **Monthly quota window** — Ollama retired the rolling 5h/weekly percent
  windows in Oct 2026 in favor of a monthly dollar-based allowance
  (`limits.monthly.usage` is reported as a 0–1 ratio)
- per-model request counts and 4-week activity cost (via `/ollama-usage`)
- the dollar limit itself ($X of $Y) is not part of the API response, so the
  extension shows percentages only

The indicator only appears while an Ollama Cloud model is active (provider `ollama-cloud`, or the built-in `ollama` provider with a `:cloud` model).

## Install

```bash
pi install git:github.com/MoemenMostafa/pi-ollama-usage
```

(An npm package may follow; until then install from git.)

## Setup

Works out of the box if you are signed in to the Ollama app/CLI (`ollama signin`) —
the extension reuses the local daemon's signed identity (`~/.ollama/id_ed25519`),
the same one used for cloud model requests. No API key needed.

Alternatively, create an API key at [ollama.com/settings/keys](https://ollama.com/settings/keys) and make it available in one of these ways (checked in order):

1. Pi provider auth — `/login ollama` or an `ollama-cloud` entry from [pi-ollama-cloud](https://github.com/fgrehm/pi-ollama-cloud)
2. `OLLAMA_API_KEY` environment variable (e.g. in `~/.zshrc`: `export OLLAMA_API_KEY=...`)
3. `~/.pi/agent/auth.json` → `{ "ollama-cloud": { "type": "api-key", "key": "..." } }` or the same under `"ollama"`

## Commands

- `/ollama-usage` — one-shot full usage report (monthly window, per-model request counts, 4-week activity cost)
- `/ollama-usage status` — show whether the footer indicator is on/off
- `/ollama-usage status on|off` — enable/disable the footer indicator (on by default)
- `/ollama-usage patch` — re-run the pi-open-tui footer-patch self-heal manually (normally runs automatically at every pi launch)
- `/ollama-auth` — interactive auth TUI:
  - **Test current credential** — live check against `ollama.com/api/usage`, shows current usage if it works
  - **Set / update API key** — paste a key, it is validated live, then saved to `~/.pi/agent/auth.json` (file mode tightened to 0600)
  - **Remove stored key** — deletes the `ollama` / `ollama-cloud` entries from `auth.json` (env vars and Pi provider auth untouched)

In non-interactive modes (`pi -p`, JSON/RPC), `/ollama-auth` prints the active credential as text instead of opening dialogs.

## Footer placement with pi-open-tui

If you use the [pi-open-tui](https://github.com/OldSuns/pi-open-tui) TUI, the indicator defaults to the extension-status line below the footer. To inline it into the footer's stats row instead, apply the bundled patch:

```bash
~/pi-ollama-usage/patches/apply-open-tui-patch.sh
```

**Self-healing after updates:** pi-open-tui updates rewrite `node_modules` and silently wipe the patch — which is what colors the indicator. The extension therefore checks for the patch on every pi launch (`session_start` hook) and re-applies the bundled patch automatically when it is missing, telling you once to restart pi. This works from a repo checkout (the published package does not ship `patches/`); `/ollama-usage patch` runs the same check on demand.

The script is idempotent, tries version-specific patches newest-first, and tells you when the installed pi-open-tui version needs a regenerated patch. See [patches/README.md](patches/README.md) for how the patch works, why the placement regresses after updates, and step-by-step regeneration instructions.

## Behavior

- Refreshes on session start, model switch, and after turns — rate-limited to at most once per minute.
- Output is color-coded by usage stress (footer indicator and `/ollama-usage` report): green below 70%, yellow from 70%, red from 90%. `NO_COLOR` disables colors.
- Hides automatically when you switch away from a cloud model, when no API key is available, or on API errors (footer is cosmetic; errors surface only in `/ollama-usage`).
- Fetches are bounded: 15s timeout, no redirects, malformed/oversized responses are rejected.

## License

MIT
