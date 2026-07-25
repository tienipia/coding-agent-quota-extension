# coding-agent-quota@tienipia.github.io

GNOME Shell extension that displays Claude Code and Codex (OpenAI) token rate-limit usage (5-hour and weekly windows) in the top panel. License: MIT.

## Layout

```
extension.js          # single-file module: data + UI + lifecycle
metadata.json         # uuid=coding-agent-quota@tienipia.github.io, shell-version 45-50
stylesheet.css        # panel + popup theming, progress-bar colors
icons/
  claude-symbolic.svg # Anthropic asterisk, color baked (coral)
  codex-symbolic.svg  # OpenAI blossom, uses currentColor (recolored at runtime)
tools/
  usage-probe.js      # gjs -m tools/usage-probe.js — live-probes both usage APIs
                      # with the extension's exact headers; run after CLI updates
```

## Data sources

### Claude Code — `https://api.anthropic.com/api/oauth/usage`

Reverse-engineered from the Claude Code binary (`~/.local/share/claude/versions/*`). Same endpoint the CLI's own `/usage` view hits — token-free (does not consume rate-limit budget).

Auth:
- `Authorization: Bearer <accessToken>` from `~/.claude/.credentials.json` → `claudeAiOauth.accessToken`
- `anthropic-beta: oauth-2025-04-20`
- Refresh on token expiry is not implemented; on expired token the indicator shows `!` and the popup explains. User runs `claude` once to refresh credentials manually.

Response shape (only the fields used; verified against Claude Code 2.1.220, 2026-07):
```json
{
  "limits": [
    { "kind": "session",       "group": "session", "percent": 11, "severity": "normal",
      "resets_at": "ISO-8601", "scope": null, "is_active": true },
    { "kind": "weekly_all",    "group": "weekly",  "percent": 5,  "resets_at": "ISO-8601", "scope": null },
    { "kind": "weekly_scoped", "group": "weekly",  "percent": 10, "resets_at": "ISO-8601",
      "scope": { "model": { "display_name": "Fable" }, "surface": null } }
  ],
  "five_hour":        { "utilization": 8.0, "resets_at": "ISO-8601", "limit_dollars": null },
  "seven_day":        { "utilization": 6.0, "resets_at": "ISO-8601" },
  "seven_day_opus":   null,
  "seven_day_sonnet": null,
  "extra_usage":      { "is_enabled": true, "used_credits": 0.0, "monthly_limit": 20000.0, "currency": "USD" }
}
```

`_renderClaude` prefers the `limits` array when it has entries with a non-null `percent` — it is authoritative and carries model-scoped weeklies (`weekly_scoped` + `scope.model.display_name`) that never appear as top-level window keys (the legacy `seven_day_opus`/`seven_day_sonnet` keys are now always null). Labels come from `KNOWN_LIMIT_KINDS` (`session` → "5 hours", `weekly_all` → "Weekly", `weekly_scoped` → "Weekly · <scope name>"); unknown kinds render with underscores spaced. `severity`/`is_active` are currently ignored — pct thresholds stay client-side. When `limits` is absent (older cached payloads), the legacy top-level window iteration runs instead. The response also carries a rotating set of experimental null window keys (`tangelo`, `nimbus_quill`, …) — the null-guard skips them.

Cached at `~/.cache/coding-agent-quota/claude_usage.json` with `fetched_at`. TTL is `CLAUDE_TTL_MS` (15 min). `Refresh now` menu item bypasses TTL.

On fetch failure (network error, 429, expired token, etc.) the popup falls back to the most recent cached `usage` and shows the error as a small orange `refresh failed: ...` line above the rows. A `429` response sets a module-level `_claudeBackoffUntil` from the `Retry-After` header (default 5 min if absent); subsequent calls before that timestamp skip the API entirely and return cache with a "rate-limited until HH:MM" message instead of hitting the endpoint again. Expired tokens (per `oauth.expiresAt`) also fall back to cache + "token expired — run `claude` to refresh" rather than blanking the panel.

The header meta shows the plan tier derived from `credentials.json` (`rateLimitTier` like `default_claude_max_20x` → "Max 20x"; falls back to `subscriptionType` like "max" → "Max").

### Codex — `https://chatgpt.com/backend-api/codex/usage`

The same backend endpoint the Codex CLI itself queries for `/status`. **Codex ≥ 0.145.0-alpha.27 stopped writing `token_count`/`rate_limits` events into `~/.codex/sessions/**/*.jsonl`** (verified: a rollout written by 0.145.0-alpha.18 carries 535 such events, alpha.27+/0.146 rollouts carry zero, and nothing else under `~/.codex` — sqlite DBs, history.jsonl — has rate-limit data), so the old session-log walk was removed entirely in favor of this API. The API is server-side and works regardless of the installed CLI version.

