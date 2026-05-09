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
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

const REFRESH_SEC = 60;
const CLAUDE_TTL_MS = 15 * 60 * 1000;

const HOME = GLib.get_home_dir();
const CACHE_DIR = GLib.build_filenamev([
    GLib.get_user_cache_dir(), 'coding-agent-quota',
]);
const CLAUDE_CACHE_PATH = GLib.build_filenamev([CACHE_DIR, 'claude_usage.json']);

const BAR_WIDTH = 180;
const PANEL_ICON_PX = 14;
const HEADER_ICON_PX = 18;

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
                if (msg.get_status() !== Soup.Status.OK) {
                    reject(new Error(`HTTP ${msg.get_status()}`));
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
    if (!force) {
        const c = await loadClaudeCache();
        if (c?.usage && Date.now() - c.fetched_at < CLAUDE_TTL_MS) {
            return { usage: c.usage, fetchedAt: c.fetched_at, fromCache: true };
        }
    }
    const oauth = await loadClaudeOauth();
    if (!oauth?.accessToken) throw new Error('no claude credentials');
    if (oauth.expiresAt && Date.now() > oauth.expiresAt) {
        throw new Error('access token expired (run `claude` to refresh)');
    }
    const usage = await fetchClaudeUsage(oauth.accessToken, session);
    await saveClaudeCache(usage);
    return { usage, fetchedAt: Date.now(), fromCache: false };
}

// ---------- Codex data ----------

async function readCodexLatest() {
    const root = `${HOME}/.codex/sessions`;
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
    let bestTs = 0;
    let bestRL = null;

    async function walk(dir) {
        let enumerator;
        try {
            const f = Gio.File.new_for_path(dir);
            enumerator = await f.enumerate_children_async(
                'standard::name,standard::type,time::modified',
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
                        await scanFile(child);
                    }
                }
            }
        } finally {
            try { enumerator.close(null); } catch {}
        }
    }

    async function scanFile(path) {
        const text = await readText(path);
        if (!text) return;
        const lines = text.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            if (!line || !line.includes('"token_count"')) continue;
            try {
                const j = JSON.parse(line);
                if (j.type !== 'event_msg' ||
                    j.payload?.type !== 'token_count' ||
                    !j.payload.rate_limits) continue;
                const ts = Math.floor(Date.parse(j.timestamp) / 1000);
                if (ts > bestTs) {
                    bestTs = ts;
                    bestRL = j.payload.rate_limits;
                }
                break;
            } catch {}
        }
    }

    await walk(root);
    return bestRL ? { rateLimits: bestRL, timestamp: bestTs } : null;
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
    return `${Math.floor(ms / 3_600_000)}h${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

function severityClass(pct, prefix) {
    if (pct >= 80) return `${prefix}-danger`;
    if (pct >= 50) return `${prefix}-warn`;
    return `${prefix}-ok`;
}

function pct(v) {
    return v == null ? '?' : `${v.toFixed(0)}%`;
}

// ---------- visual builders (no `this`) ----------

function makeProgressBar(percent) {
    const track = new St.Bin({ style_class: 'tokens-bar-track' });
    track.set_width(BAR_WIDTH);
    const fill = new St.Widget({ style_class: 'tokens-bar-fill' });
    const fillW = Math.max(2, Math.min(BAR_WIDTH, Math.round(BAR_WIDTH * percent / 100)));
    fill.set_width(fillW);
    if (percent >= 80) fill.add_style_class_name('tokens-bar-fill-danger');
    else if (percent >= 50) fill.add_style_class_name('tokens-bar-fill-warn');
    track.set_child(fill);
    return track;
}

function makeWindowRow(label, utilization, resetDate, now) {
    const row = new St.BoxLayout({ vertical: true, style_class: 'tokens-window-row' });

    const top = new St.BoxLayout({ vertical: false, style_class: 'tokens-window-row-top' });
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
    const box = new St.BoxLayout({ vertical: false, style_class: 'tokens-svc-header' });
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
            vertical: false,
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
        await this._preloadGicons();
        if (this._destroyed) return;

        // Replace placeholder with real panel widgets.
        if (this._placeholder) {
            this._panelBox.remove_child(this._placeholder);
            this._placeholder.destroy();
            this._placeholder = null;
        }
        this._claudePanel = this._mkPanelService('claude');
        this._codexPanel  = this._mkPanelService('codex');
        this._panelBox.add_child(this._claudePanel.box);
        this._panelBox.add_child(this._codexPanel.box);

        await this._refresh(false);
        if (this._destroyed) return;

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
            vertical: false,
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

        const wrap = new St.BoxLayout({ vertical: true, style_class: 'tokens-popup-section' });

        let meta = '';
        if (data) {
            meta = data.fromCache ? `cached ${fmtAge(Date.now() - data.fetchedAt)}` : 'just now';
        }
        wrap.add_child(makeServiceHeader(
            this._mkIcon('claude', HEADER_ICON_PX, 'tokens-svc-header-icon'),
            'Claude Code', meta));

        if (err) {
            wrap.add_child(new St.Label({ text: err, style_class: 'tokens-error' }));
            addCustomItem(this._claudeSection, wrap);
            return;
        }
        if (!data) {
            wrap.add_child(new St.Label({ text: 'no data', style_class: 'tokens-empty' }));
            addCustomItem(this._claudeSection, wrap);
            return;
        }

        const now = Date.now();
        const rows = [
            ['five_hour',        '5 hours'],
            ['seven_day',        'Weekly'],
            ['seven_day_opus',   'Weekly · Opus'],
            ['seven_day_sonnet', 'Weekly · Sonnet'],
        ];
        for (const [key, label] of rows) {
            const w = data.usage[key];
            if (!w) continue;
            const reset = w.resets_at ? new Date(w.resets_at) : null;
            wrap.add_child(makeWindowRow(label, w.utilization, reset, now));
        }
        const e = data.usage.extra_usage;
        if (e?.is_enabled) {
            wrap.add_child(new St.Label({
                text: `Extra usage: ${e.used_credits.toFixed(2)} / ${e.monthly_limit.toFixed(2)} ${e.currency}`,
                style_class: 'tokens-extra',
            }));
        }
        addCustomItem(this._claudeSection, wrap);
    }

    _renderCodex(codex) {
        this._codexSection.removeAll();
        const wrap = new St.BoxLayout({ vertical: true, style_class: 'tokens-popup-section' });

        if (!codex?.rateLimits) {
            wrap.add_child(makeServiceHeader(
                this._mkIcon('codex', HEADER_ICON_PX, 'tokens-svc-header-icon'),
                'Codex', ''));
            wrap.add_child(new St.Label({ text: 'no data', style_class: 'tokens-empty' }));
            addCustomItem(this._codexSection, wrap);
            return;
        }

        const rl = codex.rateLimits;
        const meta = `snapshot ${fmtAge(Date.now() - codex.timestamp * 1000)}` +
            (rl.plan_type ? ` · ${rl.plan_type}` : '');
        wrap.add_child(makeServiceHeader(
            this._mkIcon('codex', HEADER_ICON_PX, 'tokens-svc-header-icon'),
            'Codex', meta));

        const now = Date.now();
        const rows = [
            [rl.primary,   '5 hours'],
            [rl.secondary, 'Weekly'],
        ];
        for (const [w, label] of rows) {
            if (!w) continue;
            const reset = w.resets_at ? new Date(w.resets_at * 1000) : null;
            wrap.add_child(makeWindowRow(label, w.used_percent, reset, now));
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
