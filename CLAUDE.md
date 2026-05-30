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
```

## Data sources

### Claude Code — `https://api.anthropic.com/api/oauth/usage`

Reverse-engineered from the Claude Code binary (`~/.local/share/claude/versions/*`). Same endpoint the CLI's own `/usage` view hits — token-free (does not consume rate-limit budget).

Auth:
- `Authorization: Bearer <accessToken>` from `~/.claude/.credentials.json` → `claudeAiOauth.accessToken`
- `anthropic-beta: oauth-2025-04-20`
- Refresh on token expiry is not implemented; on expired token the indicator shows `!` and the popup explains. User runs `claude` once to refresh credentials manually.

Response shape (only the fields used):
```json
{
  "five_hour":        { "utilization": 8.0, "resets_at": "ISO-8601" },
  "seven_day":        { "utilization": 6.0, "resets_at": "ISO-8601" },
  "seven_day_opus":   null | { ... },
  "seven_day_sonnet": null | { ... },
  "extra_usage":      { "is_enabled": true, "used_credits": 0.0, "monthly_limit": 20000.0, "currency": "USD" }
}
```

Cached at `~/.cache/coding-agent-quota/claude_usage.json` with `fetched_at`. TTL is `CLAUDE_TTL_MS` (15 min). `Refresh now` menu item bypasses TTL.

On fetch failure (network error, 429, expired token, etc.) the popup falls back to the most recent cached `usage` and shows the error as a small orange `refresh failed: ...` line above the rows. A `429` response sets a module-level `_claudeBackoffUntil` from the `Retry-After` header (default 5 min if absent); subsequent calls before that timestamp skip the API entirely and return cache with a "rate-limited until HH:MM" message instead of hitting the endpoint again. Expired tokens (per `oauth.expiresAt`) also fall back to cache + "token expired — run `claude` to refresh" rather than blanking the panel.