Auth (from `~/.codex/auth.json`, maintained by the `codex` CLI):
- `Authorization: Bearer <tokens.access_token>` — a ~10-day JWT; expiry is pre-checked by decoding the `exp` claim (`jwtExpMs`). On expiry: cache fallback + "token expired — run `codex` to refresh". No refresh flow, same policy as Claude.
- `chatgpt-account-id: <tokens.account_id>` — optional for personal accounts, selects the workspace on team accounts; sent when present.
- `User-Agent` — **mandatory**: chatgpt.com sits behind Cloudflare, which 403s UA-less requests. A neutral `coding-agent-quota/0.2` UA is accepted; no need to impersonate the CLI.
- Missing `tokens.access_token` (not logged in, or API-key-only auth) → "Not configured". API-key mode has no ChatGPT rate-limit windows at all.

Response shape (only the fields used; verified against Codex 0.145.0/0.146.0-alpha, 2026-07):
```json
{
  "plan_type": "prolite",
  "rate_limit": {
    "limit_reached": false,
    "primary_window":   { "used_percent": 2, "limit_window_seconds": 604800,
                          "reset_after_seconds": 351568, "reset_at": <unix-sec> },
    "secondary_window": null
  },
  "additional_rate_limits": [
    { "limit_name": "GPT-5.3-Codex-Spark", "metered_feature": "codex_bengalfox",
      "rate_limit": { "primary_window": { ... } } }
  ],
  "rate_limit_reached_type": null,
  "spend_control": { "reached": false },
  "credits": { "has_credits": false, ... }
}
```

**Windows are plan-dependent** — on `prolite` the primary window is weekly (604800 s) and `secondary_window` is null, so row labels derive from `limit_window_seconds` (`codexWindowLabel`: 18000 → "5 hours", 604800 → "Weekly", else humanized), never from primary/secondary position. Reset time prefers absolute `reset_at` (unix sec), falling back to `now + reset_after_seconds`. Each `additional_rate_limits[]` entry renders as an extra row labeled by its `limit_name`. Orange warnings: `rate_limit_reached_type` non-null, `spend_control.reached`.

Cached at `~/.cache/coding-agent-quota/codex_usage.json`; `CODEX_TTL_MS` (15 min), 429 → `Retry-After` backoff via `_codexBackoffUntil`, network-failure → cache fallback with `refresh failed: ...` — all mirroring the Claude flow (`getCodexUsage` is a deliberate structural mirror of `getClaudeUsage`; keep them in sync when touching either).

## Build / install

```bash
gnome-extensions pack . --force --out-dir=/tmp --extra-source=icons
gnome-extensions install --force /tmp/coding-agent-quota@tienipia.github.io.shell-extension.zip
gnome-extensions enable coding-agent-quota@tienipia.github.io   # only needed first time
```

`--extra-source=icons` is required — default `pack` only bundles `extension.js`, `metadata.json`, `stylesheet.css`, plus `schemas/` and `locale/`.

**DANGER — symlinked install dir:** if `~/.local/share/gnome-shell/extensions/<uuid>/` is currently a symlink to this repo, running `gnome-extensions install --force` will **delete the symlink target's contents** (the repo source files, including `.git/`). Before running install with a symlink in place, either:
- `rm` the symlink first (`rm ~/.local/share/gnome-shell/extensions/<uuid>`) so install operates on a fresh path, or
- skip install entirely and edit the repo in-place (the symlink already makes the shell load the repo files).

After install, recreate the symlink with `rm -rf <ext-dir> && ln -s <repo-path> <ext-dir>` for in-place editing.

## Wayland reload constraint (important)

**GNOME Shell on Wayland cannot fully reload an extension's JS without restarting the shell.** GJS holds the `import()`-loaded module in the SpiderMonkey context for the shell's lifetime. `gnome-extensions disable && enable` only calls lifecycle methods on the same cached module. The D-Bus `ReloadExtension` method exists but responds with "deprecated and does not work". `gnome-extensions install --force` overwrites disk files but does not reload the running module.

Code changes therefore require **log out → log in** (or full reboot) on Wayland. On X11 you can `Alt+F2 → r`. For dev iteration: **`gnome-shell --nested` was removed in GNOME Shell 50** — use `dbus-run-session -- gnome-shell --devkit` for a windowed dev shell, or a no-window smoke test that still loads/enables the extension and runs a real refresh:

```bash
timeout 40 dbus-run-session -- gnome-shell --headless --wayland --no-x11 --virtual-monitor 1024x768 2>&1 | grep -iE 'JS ERROR|coding-agent-quota'
```

(verify success via no JS ERROR lines + fresh mtimes on `~/.cache/coding-agent-quota/*.json`).

## Async I/O contract

All file I/O goes through `Gio._promisify`-wrapped async methods (`load_contents_async`, `replace_contents_async`). The synchronous variants are forbidden by EGO review (rule EGO-X-004). Both HTTP fetches share `sendJsonRequest` (Soup `send_and_read_async` → parsed JSON, with 429 `Retry-After` extraction), and the Soup session is constructed with `timeout: HTTP_TIMEOUT_SEC` so a hung connection cannot wedge the `_refreshing` flag forever.

