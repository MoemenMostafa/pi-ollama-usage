# pi-ollama-usage

A [Pi](https://pi.dev/) extension that shows your [Ollama Cloud](https://ollama.com) quota usage in the **footer status line**:

```text
Mo:$4.07 left
```

`$4.07` is the **remaining usage credit** — included (plan) credit plus
purchased top-up credit, straight from `GET /api/balance`, the same numbers the
ollama.com settings page renders. There is no percentage, and the balance is
never derived from spend: the quota period is **not** a calendar month (it runs
from the subscription date, e.g. Oct 2 → Nov 2), so "this month's spend" is a
different quantity entirely.

Colors: green while the included allowance is healthy, yellow once it is spent
(running on purchased credit), red when under 10% of the allowance — or nothing
— is left. When `/api/balance` cannot be read, the indicator falls back to the
30-day spend (`Mo:$70.94 used`) rather than inventing a balance. Set `NO_COLOR`
to disable colors.

Uses the authenticated `GET https://ollama.com/api/usage` surface with your Ollama Cloud API key — the same data as the [ollama.com/settings](https://ollama.com/settings) dashboard. What that API actually exposes (verified 2026-11-01):

- **Exact consumption** — `totals.usage_usd` in dollars, plus `request_count`
  and input/cached/output tokens; `buckets[]` breaks the same numbers down per
  day. Only three windows exist: `range=24h`, `7d`, `30d` (anything else is
  rejected with `range must be 24h, 7d, or 30d`).
- **Month-to-date is computed, not reported** — the quota resets per calendar
  month, but the API only offers rolling windows. The extension sums the daily
  buckets whose `from` is on/after the 1st of the current month, which is exact
  (the 30d window always reaches past it).
- **The balance** — `GET https://ollama.com/api/balance` returns the account's
  real remaining credit: `included.balance_usd` + `included.allowance_usd` for
  the current period (`included.period.from` / `.until`) and
  `purchased.balance_usd` for top-ups. This is the only correct source for
  "how much is left": spend in the usage API is bucketed per rolling window and
  the quota period is a rolling period from the subscription date, not a
  calendar month, so `allowance − this-month-spend` is not the balance (it can
  read ~$59 while the real balance is ~$4 and the allowance is already spent).
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
- Output is color-coded by the balance (footer indicator and `/ollama-usage` report): green while included credit is healthy, yellow once the included allowance is spent (purchased credit only), red under 10% of the allowance or when nothing is left. `NO_COLOR` disables colors.
- `Mo:$x.xx left` is `included.balance_usd + purchased.balance_usd` from `/api/balance`. If that call fails the indicator shows the 30-day spend (`Mo:$70.94 used`) — never a percentage, and never a balance derived from a billing window the API does not report.
- `/ollama-usage` prints `Balance: $4.07 left — included $0.00 of $60.00 · purchased $4.07 (Oct 2 – Nov 2)` plus the 30-day spend, request count and token totals.
- Hides automatically when you switch away from a cloud model, when no API key is available, or on API errors (footer is cosmetic; errors surface only in `/ollama-usage`).
- Fetches are bounded: 15s timeout, no redirects, malformed/oversized responses are rejected.

## License

MIT