The header meta shows the plan tier derived from `credentials.json` (`rateLimitTier` like `default_claude_max_20x` → "Max 20x"; falls back to `subscriptionType` like "max" → "Max"). The response carries window keys beyond the known set (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps`, `seven_day_cowork`, …) — `_renderClaude` iterates all keys with a `utilization` field, so server-side additions surface without code changes. Unknown keys render with their raw snake_case as the label.

### Codex — local session JSONL

Server pushes `rate_limits` inside `event_msg` events of type `token_count` straight into Codex's session log. We do not call any Codex API.

Walk: `~/.codex/sessions/**/*.jsonl` (only files with mtime within 7d). A module-level `_codexFileCache` (Map keyed by path) stores `{mtime, ts, rateLimits, info}` per file — unchanged files skip re-read entirely. New or modified files are read **tail-first** via `Gio.File.read_async` + `Gio.Seekable.seek` + `Gio.InputStream.read_bytes_async`, trying 64KB then 256KB before falling back to full-file load (`CODEX_TAIL_CHUNKS`). Most `token_count` events live in the last 64KB, so steady-state work is one small tail read per active session instead of hundreds of MB. After the walk, cache entries for paths no longer visible (rolled past 7d, deleted) are GC'd. The newest `token_count` across all files wins.

Shape:
```json
{
  "type": "event_msg",
  "timestamp": "ISO-8601",
  "payload": {
    "type": "token_count",
    "info": {
      "last_token_usage":     { "total_tokens": 227033, "input_tokens": ..., "cached_input_tokens": ..., "output_tokens": ..., "reasoning_output_tokens": ... },
      "total_token_usage":    { /* same shape, cumulative across the session */ },
      "model_context_window": 258400
    },
    "rate_limits": {
      "limit_id":   "codex",
      "limit_name": null,
      "primary":    { "used_percent": 17, "window_minutes": 300,   "resets_at": <unix-sec> },
      "secondary":  { "used_percent": 6,  "window_minutes": 10080, "resets_at": <unix-sec> },
      "credits":    null,
      "plan_type":  "prolite",
      "rate_limit_reached_type": null
    }
  }
}
```

`used_percent` is stale between Codex turns — reset times are still authoritative. When the snapshot's `primary.resets_at` is in the past (5-hour window has reset since the snapshot was captured), the popup shows an orange `snapshot stale — run \`codex\` to update` warning. `rate_limit_reached_type` (when non-null) renders as a second orange warning. `fmtAge` formats ages over 24h as `Xd Yh` so a 5-day-old snapshot reads `4d 22h` instead of `118h32m`.

The `info` block surfaces as two extra popup lines: a `Context · last turn` progress row (`last_token_usage.total_tokens / model_context_window`) and a small grey `Σ N tokens · cache X% · reasoning Y` footer derived from `total_token_usage`.

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

Code changes therefore require **log out → log in** (or full reboot) on Wayland. On X11 you can `Alt+F2 → r`. For dev iteration, `dbus-run-session -- gnome-shell --nested --wayland` opens a nested shell that can be killed/reloaded freely without affecting the main session.

## Async I/O contract

All file I/O goes through `Gio._promisify`-wrapped async methods (`load_contents_async`, `replace_contents_async`, `enumerate_children_async`, `next_files_async`, `query_info_async`, `read_async`, `read_bytes_async`). The synchronous variants are forbidden by EGO review (rule EGO-X-004). The Codex JSONL walk uses paged `next_files_async(50, ...)` to avoid holding a huge file-info array, and tail-reads large session files via `read_async` + `seek` (sync, on the returned `Gio.FileInputStream`) + `read_bytes_async`.

## Gotchas

- **SVG icons via `Gio.FileIcon` do not inherit CSS color.** `currentColor` renders as black (rsvg default) regardless of parent `color`. Workaround: `_preloadGicons` reads each SVG, replaces `currentColor` with `#ffffff`, wraps the bytes in a `Gio.BytesIcon` (no on-disk cache file). Hardcoded colors in the SVG (e.g. Anthropic coral) are kept as-is and skip baking.

- **`load_contents_async` returns `[contents, etag]` (2-tuple) when promisified.** The sync variant returns 3-tuple `[ok, contents, etag]`. Don't confuse them.

- **Async refresh after `destroy`.** Soup callbacks and pending awaits can fire after `disable()`. Guarded with `this._destroyed` flag set in `destroy()`, checked at the start of `_refresh` and after each major `await`. Soup session is also `abort()`ed in destroy.

- **Async setup races with `enable()`.** `_init` is sync (GObject constraint). We kick off `_setupAsync()` fire-and-forget; the panel briefly shows a `…` placeholder until icons preload + first refresh complete. Preload and first refresh are each try/caught so a transient failure still installs the refresh timer — the next 60s tick retries (and `_refresh` also re-tries `_preloadGicons` when `_gicons` is empty), preventing a permanent placeholder.

- **Codex JSONL files can exceed 200MB.** A live session log grew to 212MB in the field; naive `load_contents_async` + `text.split('\n')` per refresh blocked the shell main loop. The walk now caches `(path, mtime) → result`, so unchanged files skip re-read entirely. Modified files are read tail-first (64KB → 256KB → full) so steady-state work for a 200MB active session is one ~64KB read per refresh, not 200MB. `parseTokenCount` runs line-by-line with per-line `try/catch`, so a tail-truncated first line is safely skipped.

- **Use `St.BoxLayout` for progress bars, not `St.Bin`.** A fixed-width fill child inside an `St.Bin` renders centered in the track even with `x_align: Clutter.ActorAlign.START` set on the bin — Clutter still reconciles the child's default `x_align: FILL` with `set_width()` by centering the constrained allocation. `St.BoxLayout` (`orientation: Clutter.Orientation.HORIZONTAL`) packs the child from the start unambiguously.

- **`St.BoxLayout`'s `vertical: true/false` boolean was removed in GNOME Shell 50.** Use `orientation: Clutter.Orientation.HORIZONTAL` / `VERTICAL`. The shell's own JS migrated entirely — passing `vertical:` on 50 throws at construction. The `orientation` form works on 45+, so it's safe across the full supported range.

- **`Soup.Message.get_status()` throws on unknown HTTP codes.** GJS converts the return value to the `Soup.Status` enum, which only knows a fixed set of codes. A response like `429 Too Many Requests` fails with `"429 is not a valid value for enumeration Status"`. Use the raw `msg.status_code` property (uint) for comparisons and error messages instead.

- **The local `~/.local/share/gnome-shell/extensions/<uuid>/` may be a symlink to this repo or a real directory** depending on install method. `gnome-extensions install --force` always creates a real directory and (see Build/install above) **destroys the symlink target** in the process. To restore the symlink for in-place editing: `rm -rf <ext-dir> && ln -s <repo-path> <ext-dir>` — but symlinked source still needs shell restart to be picked up (same Wayland constraint).

## Visual structure

Panel widget (top bar):
```
[claude-icon] 17%   [codex-icon] 17%
```
Each pct is the **worst** of (5h, weekly) for that service. Color: green <50%, orange 50-80%, red ≥80%, red `!` on auth error. Services with missing credentials/sessions display `—` (not `!`) and the popup shows "Not configured".

Popup:
- Per-service header: icon + name + meta. Claude meta = `plan · cache age` (e.g. `Max 20x · cached 5m`); Codex meta = `snapshot age · plan_type` (e.g. `snapshot 12m · prolite`).
- One row per window: label + pct + horizontal progress bar (fixed `BAR_WIDTH = 180`) + reset timestamp & countdown. Claude iterates the response dynamically so newly-introduced server keys (e.g. `seven_day_cowork`) appear without a code change; the row label comes from `KNOWN_WINDOWS` lookup with the raw key as fallback.
- Codex adds a `Context · last turn` progress row (no reset stamp) + a `Σ tokens · cache% · reasoning` footer when the server provides the `info` block.
- Warning lines (orange): `refresh failed: ...` (Claude fallback to cache), `snapshot stale — run \`codex\` to update`, `rate limit reached (...)`.
- Severity classes applied to both pct text and bar fill.
- `Refresh now` action item at bottom.

## Conventions

- Single-file extension: do not split into multiple JS modules unless necessary. Static `import` graphs make the Wayland reload problem worse — fewer modules means fewer cached entries.
- Standalone helpers (file I/O, formatters, builders without `this`) live as top-level functions.
- Functions needing `extPath` (icon loading, cache paths involving extension dir) are methods on `QuotaIndicator`.
- No external npm/build pipeline; ship JS as written.
- All file I/O is async per EGO review rules.