## Gotchas

- **SVG icons via `Gio.FileIcon` do not inherit CSS color.** `currentColor` renders as black (rsvg default) regardless of parent `color`. Workaround: `_preloadGicons` reads each SVG, replaces `currentColor` with `#ffffff`, wraps the bytes in a `Gio.BytesIcon` (no on-disk cache file). Hardcoded colors in the SVG (e.g. Anthropic coral) are kept as-is and skip baking.

- **`load_contents_async` returns `[contents, etag]` (2-tuple) when promisified.** The sync variant returns 3-tuple `[ok, contents, etag]`. Don't confuse them.

- **Async refresh after `destroy`.** Soup callbacks and pending awaits can fire after `disable()`. Guarded with `this._destroyed` flag set in `destroy()`, checked at the start of `_refresh` and after each major `await`. Soup session is also `abort()`ed in destroy.

- **Async setup races with `enable()`.** `_init` is sync (GObject constraint). We kick off `_setupAsync()` fire-and-forget; the panel briefly shows a `…` placeholder until icons preload + first refresh complete. Preload and first refresh are each try/caught so a transient failure still installs the refresh timer — the next 60s tick retries (and `_refresh` also re-tries `_preloadGicons` when `_gicons` is empty), preventing a permanent placeholder.

- **chatgpt.com 403s requests without a `User-Agent`.** Cloudflare fronts the Codex usage endpoint; the identical request with any reasonable UA string succeeds. If Codex fetches ever start failing with `HTTP 403`, check the UA header first, not the token.

- **Use `St.BoxLayout` for progress bars, not `St.Bin`.** A fixed-width fill child inside an `St.Bin` renders centered in the track even with `x_align: Clutter.ActorAlign.START` set on the bin — Clutter still reconciles the child's default `x_align: FILL` with `set_width()` by centering the constrained allocation. `St.BoxLayout` (`orientation: Clutter.Orientation.HORIZONTAL`) packs the child from the start unambiguously.

- **`St.BoxLayout`'s `vertical: true/false` boolean was removed in GNOME Shell 50.** Use `orientation: Clutter.Orientation.HORIZONTAL` / `VERTICAL`. The shell's own JS migrated entirely — passing `vertical:` on 50 throws at construction. The `orientation` form works on 45+, so it's safe across the full supported range.

- **`Soup.Message.get_status()` throws on unknown HTTP codes.** GJS converts the return value to the `Soup.Status` enum, which only knows a fixed set of codes. A response like `429 Too Many Requests` fails with `"429 is not a valid value for enumeration Status"`. Use the raw `msg.status_code` property (uint) for comparisons and error messages instead.

- **The local `~/.local/share/gnome-shell/extensions/<uuid>/` may be a symlink to this repo or a real directory** depending on install method. `gnome-extensions install --force` always creates a real directory and (see Build/install above) **destroys the symlink target** in the process. To restore the symlink for in-place editing: `rm -rf <ext-dir> && ln -s <repo-path> <ext-dir>` — but symlinked source still needs shell restart to be picked up (same Wayland constraint).

## Visual structure

Panel widget (top bar):
```
[claude-icon] 17%   [codex-icon] 17%
```
Claude pct is the worst of all `limits[]` percents (legacy: worst of 5h/weekly); Codex pct is the worst of `primary_window`/`secondary_window` (model-scoped `additional_rate_limits` excluded from the panel worst-of). Color: green <50%, orange 50-80%, red ≥80%, red `!` on auth/fetch error (both services). Services with missing credentials display `—` (not `!`) and the popup shows "Not configured".

Popup:
- Per-service header: icon + name + meta, both `plan · cache age` (e.g. `Max 20x · cached 5m`, `Prolite · cached 2m`, or `· just now` after a live fetch).
- One row per window: label + pct + horizontal progress bar (fixed `BAR_WIDTH = 180`) + reset timestamp & countdown. Claude rows come from `limits[]` (fallback: legacy window keys via `KNOWN_WINDOWS`); Codex rows are `primary_window`/`secondary_window` labeled by window length, then one row per `additional_rate_limits[]` entry labeled by `limit_name`.
- Warning lines (orange, cache-fallback states): `refresh failed: ...`, ``token expired — run `claude`/`codex` to refresh`` (via refresh-failed line), `rate limit reached (...)`, `spend limit reached` (Codex).
- Severity classes applied to both pct text and bar fill.
- `Refresh now` action item at bottom.

## Conventions

- Single-file extension: do not split into multiple JS modules unless necessary. Static `import` graphs make the Wayland reload problem worse — fewer modules means fewer cached entries.
- Standalone helpers (file I/O, formatters, builders without `this`) live as top-level functions.
- Functions needing `extPath` (icon loading, cache paths involving extension dir) are methods on `QuotaIndicator`.
- No external npm/build pipeline; ship JS as written.
- All file I/O is async per EGO review rules.
