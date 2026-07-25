import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_async');

const REFRESH_SEC = 60;
const CLAUDE_TTL_MS = 15 * 60 * 1000;
const CODEX_TTL_MS = 15 * 60 * 1000;
const HTTP_TIMEOUT_SEC = 15;

const HOME = GLib.get_home_dir();
const CACHE_DIR = GLib.build_filenamev([
    GLib.get_user_cache_dir(), 'coding-agent-quota',
]);
const CLAUDE_CACHE_PATH = GLib.build_filenamev([CACHE_DIR, 'claude_usage.json']);
const CODEX_CACHE_PATH = GLib.build_filenamev([CACHE_DIR, 'codex_usage.json']);

const BAR_WIDTH = 180;
const PANEL_ICON_PX = 14;
const HEADER_ICON_PX = 18;

// Legacy top-level window keys (responses without a `limits` array, e.g. old
// cached payloads). Unknown keys fall through to the raw key so new
// server-side windows still surface (extension.js never crashes on them).
const KNOWN_WINDOWS = {
    five_hour:            '5 hours',
    seven_day:            'Weekly',
    seven_day_opus:       'Weekly · Opus',
    seven_day_sonnet:     'Weekly · Sonnet',
    seven_day_oauth_apps: 'Weekly · OAuth apps',
    seven_day_cowork:     'Weekly · Cowork',
};

// `limits[].kind` → display label; scoped limits get their scope name appended.
const KNOWN_LIMIT_KINDS = {
    session:       '5 hours',
    weekly_all:    'Weekly',
    weekly_scoped: 'Weekly',
};

let _claudeBackoffUntil = 0;
let _codexBackoffUntil = 0;

// ---------- async file helpers ----------

async function readText(path) {
    try {
        const f = Gio.File.new_for_path(path);
        const [contents] = await f.load_contents_async(null);
        return new TextDecoder().decode(contents);
    } catch {
        return null;
    }
}

async function writeText(path, text) {
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
        const f = Gio.File.new_for_path(path);
        const data = new TextEncoder().encode(text);
        await f.replace_contents_async(data, null, false, Gio.FileCreateFlags.PRIVATE, null);
    } catch (e) {
        console.error(`coding-agent-quota: writeText ${path} failed: ${e}`);
    }
}

