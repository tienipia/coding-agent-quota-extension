# Latest Claude Code / Codex compatibility — design

Date: 2026-07-25
Verified against: Claude Code 2.1.220, Codex CLI 0.145.0 (stable) / 0.146.0-alpha.3.1 (VS Code), live API probes on this machine.

## Problem

**Codex ≥ 0.145.0-alpha.27 stopped writing `token_count` events (and their `rate_limits`
block) into `~/.codex/sessions/**/*.jsonl`.** Verified: a 07-21 rollout written by
0.145.0-alpha.18 contains 535 such events; 07-25 rollouts written by alpha.27 and
0.146.0-alpha.3.1 contain zero, and no other file under `~/.codex` (sqlite DBs,
history.jsonl, session_index.jsonl) carries rate-limit data. The extension's entire
Codex pipeline is dead on current versions — it is coasting on week-old session files
and goes permanently dark once those age past the 7-day cutoff.

**Claude Code's endpoint is unchanged but the response evolved.** New authoritative
`limits[]` array (`{kind, group, percent, severity, resets_at, scope, is_active}`)
including a per-model weekly entry (`weekly_scoped`, `scope.model.display_name:
"Fable"`) that the current top-level-key iteration never renders — the legacy
`seven_day_opus`/`seven_day_sonnet` keys are now null. Window objects gained
`limit_dollars/used_dollars/remaining_dollars`; a raft of experimental null keys
appeared (`tangelo`, `nimbus_quill`, …) which the existing null-guard already skips.

## Verified facts (live probes)

- `GET https://chatgpt.com/backend-api/codex/usage`
  - `Authorization: Bearer <~/.codex/auth.json .tokens.access_token>` — HTTP 200.
  - **A real `User-Agent` header is mandatory** — Cloudflare returns 403 without one.
    A neutral `coding-agent-quota/0.2` UA works; `originator` and
    `chatgpt-account-id` headers are optional (200 without them). We still send
    `chatgpt-account-id` when present — it selects the workspace on team accounts.
  - Response: `plan_type`, `rate_limit.{primary_window,secondary_window}` each
    `{used_percent, limit_window_seconds, reset_after_seconds, reset_at(unix-sec)}`,
    `additional_rate_limits[] {limit_name, rate_limit}`, `rate_limit_reached_type`,
    `credits`, `spend_control`.
  - **Windows are plan-dependent**: on `prolite` the primary window is weekly
    (604800 s) and secondary is null. Labels must derive from
    `limit_window_seconds`, not from primary=5h/secondary=weekly assumptions.
- Codex access token is a 10-day JWT (`exp` − `iat` = 240 h), refreshed by the
  CLI on use. Same manual-refresh model as Claude: on expiry show
  ``token expired — run `codex` to refresh`` and fall back to cache.
- New-format session logs carry **no token-usage info at all** (`last_token_usage` /
  `total_token_usage` are gone) — the `Context · last turn` and `Σ tokens` popup
  rows are unrecoverable and must be removed.
- `~/.claude/.credentials.json` shape unchanged (`accessToken`, `expiresAt`,
  `rateLimitTier`, `subscriptionType` intact).

## Design

### A. Codex: switch to the usage API (mirror of the Claude path)

New `getCodexUsage(session, force)` with the exact semantics of `getClaudeUsage`:
cache file `~/.cache/coding-agent-quota/codex_usage.json` (`{fetched_at, usage}`),
15-min TTL, `Refresh now` bypass, 429 → `Retry-After` backoff via module-level
`_codexBackoffUntil`, JWT-`exp` precheck → expiry message + cache fallback, network
failure → cache fallback + orange `refresh failed: …` line. Auth loader reads
`auth.json`; missing `tokens.access_token` (e.g. API-key mode) → `Not configured`.

Popup rows: `primary_window`/`secondary_window` labeled by `limit_window_seconds`
(18000 → "5 hours", 604800 → "Weekly", else humanized), reset from `reset_at`
(fallback `now + reset_after_seconds`); one row per `additional_rate_limits[]`
entry labeled by `limit_name`. Warnings: `rate_limit_reached_type` non-null,
`spend_control.reached`. Header meta: `plan_type · cached Xm`. Panel % = worst of
primary/secondary `used_percent` (additional model-scoped limits excluded, matching
the Claude panel's main-windows-only convention); auth/network errors now show `!`
on the Codex side too (previously impossible — file reads couldn't fail that way).

### B. Claude: prefer `limits[]`, keep legacy fallback

When `usage.limits` is a non-empty array, render rows from it: kind `session` →
"5 hours", `weekly_all` → "Weekly", `weekly_scoped` → "Weekly · <scope.model.
display_name>"; unknown kinds → kind with underscores spaced (same forward-compat
posture as before). Panel % = max over all `limits[].percent` (a per-model weekly
at 90% should color the panel). When `limits` is absent (older cached responses),
the existing KNOWN_WINDOWS + dynamic-extras iteration runs unchanged. `severity`
and `is_active` are ignored for now — client-side thresholds stay authoritative.
`extra_usage` handling is untouched (null-safe against the new subfields).

### C. Cleanup + docs + probe

Delete the dead JSONL machinery (~150 lines: tail-read, `parseTokenCount`,
`scanCodexFile`, `getOrScanCodexFile`, `readCodexLatest`, `_codexFileCache`,
related constants and now-unused `Gio._promisify` entries, `fmtTokens`). Update
CLAUDE.md / AGENTS.md / README.md data-source sections. Add `tools/usage-probe.js`
(gjs + Soup) that exercises both endpoints with the extension's exact headers and
asserts response-shape invariants — the empirical regression test for the next
format drift.

## Alternatives rejected

- **Keep the JSONL walk as a fallback.** The API is server-side and
  version-independent, so it also serves users pinned to older CLIs; API-key-mode
  users never had `rate_limits` in their JSONL either. Keeping it preserves the
  200 MB-file/tail-read complexity for zero coverage gain.
- **Generic shared usage-getter for both services.** Saves ~40 duplicated lines
  but couples the two flows and would touch the working Claude path; two explicit
  mirrored functions are more reviewable and keep Claude regression risk at zero.

## Testing

curl probes of both endpoints (done, shapes captured), `node --check` /parse
validation, `tools/usage-probe.js` run via gjs to validate the Soup code path
end-to-end, then user-side logout/login (Wayland reload constraint) for the
visual check. The install dir is currently a **symlink to this repo** — editing
in place is the deploy; `gnome-extensions install` must NOT be run (it would
destroy the symlink target per CLAUDE.md).
