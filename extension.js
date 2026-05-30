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
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');

const REFRESH_SEC = 60;
const CLAUDE_TTL_MS = 15 * 60 * 1000;
const CODEX_MAX_AGE_SEC = 7 * 24 * 3600;
const CODEX_TAIL_CHUNKS = [64 * 1024, 256 * 1024];

const HOME = GLib.get_home_dir();
const CACHE_DIR = GLib.build_filenamev([
    GLib.get_user_cache_dir(), 'coding-agent-quota',
]);
const CLAUDE_CACHE_PATH = GLib.build_filenamev([CACHE_DIR, 'claude_usage.json']);

const BAR_WIDTH = 180;
const PANEL_ICON_PX = 14;
const HEADER_ICON_PX = 18;

// key → display label; unknown keys fall through to the raw key so new
// server-side windows still surface (extension.js never crashes on them).
const KNOWN_WINDOWS = {
    five_hour:            '5 hours',
    seven_day:            'Weekly',
    seven_day_opus:       'Weekly · Opus',
    seven_day_sonnet:     'Weekly · Sonnet',
    seven_day_oauth_apps: 'Weekly · OAuth apps',
    seven_day_cowork:     'Weekly · Cowork',
};

let _claudeBackoffUntil = 0;
// path → {mtime, ts, rateLimits, info}. mtime-keyed so unchanged files skip re-read.
const _codexFileCache = new Map();

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

// ---------- Claude Code data ----------

async function loadClaudeOauth() {
    const text = await readText(`${HOME}/.claude/.credentials.json`);
    if (!text) return null;
    try {
        return JSON.parse(text).claudeAiOauth ?? null;
    } catch {
        return null;
    }
}

