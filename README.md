# pi-ollama-usage

A [Pi](https://pi.dev/) extension that shows your [Ollama Cloud](https://ollama.com) quota usage in the **footer status line**:

```text
Mo:$59.28 left
```

`$59.28` is how much of the plan's monthly usage credit is **left**: the
allowance minus the **exact** month-to-date spend. There is no percentage — the
share of the allowance disagreed with the dashboard whenever the plan mapping
was off, and the remaining dollars are the number that matters. Labels are
dimmed and the figure is color-coded by how much is left — green above 30% of
the allowance, yellow below 30%, red below 10%. While the plan (and therefore
its allowance) is unknown, the indicator falls back to the month-to-date spend
(`Mo:$0.72 used`). Set `NO_COLOR` to disable colors.

Uses the authenticated `GET https://ollama.com/api/usage` surface with your Ollama Cloud API key — the same data as the [ollama.com/settings](https://ollama.com/settings) dashboard. What that API actually exposes (verified 2026-11-01):

- **Exact consumption** — `totals.usage_usd` in dollars, plus `request_count`
  and input/cached/output tokens; `buckets[]` breaks the same numbers down per
  day. Only three windows exist: `range=24h`, `7d`, `30d` (anything else is
  rejected with `range must be 24h, 7d, or 30d`).
- **Month-to-date is computed, not reported** — the quota resets per calendar
  month, but the API only offers rolling windows. The extension sums the daily
  buckets whose `from` is on/after the 1st of the current month, which is exact
  (the 30d window always reaches past it).
- **The plan** — `POST https://ollama.com/api/me` returns `Plan` (`pro`, `max`,
  `team`, …) and nothing else about billing; the older `limits` block is gone
  from `/api/usage`. So the *allowance* is the one number the API does not
  expose: it comes from `PLAN_CREDITS` in `extensions/index.ts`. To calibrate it
  against the dashboard, read `allowance = dollars ÷ dashboard percentage`
  (e.g. `$70.71 at 70%` → `≈ $101`) and put that number in the table.
- Per-model request counts and 30-day activity cost (via `/ollama-usage`).

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
- `/ollama-auth` — interactive auth TUI:
  - **Test current credential** — live check against `ollama.com/api/usage`, shows current usage if it works
  - **Set / update API key** — paste a key, it is validated live, then saved to `~/.pi/agent/auth.json` (file mode tightened to 0600)
  - **Remove stored key** — deletes the `ollama` / `ollama-cloud` entries from `auth.json` (env vars and Pi provider auth untouched)

In non-interactive modes (`pi -p`, JSON/RPC), `/ollama-auth` prints the active credential as text instead of opening dialogs.

## Footer placement

The indicator is a plain extension status (`ctx.ui.setStatus`), so it always renders on the
**extension-status line below the footer** — pi's built-in footer and
[pi-open-tui](https://github.com/OldSuns/pi-open-tui)'s footer alike. Its colors are kept
by pi-open-tui ≥ 0.4.0, which preserves extension ANSI styles.

It is deliberately **not** inlined into the host TUI's own stats row. That needed a local
patch of pi-open-tui's `footer.ts`, and the patch broke the TUI whenever pi-open-tui
touched that file (0.4.0 renamed the status sanitizer, and the stale patch made every
render throw `ReferenceError: sanitizeStatus is not defined`). No part of pi is patched
any more — see CHANGELOG 1.2.0.

## Behavior

- Refreshes on session start, model switch, and after turns — rate-limited to at most once per minute (Ollama answers `429 too many requests` if you poll harder than that).
- Output is color-coded by how much credit is left (footer indicator and `/ollama-usage` report): green above 30% of the allowance, yellow below 30%, red below 10%. `NO_COLOR` disables colors.
- `Mo:$x.xx left` is the plan allowance minus the exact calendar-month-to-date spend. When the plan is unknown the allowance is unknown too, so the indicator shows the spend instead (`Mo:$0.72 used`) — never a percentage.
- Hides automatically when you switch away from a cloud model, when no API key is available, or on API errors (footer is cosmetic; errors surface only in `/ollama-usage`).
- Fetches are bounded: 15s timeout, no redirects, malformed/oversized responses are rejected.

## License

MIT
