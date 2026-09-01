# pi-ollama-usage

A [Pi](https://pi.dev/) extension that shows your [Ollama Cloud](https://ollama.com) quota usage in the **footer status line**:

```text
Ollama 5h:3% Wk:0.5%
```

Uses the authenticated `GET https://ollama.com/api/usage` surface with your Ollama Cloud API key — the same data as the [ollama.com/settings](https://ollama.com/settings) dashboard:

- **5-hour rolling session window**
- **7-day rolling weekly window**
- per-model request counts and 4-week activity cost (via `/ollama-usage`)

The indicator only appears while an Ollama Cloud model is active (provider `ollama-cloud`, or the built-in `ollama` provider with a `:cloud` model).

## Install

```bash
pi install git:github.com/m-mostafa_euronet/pi-ollama-usage
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

- `/ollama-usage` — one-shot full usage report (5h + weekly windows, per-model request counts, 4-week activity cost)
- `/ollama-usage status` — show whether the footer indicator is on/off
- `/ollama-usage status on|off` — enable/disable the footer indicator (on by default)
- `/ollama-auth` — interactive auth TUI:
  - **Test current credential** — live check against `ollama.com/api/usage`, shows current usage if it works
  - **Set / update API key** — paste a key, it is validated live, then saved to `~/.pi/agent/auth.json` (file mode tightened to 0600)
  - **Remove stored key** — deletes the `ollama` / `ollama-cloud` entries from `auth.json` (env vars and Pi provider auth untouched)

In non-interactive modes (`pi -p`, JSON/RPC), `/ollama-auth` prints the active credential as text instead of opening dialogs.

## Behavior

- Refreshes on session start, model switch, and after turns — rate-limited to at most once per minute.
- Hides automatically when you switch away from a cloud model, when no API key is available, or on API errors (footer is cosmetic; errors surface only in `/ollama-usage`).
- Fetches are bounded: 15s timeout, no redirects, malformed/oversized responses are rejected.

## License

MIT