# Changelog

## [1.2.0] — 2026-11-01

### Added

- **Exact dollars in the indicator**: `Mo:$0.72 1.2%` — the month-to-date spend is
  summed from the API's daily buckets (the only exact source; the API has no
  billing-period window), and the share of the plan credit follows when the plan is
  known (from `POST /api/me` → `Plan` mapped through `PLAN_CREDITS`).
- `/ollama-usage` reports `This month: $0.72 · 1.2% of $60 credit` with requests and
  input/cached/output tokens, then the 30-day activity total.

### Fixed

- The percentage no longer uses the rolling 30-day total as if it were the current
  month: on the 1st of a month that reported last month's whole spend (`Mo:117.2%`
  while the real month-to-date was $0.70).

### Changed

- The footer indicator is a **plain extension status** again: it renders on the
  extension-status line below the footer in pi's built-in TUI and in pi-open-tui
  (`ctx.ui.setStatus("pi-ollama-usage", …)`). It is no longer inlined into pi-open-tui's
  stats row.
- Dropped the `stats:` status-key prefix and the whole footer-patch machinery
  (`patches/`, the `session_start` self-heal, `/ollama-usage patch`). Patching
  pi-open-tui's `footer.ts` from `node_modules` was the cause of a TUI freeze: after
  pi-open-tui 0.4.0 renamed the status sanitizer, the stale 0.3.8 patch was still applied
  and every footer render threw `ReferenceError: sanitizeStatus is not defined`.
- Nothing in `node_modules` is patched any more; the installed `pi-open-tui` stays
  pristine across updates.

## [1.1.0] — 2026-10

### Changed

- Monthly dollar-based quota (Ollama retired the 5-hour/weekly percent windows):
  `Mo:<pct>` indicator, per-model request counts, 4-week activity cost.

## [1.0.0] — 2026-09

- First release: `/ollama-usage`, `/ollama-auth`, stress-colored footer indicator,
  API-key and local-daemon signed-credential support.