async function loadJson(path) {
    const text = await readText(path);
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function saveUsageCache(path, usage) {
    return writeText(path, JSON.stringify({ fetched_at: Date.now(), usage }));
}

// Shared Soup response handler: resolves parsed JSON on 200, rejects with an
// Error otherwise; 429 responses carry `retryAfterMs` for backoff handling.
function sendJsonRequest(session, msg) {
    return new Promise((resolve, reject) => {
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (_, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                const status = msg.status_code;
                if (status !== 200) {
                    const err = new Error(`HTTP ${status}`);
                    if (status === 429) {
                        let retryAfter = null;
                        try {
                            retryAfter = msg.response_headers?.get_one('Retry-After');
                        } catch {}
                        const ms = parseRetryAfter(retryAfter);
                        err.retryAfterMs = ms != null ? ms : 5 * 60 * 1000;
                    }
                    reject(err);
                    return;
                }
                const text = new TextDecoder().decode(bytes.get_data());
                resolve(JSON.parse(text));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// ---------- Claude Code data ----------

async function loadClaudeOauth() {
    return (await loadJson(`${HOME}/.claude/.credentials.json`))?.claudeAiOauth ?? null;
}

function fetchClaudeUsage(token, session) {
    const msg = Soup.Message.new('GET', 'https://api.anthropic.com/api/oauth/usage');
    msg.request_headers.append('Authorization', `Bearer ${token}`);
    msg.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
    msg.request_headers.append('Content-Type', 'application/json');
    msg.request_headers.append('User-Agent', 'coding-agent-quota/0.2');
    return sendJsonRequest(session, msg);
}

async function getClaudeUsage(session, force = false) {
    const cache = await loadJson(CLAUDE_CACHE_PATH);
    const now = Date.now();
    const oauth = await loadClaudeOauth();

    const cacheHit = msg => cache?.usage ? {
        usage: cache.usage, fetchedAt: cache.fetched_at,
        fromCache: true, oauth, ...(msg ? { fetchError: msg } : {}),
    } : null;

    if (!force && cache?.usage && now - cache.fetched_at < CLAUDE_TTL_MS) {
        return cacheHit(null);
    }

    if (!oauth?.accessToken) return { notConfigured: true };

    if (oauth.expiresAt && now > oauth.expiresAt) {
        const msg = 'token expired — run `claude` to refresh';
        const hit = cacheHit(msg);
        if (hit) return hit;
        throw new Error(msg);
    }

    if (now < _claudeBackoffUntil) {
        const msg = `rate-limited until ${fmtTime(new Date(_claudeBackoffUntil))}`;
        const hit = cacheHit(msg);
        if (hit) return hit;
        throw new Error(msg);
    }

    try {
        const usage = await fetchClaudeUsage(oauth.accessToken, session);
        await saveUsageCache(CLAUDE_CACHE_PATH, usage);
        return { usage, fetchedAt: Date.now(), fromCache: false, oauth };
    } catch (e) {
        if (e.retryAfterMs != null) {
            _claudeBackoffUntil = Date.now() + e.retryAfterMs;
        }
        const hit = cacheHit(e.message ?? String(e));
        if (hit) return hit;
        throw e;
    }
}

// ---------- Codex data ----------

// Codex ≥ 0.145 no longer logs `token_count`/`rate_limits` events into session
// JSONL files; usage now comes from the same backend endpoint the CLI itself
// queries. Auth is the ChatGPT OAuth token that `codex` maintains in auth.json.

// JWT payloads are base64url without padding; GLib.base64_decode wants
// standard base64. Returns the `exp` claim in ms, or null if undecodable.
function jwtExpMs(token) {
    try {
        const part = token.split('.')[1];
        const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
            .padEnd(part.length + (4 - part.length % 4) % 4, '=');
        const claims = JSON.parse(new TextDecoder().decode(GLib.base64_decode(b64)));
        return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
    } catch {
        return null;
    }
}

// null when Codex is not logged in via ChatGPT (missing file or API-key-only
// auth) — there are no rate-limit windows to show in that mode.
async function loadCodexAuth() {
    const tokens = (await loadJson(`${HOME}/.codex/auth.json`))?.tokens;
    if (!tokens?.access_token) return null;
    return {
        accessToken: tokens.access_token,
        accountId: tokens.account_id ?? null,
        expiresAt: jwtExpMs(tokens.access_token),
    };
}

function fetchCodexUsage(auth, session) {
    const msg = Soup.Message.new('GET', 'https://chatgpt.com/backend-api/codex/usage');
    msg.request_headers.append('Authorization', `Bearer ${auth.accessToken}`);
    if (auth.accountId)
        msg.request_headers.append('chatgpt-account-id', auth.accountId);
    // chatgpt.com sits behind Cloudflare, which 403s requests without a UA.
    msg.request_headers.append('User-Agent', 'coding-agent-quota/0.2');
    msg.request_headers.append('Accept', 'application/json');
    return sendJsonRequest(session, msg);
}

async function getCodexUsage(session, force = false) {
    const cache = await loadJson(CODEX_CACHE_PATH);
    const now = Date.now();

    const cacheHit = msg => cache?.usage ? {
        usage: cache.usage, fetchedAt: cache.fetched_at,
        fromCache: true, ...(msg ? { fetchError: msg } : {}),
    } : null;

    if (!force && cache?.usage && now - cache.fetched_at < CODEX_TTL_MS) {
        return cacheHit(null);
    }

    const auth = await loadCodexAuth();
    if (!auth) return { notConfigured: true };

    if (auth.expiresAt && now > auth.expiresAt) {
        const msg = 'token expired — run `codex` to refresh';
        const hit = cacheHit(msg);
        if (hit) return hit;
        throw new Error(msg);
    }

    if (now < _codexBackoffUntil) {
        const msg = `rate-limited until ${fmtTime(new Date(_codexBackoffUntil))}`;
        const hit = cacheHit(msg);
        if (hit) return hit;
        throw new Error(msg);
    }

    try {
        const usage = await fetchCodexUsage(auth, session);
        await saveUsageCache(CODEX_CACHE_PATH, usage);
        return { usage, fetchedAt: Date.now(), fromCache: false };
    } catch (e) {
        if (e.retryAfterMs != null) {
            _codexBackoffUntil = Date.now() + e.retryAfterMs;
        }
        const hit = cacheHit(e.message ?? String(e));
        if (hit) return hit;
        throw e;
    }
}

// ---------- formatters ----------

function fmtDur(ms) {
    if (ms <= 0) return 'now';
    const totalMin = Math.floor(ms / 60000);
    if (totalMin < 60) return `${totalMin}m`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h < 24) return `${h}h ${m}m`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
}

function fmtTime(d) {
    const pad = n => String(n).padStart(2, '0');
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (sameDay) return t;
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${t}`;
}

function fmtAge(ms) {
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h${Math.floor((ms % 3_600_000) / 60_000)}m`;
    return `${Math.floor(ms / 86_400_000)}d ${Math.floor((ms % 86_400_000) / 3_600_000)}h`;
}

function parseRetryAfter(value) {
    if (!value) return null;
    const trimmed = value.trim();
    const n = parseInt(trimmed, 10);
    if (!isNaN(n) && String(n) === trimmed) return n * 1000;
    const date = new Date(trimmed);
    if (!isNaN(date.getTime())) return Math.max(0, date.getTime() - Date.now());
    return null;
}

function severityClass(pct, prefix) {
    if (pct >= 80) return `${prefix}-danger`;
    if (pct >= 50) return `${prefix}-warn`;
    return `${prefix}-ok`;
}

function pct(v) {
    return v == null ? '?' : `${v.toFixed(0)}%`;
}

function windowLabel(key) {
    return KNOWN_WINDOWS[key] ?? key.replace(/_/g, ' ');
}

function claudeLimitLabel(limit) {
    let label = KNOWN_LIMIT_KINDS[limit.kind] ??
        (limit.kind ? limit.kind.replace(/_/g, ' ') : 'limit');
    const scope = limit.scope?.model?.display_name ?? limit.scope?.surface;
    if (scope) label += ` · ${scope}`;
    else if (limit.kind === 'weekly_scoped') label += ' · model';
    return label;
}

// Codex windows are plan-dependent (e.g. prolite has a weekly primary and no
// secondary), so the label derives from the window length, not its position.
function codexWindowLabel(w) {
    const secs = w.limit_window_seconds ?? 0;
    if (secs === 5 * 3600) return '5 hours';
    if (secs === 7 * 24 * 3600) return 'Weekly';
    if (secs > 0) {
        const h = Math.round(secs / 3600);
        return h < 48 ? `${h} hours` : `${Math.round(h / 24)} days`;
    }
    return 'Usage';
}

function codexResetDate(w, nowMs) {
    if (w.reset_at) return new Date(w.reset_at * 1000);
    if (w.reset_after_seconds != null) return new Date(nowMs + w.reset_after_seconds * 1000);
    return null;
}

function fmtCodexPlan(planType) {
    if (!planType) return '';
    return planType[0].toUpperCase() + planType.slice(1);
}

function fmtPlan(oauth) {
    if (!oauth) return '';
    // rateLimitTier examples: "default_claude_max_20x", "claude_pro"
    const tier = oauth.rateLimitTier;
    if (tier) {
        const m = tier.match(/claude[_-](.+)$/i);
        if (m) return m[1].replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
    const sub = oauth.subscriptionType;
    if (sub) return sub[0].toUpperCase() + sub.slice(1);
    return '';
}

// ---------- visual builders (no `this`) ----------

function makeProgressBar(percent) {
    const track = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        style_class: 'tokens-bar-track',
    });
    track.set_width(BAR_WIDTH);
    const fill = new St.Widget({ style_class: 'tokens-bar-fill' });
    const fillW = Math.max(2, Math.min(BAR_WIDTH, Math.round(BAR_WIDTH * percent / 100)));
    fill.set_width(fillW);
    if (percent >= 80) fill.add_style_class_name('tokens-bar-fill-danger');
    else if (percent >= 50) fill.add_style_class_name('tokens-bar-fill-warn');
    track.add_child(fill);
    return track;
}

function makeWindowRow(label, utilization, resetDate, now) {
    const row = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style_class: 'tokens-window-row' });

    const top = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL, style_class: 'tokens-window-row-top' });
    top.add_child(new St.Label({
        text: label,
        style_class: 'tokens-window-label',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    const pctLabel = new St.Label({
        text: `${utilization.toFixed(1)}%`,
        style_class: 'tokens-window-pct',
        y_align: Clutter.ActorAlign.CENTER,
    });
    pctLabel.add_style_class_name(severityClass(utilization, 'tokens-panel-pct'));
    top.add_child(pctLabel);
    row.add_child(top);

    row.add_child(makeProgressBar(utilization));

    if (resetDate) {
        row.add_child(new St.Label({
            text: `resets ${fmtTime(resetDate)} · in ${fmtDur(resetDate.getTime() - now)}`,
            style_class: 'tokens-window-reset',
        }));
    }
    return row;
}

function makeServiceHeader(iconWidget, name, metaText) {
    const box = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL, style_class: 'tokens-svc-header' });
    box.add_child(iconWidget);
    box.add_child(new St.Label({
        text: name,
        style_class: 'tokens-svc-header-name',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    if (metaText) {
        box.add_child(new St.Label({
            text: metaText,
            style_class: 'tokens-svc-header-meta',
            y_align: Clutter.ActorAlign.CENTER,
        }));
    }
    return box;
}

function addCustomItem(section, child) {
    const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
    item.add_child(child);
    section.addMenuItem(item);
}

// ---------- indicator ----------

const QuotaIndicator = GObject.registerClass(
class QuotaIndicator extends PanelMenu.Button {
    _init(extPath) {
        super._init(0.0, 'Coding Agent Quota', false);

        this._extPath = extPath;
        this._destroyed = false;
        this._refreshing = false;
        this._gicons = new Map();
        // Without a timeout a single hung connection would wedge `_refreshing`
        // forever and permanently freeze the panel.
        this._session = new Soup.Session({ timeout: HTTP_TIMEOUT_SEC });

        this._panelBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'tokens-panel-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._panelBox);

        // placeholder until async setup completes
        this._placeholder = new St.Label({
            text: '…',
            style_class: 'tokens-panel-pct',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelBox.add_child(this._placeholder);

        this._buildMenu();

        // Fire-and-forget async setup; UI populates as it completes.
        this._setupAsync().catch(e => {
            console.error(`coding-agent-quota: setup failed: ${e}`);
        });
    }

    async _setupAsync() {
        try {
            await this._preloadGicons();
        } catch (e) {
            console.error(`coding-agent-quota: preload failed: ${e}`);
        }
        if (this._destroyed) return;

        // Replace placeholder with real panel widgets regardless of preload outcome —
        // missing icons render as blanks, but the percent text still works.
        if (this._placeholder) {
            this._panelBox.remove_child(this._placeholder);
            this._placeholder.destroy();
            this._placeholder = null;
        }
        this._claudePanel = this._mkPanelService('claude');
        this._codexPanel  = this._mkPanelService('codex');
        this._panelBox.add_child(this._claudePanel.box);
        this._panelBox.add_child(this._codexPanel.box);

        try {
            await this._refresh(false);
        } catch (e) {
            console.error(`coding-agent-quota: initial refresh failed: ${e}`);
        }
        if (this._destroyed) return;

        // Timer is installed unconditionally so a transient first-cycle failure
        // self-heals on the next tick instead of leaving the panel frozen.
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SEC, () => {
            if (this._destroyed) return GLib.SOURCE_REMOVE;
            this._refresh(false).catch(e => {
                console.error(`coding-agent-quota: refresh failed: ${e}`);
            });
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _preloadGicons() {
        for (const name of ['claude', 'codex']) {
            const srcPath = GLib.build_filenamev([
                this._extPath, 'icons', `${name}-symbolic.svg`,
            ]);
            const text = await readText(srcPath);
            if (!text) continue;
            const baked = text.includes('currentColor')
                ? text.replaceAll('currentColor', '#ffffff')
                : text;
            const bytes = GLib.Bytes.new(new TextEncoder().encode(baked));
            this._gicons.set(name, new Gio.BytesIcon({ bytes }));
        }
    }

    _mkIcon(name, sizePx, styleClass) {
        return new St.Icon({
            gicon: this._gicons.get(name),
            icon_size: sizePx,
            style_class: styleClass,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _mkPanelService(iconName) {
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'tokens-panel-svc',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const icon = this._mkIcon(iconName, PANEL_ICON_PX, 'tokens-panel-icon');
        const pctLabel = new St.Label({
            text: '—',
            style_class: 'tokens-panel-pct',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(icon);
        box.add_child(pctLabel);
        return { box, icon, pct: pctLabel };
    }

    _setPanelPct(svc, value, error) {
        if (!svc) return;
        for (const c of ['ok', 'warn', 'danger', 'error']) {
            svc.pct.remove_style_class_name(`tokens-panel-pct-${c}`);
        }
        if (error) {
            svc.pct.text = '!';
            svc.pct.add_style_class_name('tokens-panel-pct-error');
            return;
        }
        if (value == null) {
            svc.pct.text = '—';
            return;
        }
        svc.pct.text = pct(value);
        svc.pct.add_style_class_name(severityClass(value, 'tokens-panel-pct'));
    }

    _buildMenu() {
        this._claudeSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._claudeSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._codexSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._codexSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        refreshItem.connect('activate', () => {
            this._refresh(true).catch(e => {
                console.error(`coding-agent-quota: refresh failed: ${e}`);
            });
        });
        this.menu.addMenuItem(refreshItem);
    }

    async _refresh(force) {
        if (this._destroyed || this._refreshing) return;
        this._refreshing = true;
        try {
            // Self-heal: preloadGicons failed during setup. Retry once per refresh
            // until icons load, since the panel boxes already exist without them.
            if (this._gicons.size === 0) {
                try { await this._preloadGicons(); } catch {}
                if (this._destroyed) return;
            }

            const [claudeRes, codexRes] = await Promise.allSettled([
                getClaudeUsage(this._session, force),
                getCodexUsage(this._session, force),
            ]);
            if (this._destroyed) return;

            const claudeData = claudeRes.status === 'fulfilled' ? claudeRes.value : null;
            const claudeErr = claudeRes.status === 'rejected'
                ? (claudeRes.reason?.message ?? String(claudeRes.reason)) : null;
            const codexData = codexRes.status === 'fulfilled' ? codexRes.value : null;
            const codexErr = codexRes.status === 'rejected'
                ? (codexRes.reason?.message ?? String(codexRes.reason)) : null;

            this._renderPanel(claudeData?.usage, codexData?.usage, claudeErr, codexErr);
            this._renderClaude(claudeData, claudeErr);
            this._renderCodex(codexData, codexErr);
        } finally {
            this._refreshing = false;
        }
    }

    _renderPanel(claude, codexUsage, claudeErr, codexErr) {
        if (!this._claudePanel || !this._codexPanel) return;
        const worst = (...vals) => {
            const xs = vals.filter(v => v != null);
            return xs.length ? Math.max(...xs) : null;
        };
        let cc = null;
        if (claude) {
            const limitPcts = Array.isArray(claude.limits)
                ? claude.limits.map(l => l?.percent) : [];
            cc = limitPcts.some(v => v != null)
                ? worst(...limitPcts)
                : worst(claude.five_hour?.utilization, claude.seven_day?.utilization);
        }
        const rl = codexUsage?.rate_limit;
        const cx = rl
            ? worst(rl.primary_window?.used_percent, rl.secondary_window?.used_percent)
            : null;
        this._setPanelPct(this._claudePanel, cc, !!claudeErr);
        this._setPanelPct(this._codexPanel, cx, !!codexErr);
    }

    _renderClaude(data, err) {
        this._claudeSection.removeAll();

        const wrap = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style_class: 'tokens-popup-section' });

        const metaParts = [];
        const plan = fmtPlan(data?.oauth);
        if (plan) metaParts.push(plan);
        if (data?.usage) {
            metaParts.push(data.fromCache
                ? `cached ${fmtAge(Date.now() - data.fetchedAt)}`
                : 'just now');
        }
        wrap.add_child(makeServiceHeader(
            this._mkIcon('claude', HEADER_ICON_PX, 'tokens-svc-header-icon'),
            'Claude Code', metaParts.join(' · ')));

        if (data?.notConfigured) {
            wrap.add_child(new St.Label({ text: 'Not configured', style_class: 'tokens-empty' }));
            addCustomItem(this._claudeSection, wrap);
            return;
        }
        if (err) {
            wrap.add_child(new St.Label({ text: err, style_class: 'tokens-error' }));
            addCustomItem(this._claudeSection, wrap);
            return;
        }
        if (!data?.usage) {
            wrap.add_child(new St.Label({ text: 'no data', style_class: 'tokens-empty' }));
            addCustomItem(this._claudeSection, wrap);
            return;
        }

        if (data.fetchError) {
            wrap.add_child(new St.Label({
                text: `refresh failed: ${data.fetchError}`,
                style_class: 'tokens-warn',
            }));
        }

        const now = Date.now();
        const limits = Array.isArray(data.usage.limits)
            ? data.usage.limits.filter(l => l && l.percent != null)
            : [];
        if (limits.length) {
            // Current responses carry an authoritative `limits` array, including
            // model-scoped weeklies that never appear as top-level window keys.
            for (const l of limits) {
                const reset = l.resets_at ? new Date(l.resets_at) : null;
                wrap.add_child(makeWindowRow(claudeLimitLabel(l), l.percent, reset, now));
            }
        } else {
            // Legacy fallback (older cached payloads): iterate known keys first
            // (stable order), then any newly-introduced window keys discovered
            // in the response so server-side additions surface without a code change.
            const known = Object.keys(KNOWN_WINDOWS);
            const usageKeys = Object.keys(data.usage);
            const extras = usageKeys.filter(k =>
                !known.includes(k) && k !== 'extra_usage' &&
                data.usage[k] && typeof data.usage[k] === 'object' &&
                'utilization' in data.usage[k]
            ).sort();

            for (const key of [...known, ...extras]) {
                const w = data.usage[key];
                if (!w || typeof w !== 'object' || w.utilization == null) continue;
                const reset = w.resets_at ? new Date(w.resets_at) : null;
                wrap.add_child(makeWindowRow(windowLabel(key), w.utilization, reset, now));
            }
        }

        const e = data.usage.extra_usage;
        if (e?.is_enabled) {
            if (e.utilization != null) {
                wrap.add_child(makeWindowRow('Extra usage', e.utilization, null, now));
            }
            const used = (e.used_credits ?? 0).toFixed(2);
            const cap  = (e.monthly_limit ?? 0).toFixed(2);
            wrap.add_child(new St.Label({
                text: `Extra: ${used} / ${cap} ${e.currency ?? ''}`.trim(),
                style_class: 'tokens-extra',
            }));
        } else if (e?.disabled_reason) {
            wrap.add_child(new St.Label({
                text: `Extra usage disabled: ${e.disabled_reason}`,
                style_class: 'tokens-extra',
            }));
        }
        addCustomItem(this._claudeSection, wrap);
    }

    _renderCodex(data, err) {
        this._codexSection.removeAll();
        const wrap = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style_class: 'tokens-popup-section' });

        const usage = data?.usage;
        const metaParts = [];
        const plan = fmtCodexPlan(usage?.plan_type);
        if (plan) metaParts.push(plan);
        if (usage) {
            metaParts.push(data.fromCache
                ? `cached ${fmtAge(Date.now() - data.fetchedAt)}`
                : 'just now');
        }
        wrap.add_child(makeServiceHeader(
            this._mkIcon('codex', HEADER_ICON_PX, 'tokens-svc-header-icon'),
            'Codex', metaParts.join(' · ')));

        if (data?.notConfigured) {
            wrap.add_child(new St.Label({ text: 'Not configured', style_class: 'tokens-empty' }));
            addCustomItem(this._codexSection, wrap);
            return;
        }
        if (err) {
            wrap.add_child(new St.Label({ text: err, style_class: 'tokens-error' }));
            addCustomItem(this._codexSection, wrap);
            return;
        }
        if (!usage) {
            wrap.add_child(new St.Label({ text: 'no data', style_class: 'tokens-empty' }));
            addCustomItem(this._codexSection, wrap);
            return;
        }

        if (data.fetchError) {
            wrap.add_child(new St.Label({
                text: `refresh failed: ${data.fetchError}`,
                style_class: 'tokens-warn',
            }));
        }
        if (usage.rate_limit_reached_type) {
            wrap.add_child(new St.Label({
                text: `rate limit reached (${usage.rate_limit_reached_type})`,
                style_class: 'tokens-warn',
            }));
        }
        if (usage.spend_control?.reached) {
            wrap.add_child(new St.Label({
                text: 'spend limit reached',
                style_class: 'tokens-warn',
            }));
        }

        const now = Date.now();
        const rl = usage.rate_limit;
        let rows = 0;
        for (const w of [rl?.primary_window, rl?.secondary_window]) {
            if (!w || w.used_percent == null) continue;
            rows++;
            wrap.add_child(makeWindowRow(
                codexWindowLabel(w), w.used_percent, codexResetDate(w, now), now));
        }

        // Model-scoped extras (e.g. promotional model limits) reported alongside
        // the account-wide windows; labeled by the server-provided limit_name.
        for (const extra of usage.additional_rate_limits ?? []) {
            const w = extra?.rate_limit?.primary_window;
            if (!w || w.used_percent == null) continue;
            rows++;
            wrap.add_child(makeWindowRow(
                extra.limit_name ?? 'Additional', w.used_percent, codexResetDate(w, now), now));
        }

        if (rows === 0) {
            wrap.add_child(new St.Label({ text: 'no usage windows reported', style_class: 'tokens-empty' }));
        }

        addCustomItem(this._codexSection, wrap);
    }

    destroy() {
        this._destroyed = true;
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        super.destroy();
    }
});

export default class QuotaExtension extends Extension {
    enable() {
        this._indicator = new QuotaIndicator(this.path);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