async function loadClaudeCache() {
    const text = await readText(CLAUDE_CACHE_PATH);
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

async function saveClaudeCache(usage) {
    await writeText(CLAUDE_CACHE_PATH, JSON.stringify({
        fetched_at: Date.now(), usage,
    }));
}

function fetchClaudeUsage(token, session) {
    return new Promise((resolve, reject) => {
        const msg = Soup.Message.new('GET', 'https://api.anthropic.com/api/oauth/usage');
        msg.request_headers.append('Authorization', `Bearer ${token}`);
        msg.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
        msg.request_headers.append('Content-Type', 'application/json');
        msg.request_headers.append('User-Agent', 'coding-agent-quota/0.1');

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

async function getClaudeUsage(session, force = false) {
    const cache = await loadClaudeCache();
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
        await saveClaudeCache(usage);
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

async function readFileTail(path, totalSize, chunkBytes) {
    if (chunkBytes >= totalSize) {
        return await readText(path);
    }
    let stream = null;
    try {
        const file = Gio.File.new_for_path(path);
        stream = await file.read_async(GLib.PRIORITY_DEFAULT, null);
        stream.seek(totalSize - chunkBytes, GLib.SeekType.SET, null);
        const bytes = await stream.read_bytes_async(chunkBytes, GLib.PRIORITY_DEFAULT, null);
        return new TextDecoder().decode(bytes.toArray());
    } catch {
        return null;
    } finally {
        try { stream?.close(null); } catch {}
    }
}

function parseTokenCount(text) {
    // tail-read may have truncated the first line; line-by-line JSON.parse
    // skips it via the catch block, so partial reads stay safe.
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line || !line.includes('"token_count"')) continue;
        try {
            const j = JSON.parse(line);
            if (j.type !== 'event_msg' ||
                j.payload?.type !== 'token_count' ||
                !j.payload.rate_limits) continue;
            return {
                ts: Math.floor(Date.parse(j.timestamp) / 1000),
                rateLimits: j.payload.rate_limits,
                info: j.payload.info ?? null,
            };
        } catch {}
    }
    return null;
}

async function scanCodexFile(path, size) {
    for (const chunk of CODEX_TAIL_CHUNKS) {
        if (chunk >= size) break;
        const text = await readFileTail(path, size, chunk);
        if (!text) continue;
        const result = parseTokenCount(text);
        if (result) return result;
    }
    const text = await readText(path);
    if (!text) return null;
    return parseTokenCount(text);
}

async function getOrScanCodexFile(path, mtime, size) {
    const cached = _codexFileCache.get(path);
    if (cached && cached.mtime === mtime) {
        return cached.ts > 0 ? cached : null;
    }
    const result = await scanCodexFile(path, size);
    if (result) {
        const entry = { mtime, ...result };
        _codexFileCache.set(path, entry);
        return entry;
    }
    // Remember the (path, mtime) miss so we don't re-scan an unchanged
    // file that has no token_count event. Re-tried only on mtime change.
    _codexFileCache.set(path, { mtime, ts: 0, rateLimits: null, info: null });
    return null;
}

async function readCodexLatest() {
    const root = `${HOME}/.codex/sessions`;

    try {
        await Gio.File.new_for_path(root).query_info_async(
            'standard::type',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            null,
        );
    } catch {
        return { notConfigured: true };
    }

    const cutoff = Math.floor(Date.now() / 1000) - CODEX_MAX_AGE_SEC;
    const seen = new Set();
    let best = null;

    async function walk(dir) {
        let enumerator;
        try {
            const f = Gio.File.new_for_path(dir);
            enumerator = await f.enumerate_children_async(
                'standard::name,standard::type,standard::size,time::modified',
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                null,
            );
        } catch {
            return;
        }
        try {
            while (true) {
                let infos;
                try {
                    infos = await enumerator.next_files_async(50, GLib.PRIORITY_DEFAULT, null);
                } catch {
                    break;
                }
                if (!infos || infos.length === 0) break;
                for (const info of infos) {
                    const name = info.get_name();
                    const child = `${dir}/${name}`;
                    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                        await walk(child);
                    } else if (name.endsWith('.jsonl')) {
                        const mtime = info.get_modification_date_time()?.to_unix() ?? 0;
                        if (mtime < cutoff) continue;
                        seen.add(child);
                        const size = info.get_size();
                        const entry = await getOrScanCodexFile(child, mtime, size);
                        if (entry && (!best || entry.ts > best.ts)) {
                            best = entry;
                        }
                    }
                }
            }
        } finally {
            try { enumerator.close(null); } catch {}
        }
    }

    await walk(root);

    // GC: drop cache entries for files no longer visible (rolled past 7d or deleted).
    for (const path of [..._codexFileCache.keys()]) {
        if (!seen.has(path)) _codexFileCache.delete(path);
    }

    return best
        ? { rateLimits: best.rateLimits, info: best.info, timestamp: best.ts }
        : null;
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

function fmtTokens(n) {
    if (n == null) return '?';
    if (n < 1_000) return String(n);
    if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
    if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    return `${(n / 1_000_000_000).toFixed(2)}B`;
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
        this._session = new Soup.Session();

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

            let claudeData = null, claudeErr = null;
            try {
                claudeData = await getClaudeUsage(this._session, force);
            } catch (e) {
                claudeErr = e.message ?? String(e);
            }
            if (this._destroyed) return;

            let codex = null;
            try { codex = await readCodexLatest(); } catch {}
            if (this._destroyed) return;

            this._renderPanel(claudeData?.usage, codex?.rateLimits, claudeErr);
            this._renderClaude(claudeData, claudeErr);
            this._renderCodex(codex);
        } finally {
            this._refreshing = false;
        }
    }

    _renderPanel(claude, codexRL, claudeErr) {
        if (!this._claudePanel || !this._codexPanel) return;
        const worst = (...vals) => {
            const xs = vals.filter(v => v != null);
            return xs.length ? Math.max(...xs) : null;
        };
        const cc = claude
            ? worst(claude.five_hour?.utilization, claude.seven_day?.utilization)
            : null;
        const cx = codexRL
            ? worst(codexRL.primary?.used_percent, codexRL.secondary?.used_percent)
            : null;
        this._setPanelPct(this._claudePanel, cc, !!claudeErr);
        this._setPanelPct(this._codexPanel, cx, false);
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
        // Iterate known keys first (stable order), then any newly-introduced
        // window keys discovered in the response so server-side additions
        // surface without a code change.
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

    _renderCodex(codex) {
        this._codexSection.removeAll();
        const wrap = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style_class: 'tokens-popup-section' });

        const header = meta => wrap.add_child(makeServiceHeader(
            this._mkIcon('codex', HEADER_ICON_PX, 'tokens-svc-header-icon'),
            'Codex', meta));

        if (codex?.notConfigured) {
            header('');
            wrap.add_child(new St.Label({ text: 'Not configured', style_class: 'tokens-empty' }));
            addCustomItem(this._codexSection, wrap);
            return;
        }

        if (!codex?.rateLimits) {
            header('');
            wrap.add_child(new St.Label({ text: 'no data', style_class: 'tokens-empty' }));
            addCustomItem(this._codexSection, wrap);
            return;
        }

        const rl = codex.rateLimits;
        const meta = `snapshot ${fmtAge(Date.now() - codex.timestamp * 1000)}` +
            (rl.plan_type ? ` · ${rl.plan_type}` : '');
        header(meta);

        const now = Date.now();
        const primaryResetMs = rl.primary?.resets_at ? rl.primary.resets_at * 1000 : null;
        if (primaryResetMs && primaryResetMs < now) {
            wrap.add_child(new St.Label({
                text: 'snapshot stale — run `codex` to update',
                style_class: 'tokens-warn',
            }));
        }
        if (rl.rate_limit_reached_type) {
            wrap.add_child(new St.Label({
                text: `rate limit reached (${rl.rate_limit_reached_type})`,
                style_class: 'tokens-warn',
            }));
        }

        const rows = [
            [rl.primary,   '5 hours'],
            [rl.secondary, 'Weekly'],
        ];
        for (const [w, label] of rows) {
            if (!w) continue;
            const reset = w.resets_at ? new Date(w.resets_at * 1000) : null;
            wrap.add_child(makeWindowRow(label, w.used_percent, reset, now));
        }

        // Last-turn context fill — distinct from rate-limit rows; label disambiguates.
        const info = codex.info;
        const lastTokens = info?.last_token_usage?.total_tokens;
        const ctxWindow  = info?.model_context_window;
        if (lastTokens != null && ctxWindow) {
            const ctxPct = Math.min(100, lastTokens / ctxWindow * 100);
            wrap.add_child(makeWindowRow('Context · last turn', ctxPct, null, now));
            wrap.add_child(new St.Label({
                text: `${fmtTokens(lastTokens)} / ${fmtTokens(ctxWindow)} tokens`,
                style_class: 'tokens-extra',
            }));
        }

        // Cumulative session totals — only emitted if the server sent the info block.
        const tot = info?.total_token_usage;
        if (tot?.total_tokens != null) {
            const cachePct = tot.input_tokens
                ? (tot.cached_input_tokens / tot.input_tokens * 100).toFixed(0)
                : null;
            const parts = [`Σ ${fmtTokens(tot.total_tokens)} tokens`];
            if (cachePct != null) parts.push(`cache ${cachePct}%`);
            if (tot.reasoning_output_tokens) {
                parts.push(`reasoning ${fmtTokens(tot.reasoning_output_tokens)}`);
            }
            wrap.add_child(new St.Label({
                text: parts.join(' · '),
                style_class: 'tokens-extra',
            }));
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
