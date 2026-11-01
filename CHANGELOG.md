# Changelog

## [1.3.0] — 2026-11-01

### Changed

- **The indicator shows credits LEFT, not a percentage**: `Mo:$59.28 left` — the plan
  allowance minus the exact month-to-date spend. The percentage is gone everywhere
  (footer, `/ollama-usage`, `/ollama-auth`), because the share of the allowance was
  wrong whenever the plan mapping was off and it was never the number that matters.
- Colors follow the credit that is left: green above 30% of the allowance, yellow below
  30%, red below 10% (previously the used-share thresholds 70%/90%).
- `/ollama-usage` reads `This month: $59.28 left of $60.00 credit · $0.72 used`.

### Fixed

- When the plan is unknown the footer no longer implies anything about the allowance: it
  shows `Mo:$0.72 used` instead of a percentage of an unknown credit.

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
