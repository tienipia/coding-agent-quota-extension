// Live probe of the two usage endpoints coding-agent-quota reads, sending the
// same headers extension.js sends. Run it when a Claude Code / Codex update
// may have changed the data contract:
//
//     gjs -m tools/usage-probe.js
//
// Prints one line per service and exits non-zero on FAIL. Endpoint URLs and
// headers are intentionally duplicated from extension.js — the extension
// module imports gi://St and cannot be loaded outside GNOME Shell.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import system from 'system';

Gio._promisify(Gio.File.prototype, 'load_contents_async');

const HOME = GLib.get_home_dir();

async function readJson(path) {
    try {
        const [contents] = await Gio.File.new_for_path(path).load_contents_async(null);
        return JSON.parse(new TextDecoder().decode(contents));
    } catch {
        return null;
    }
}

function fetchJson(session, url, headers) {
    return new Promise((resolve, reject) => {
        const msg = Soup.Message.new('GET', url);
        for (const [k, v] of Object.entries(headers))
            msg.request_headers.append(k, v);
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (_, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                if (msg.status_code !== 200) {
                    reject(new Error(`HTTP ${msg.status_code}`));
                    return;
                }
                resolve(JSON.parse(new TextDecoder().decode(bytes.get_data())));
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function probeClaude(session) {
    const oauth = (await readJson(`${HOME}/.claude/.credentials.json`))?.claudeAiOauth;
    if (!oauth?.accessToken) return 'SKIP (no credentials)';
    const j = await fetchJson(session, 'https://api.anthropic.com/api/oauth/usage', {
        'Authorization': `Bearer ${oauth.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
        'User-Agent': 'coding-agent-quota/0.2',
    });
    const limits = Array.isArray(j.limits) ? j.limits.filter(l => l?.percent != null) : [];
    if (limits.length)
        return 'PASS limits[]: ' + limits.map(l => `${l.kind}=${l.percent}%`).join(' ');
    if (j.five_hour?.utilization != null)
        return `PASS legacy: 5h=${j.five_hour.utilization}%`;
    throw new Error('no limits[] entries and no five_hour.utilization in response');
}

async function probeCodex(session) {
    const tokens = (await readJson(`${HOME}/.codex/auth.json`))?.tokens;
    if (!tokens?.access_token) return 'SKIP (no ChatGPT login)';
    const headers = {
        'Authorization': `Bearer ${tokens.access_token}`,
        'User-Agent': 'coding-agent-quota/0.2',
        'Accept': 'application/json',
    };
    if (tokens.account_id)
        headers['chatgpt-account-id'] = tokens.account_id;
    const j = await fetchJson(session, 'https://chatgpt.com/backend-api/codex/usage', headers);
    const w = j.rate_limit?.primary_window;
    if (typeof w?.used_percent !== 'number')
        throw new Error('rate_limit.primary_window.used_percent missing');
    return `PASS plan=${j.plan_type} primary=${w.used_percent}% ` +
        `window=${w.limit_window_seconds}s reset_at=${w.reset_at} ` +
        `additional=${(j.additional_rate_limits ?? []).length}`;
}

const loop = new GLib.MainLoop(null, false);
let failed = false;
(async () => {
    const session = new Soup.Session({ timeout: 20 });
    for (const [name, probe] of [['claude', probeClaude], ['codex', probeCodex]]) {
        try {
            console.log(`${name}: ${await probe(session)}`);
        } catch (e) {
            failed = true;
            console.log(`${name}: FAIL ${e.message ?? e}`);
        }
    }
})().finally(() => loop.quit());
loop.run();
if (failed) system.exit(1);
