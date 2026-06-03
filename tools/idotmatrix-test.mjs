// iDotMatrix 32x32 BLE connection test — zero npm deps, drives system bluetoothctl.
// Single shippable ESM file. Run: node tools/idotmatrix-test.mjs
import { spawn } from 'node:child_process';
import { openSync, writeSync, closeSync, readFileSync, unlinkSync, existsSync, readdirSync, statSync, fstatSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';

// ── ① PROTO: pure command-byte builders (portable to GJS) ───────────────────
export const CHAR_WRITE = '0000fa02-0000-1000-8000-00805f9b34fb';
export const NAME_PREFIXES = ['IDM-', 'IDF-'];

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export const PROTO = {
  screenOn()  { return [0x05, 0x00, 0x07, 0x01, 0x01]; },
  screenOff() { return [0x05, 0x00, 0x07, 0x01, 0x00]; },
  brightness(pct) { return [0x05, 0x00, 0x04, 0x80, Math.round(clamp(pct, 5, 100))]; },
  fill(r, g, b) {
    return [0x07, 0x00, 0x02, 0x02, clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255)];
  },
  // graffiti single-pixel draw (DIY): RGB then X,Y (0..31)
  setPixel(x, y, r, g, b) {
    return [0x0A, 0x00, 0x05, 0x01, 0x00, clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255), x & 0xff, y & 0xff];
  },
};

// bluetoothctl gatt `write` argument form: "0x05 0x00 0x07 0x01 0x01"
export function toWriteArg(bytes) {
  return bytes.map(b => '0x' + (b & 0xff).toString(16).padStart(2, '0')).join(' ');
}

// ── ② CLI parsing ───────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const opts = { color: 'FF0000', off: false, keep: false, dryRun: false, debug: false, quota: false, watch: 0, beats: 0, mac: null, timeout: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--off') opts.off = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--debug') opts.debug = true;
    else if (a === '--quota') opts.quota = true;
    else if (a === '--watch') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n)) { opts.watch = n; i++; } else { opts.watch = 300; }
    }
    else if (a === '--beats') {
      opts.beats = Number(argv[++i]);
      if (!Number.isFinite(opts.beats)) throw new Error(`--beats requires a number`);
    }
    else if (a === '--color') opts.color = argv[++i];
    else if (a === '--mac') opts.mac = argv[++i];
    else if (a === '--timeout') {
      opts.timeout = Number(argv[++i]);
      if (!Number.isFinite(opts.timeout)) throw new Error(`--timeout requires a number`);
    }
    else throw new Error(`unknown arg: ${a}`);
  }
  return opts;
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) throw new Error(`invalid color: ${hex} (expected RRGGBB)`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// ── ③ bluetoothctl output parsing (pure) ────────────────────────────────────
export function stripAnsi(s) {
  // CSI / SGR escape sequences
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

const MAC_RE = /([0-9A-F]{2}(?::[0-9A-F]{2}){5})/i;

// Any "Device <MAC> <name>" line → {mac, name}; else null.
export function parseAnyDevice(line) {
  const clean = stripAnsi(line);
  if (!/\bDevice\b/.test(clean)) return null;
  const m = MAC_RE.exec(clean);
  if (!m) return null;
  const rest = clean.slice(clean.indexOf(m[1]) + m[1].length).trim();
  const nameM = /Name:\s*(.+)$/.exec(rest);
  const name = (nameM ? nameM[1] : rest).trim();
  return { mac: m[1].toUpperCase(), name };
}

// Device line whose name starts with one of `prefixes`, else null.
export function parseDeviceLine(line, prefixes) {
  const d = parseAnyDevice(line);
  return d && prefixes.some(p => d.name.startsWith(p)) ? d : null;
}

export function isConnected(line) {
  return /Connection successful/.test(stripAnsi(line));
}
export function isServicesResolved(line) {
  return /ServicesResolved:\s*yes/.test(stripAnsi(line));
}

// From `list-attributes` output lines, return the object path of the characteristic
// whose UUID matches. bluetoothctl prints the path line then the uuid line.
export function parseCharPath(lines, uuid) {
  const want = uuid.toLowerCase();
  let lastChar = null;
  for (const raw of lines) {
    const line = stripAnsi(raw);
    const pm = /(\/org\/bluez\/\S*char[0-9a-f]+)/i.exec(line);
    if (pm) lastChar = pm[1];
    if (lastChar && line.toLowerCase().includes(want)) return lastChar;
  }
  return null;
}

// ── ④ single-instance lock ──────────────────────────────────────────────────
export function lockPath() {
  const dir = process.env.XDG_RUNTIME_DIR || tmpdir();
  return join(dir, 'idotmatrix-test.lock');
}

export function isAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // exists but owned by another user
}

// Acquire an exclusive single-instance lock. Returns release().
// Throws Error{code:'ELOCKED', pid} when another live instance holds it.
export function acquireLock(path = lockPath()) {
  const create = () => {
    const fd = openSync(path, 'wx'); // O_CREAT | O_EXCL | O_WRONLY
    try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
  };
  try {
    create();
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(readFileSync(path, 'utf8').trim());
    if (isAlive(pid)) {
      const err = new Error(`already running (pid ${pid})`);
      err.code = 'ELOCKED';
      err.pid = pid;
      throw err;
    }
    unlinkSync(path); // stale → remove and retry once
    create();
  }
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    try { if (existsSync(path)) unlinkSync(path); } catch { /* best effort */ }
  };
}

// ── ⑤ BtCtl: drive `bluetoothctl` as a persistent subprocess ────────────────
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export class BtCtl {
  constructor({ debug = false } = {}) {
    this.debug = debug;
    this.proc = null;
    this.buf = '';
    this.listeners = new Set();       // line listeners: fn(line)
    this.deathListeners = new Set();  // subprocess-death listeners: fn()
    this.closed = false;
    this._err = null;
  }

  start() {
    this.proc = spawn('bluetoothctl', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    const onData = (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = stripAnsi(this.buf.slice(0, i)).replace(/\r/g, '').trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        if (this.debug) console.error('  <', line);
        for (const fn of [...this.listeners]) fn(line);
      }
    };
    this.proc.stdout.on('data', onData);
    this.proc.stderr.on('data', onData);
    this.proc.on('close', () => this._die());
    // Without these, a spawn failure (ENOENT/EACCES) or an async stdin EPIPE
    // would surface as an uncaught 'error' event and crash the whole script,
    // bypassing main()'s cleanup (the lock would never be released).
    const onErr = (err) => this._die(err);
    this.proc.on('error', onErr);
    this.proc.stdin.on('error', onErr);
  }

  // Mark the subprocess dead exactly once and wake every in-flight waiter.
  _die(err) {
    if (err && !this._err) this._err = err;
    if (this.closed) return;
    this.closed = true;
    for (const fn of [...this.deathListeners]) fn();
  }

  // Register a death listener; returns an unregister fn.
  _onDeath(fn) {
    this.deathListeners.add(fn);
    return () => this.deathListeners.delete(fn);
  }

  send(cmd) {
    if (this.closed) {
      throw new Error(this._err ? `bluetoothctl unavailable: ${this._err.message}` : 'bluetoothctl exited');
    }
    if (this.debug) console.error('  >', cmd);
    this.proc.stdin.write(cmd + '\n');
  }

  // Resolve with the first line where pred(line) is true; reject on timeout/death.
  waitFor(pred, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('bluetoothctl not running')); return; }
      const onLine = (line) => { if (pred(line)) { cleanup(); resolve(line); } };
      const offDeath = this._onDeath(() => { cleanup(); reject(new Error('bluetoothctl exited while waiting')); });
      const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.listeners.delete(onLine); offDeath(); };
      this.listeners.add(onLine);
    });
  }

  async scanForDevice(prefixes, timeoutMs) {
    const seen = new Map();
    const result = new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('bluetoothctl not running')); return; }
      const onLine = (line) => {
        const d = parseAnyDevice(line);
        if (!d) return;
        seen.set(d.mac, d.name);
        if (prefixes.some((p) => d.name.startsWith(p))) { cleanup(); resolve(d); }
      };
      const offDeath = this._onDeath(() => { cleanup(); reject(new Error('bluetoothctl exited during scan')); });
      const timer = setTimeout(() => {
        cleanup();
        const list = [...seen].map(([m, n]) => `    ${m}  ${n}`).join('\n') || '    (none seen)';
        reject(new Error(`no iDotMatrix found in ${timeoutMs / 1000}s.\n  devices seen:\n${list}`));
      }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.listeners.delete(onLine); offDeath(); };
      this.listeners.add(onLine);
    });
    this.send('scan on');
    try { return await result; }
    finally { try { this.send('scan off'); } catch { /* subprocess may be gone */ } }
  }

  // A device that is already connected is NOT advertising, so scanForDevice
  // can't see it. `devices Connected` lists it. Resolves {mac,name} or null.
  async connectedDevice(prefixes, timeoutMs = 3000) {
    return new Promise((resolve) => {
      if (this.closed) { resolve(null); return; }
      const onLine = (line) => {
        const d = parseAnyDevice(line);
        if (d && prefixes.some((p) => d.name.startsWith(p))) { cleanup(); resolve(d); }
      };
      const offDeath = this._onDeath(() => { cleanup(); resolve(null); });
      const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.listeners.delete(onLine); offDeath(); };
      this.listeners.add(onLine);
      this.send('devices Connected');
    });
  }

  async connect(mac, timeoutMs, retries = 2, assumeResolved = false) {
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      try {
        this.send(`connect ${mac}`);
        await this.waitFor(isConnected, timeoutMs);
        if (!assumeResolved) await this.waitFor(isServicesResolved, timeoutMs);
        return;
      } catch (e) {
        if (attempt > retries) throw new Error(`connect to ${mac} failed: ${e.message}`);
        if (this.debug) console.error(`  connect attempt ${attempt} failed (${e.message}); retrying`);
        try { this.send(`disconnect ${mac}`); } catch { /* ignore */ }
        await delay(1500);
      }
    }
  }

  // Resolve the FA02 characteristic object path from `list-attributes` output.
  resolveCharPath(uuid, timeoutMs) {
    const lines = [];
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('bluetoothctl not running')); return; }
      const onLine = (line) => {
        lines.push(line);
        const p = parseCharPath(lines, uuid);
        if (p) { cleanup(); resolve(p); }
      };
      const offDeath = this._onDeath(() => { cleanup(); reject(new Error('bluetoothctl exited during list-attributes')); });
      const timer = setTimeout(() => { cleanup(); reject(new Error(`characteristic ${uuid} not found`)); }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.listeners.delete(onLine); offDeath(); };
      this.listeners.add(onLine);
      this.send('list-attributes');
    });
  }

  async selectChar(uuid, timeoutMs) {
    this.send('menu gatt');
    await delay(200);
    const path = await this.resolveCharPath(uuid, timeoutMs);
    this.send(`select-attribute ${path}`);
    await delay(400);
    return path;
  }

  // FA02 is write-without-response. bluetoothctl's bare `write` defaults to a
  // write-REQUEST (with response), which FA02 rejects (org.bluez.Error.NotSupported).
  // Quoting the data frees the positional slots so we can pass offset 0 + type
  // `command` (= write-without-response).
  async write(bytes) {
    this.send(`write "${toWriteArg(bytes)}" 0 command`);
    // Surface a controller-side failure instead of falsely reporting success.
    try {
      const line = await this.waitFor((l) => /Failed to write/i.test(l), 250);
      throw new Error(line.slice(line.indexOf('Failed to write')));
    } catch (e) {
      if (/^Failed to write/.test(e.message)) throw e;
      // timeout (no failure line) = treated as success
    }
    await delay(80);
  }

  // Fire-and-pace a write without waiting for a failure line (for the heartbeat).
  async writeNoWait(bytes) {
    this.send(`write "${toWriteArg(bytes)}" 0 command`);
    await delay(60);
  }

  // Upload a full 32x32 frame: enable DIY mode, then stream the framed PNG to
  // FA02 as write-without-response packets (≤mtu each — the device reassembles).
  async uploadImage(png, { mtu = 20, pace = 25 } = {}) {
    await this.write(DIY_ON);
    const payload = frameImage(png);
    for (let i = 0; i < payload.length; i += mtu) {
      const slice = [...payload.subarray(i, i + mtu)];
      this.send(`write "${toWriteArg(slice)}" 0 command`);
      await delay(pace);
    }
    await delay(300); // allow the device to finish reassembling/rendering
    return payload.length;
  }

  async disconnect(mac) {
    try { this.send('back'); } catch { /* ignore */ }
    try { this.send(`disconnect ${mac}`); } catch { /* ignore */ }
    await delay(400);
  }

  stop() {
    if (this.proc) {
      try { if (!this.closed) this.send('quit'); } catch { /* ignore */ }
      try { this.proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
    this._die(); // wake any in-flight waiters and mark closed synchronously
  }
}

// ── live Claude quota → severity color ──────────────────────────────────────
// Same token-free endpoint the extension uses; falls back to its on-disk cache.
async function readClaudeUsage() {
  try {
    const cred = JSON.parse(readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8'));
    const token = cred?.claudeAiOauth?.accessToken;
    if (!token) throw new Error('no accessToken');
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    });
    if (!res.ok) throw new Error(`usage API ${res.status}`);
    return { usage: await res.json(), source: 'api' };
  } catch (e) {
    const cachePath = join(homedir(), '.cache', 'coding-agent-quota', 'claude_usage.json');
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    return { usage: cached.usage || cached, source: `cache (${e.message})` };
  }
}

// Worst utilization (%) across every window that reports one.
function worstUtilization(usage) {
  let worst = 0;
  for (const v of Object.values(usage)) {
    if (v && typeof v === 'object' && typeof v.utilization === 'number') {
      worst = Math.max(worst, v.utilization);
    }
  }
  return worst;
}

// green <50, orange 50–80, red ≥80 — mirrors the panel indicator severity.
function severityColor(pct) {
  if (pct >= 80) return [255, 0, 0];
  if (pct >= 50) return [255, 90, 0];
  return [0, 255, 0];
}

// Codex pushes rate_limits into its session JSONL. Read the newest token_count
// from the most-recently-modified session file (tail-read to dodge huge logs).
// Returns { pct, plan } or null when no Codex sessions exist.
function readCodexUsage() {
  const root = join(homedir(), '.codex', 'sessions');
  let files;
  try { files = readdirSync(root, { recursive: true }).filter((f) => f.endsWith('.jsonl')); }
  catch { return null; }
  let newest = null, newestM = 0;
  for (const rel of files) {
    const f = join(root, rel);
    let m; try { m = statSync(f).mtimeMs; } catch { continue; }
    if (m > newestM) { newestM = m; newest = f; }
  }
  if (!newest) return null;
  const fd = openSync(newest, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, 65536);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || !line.includes('rate_limits')) continue;
      try {
        const rl = JSON.parse(line)?.payload?.rate_limits;
        if (rl) {
          return {
            p5h: rl.primary?.used_percent ?? 0,
            pWk: rl.secondary?.used_percent ?? 0,
            r5h: rl.primary?.resets_at ? rl.primary.resets_at * 1000 : null,
            rWk: rl.secondary?.resets_at ? rl.secondary.resets_at * 1000 : null,
            plan: rl.plan_type ?? null,
          };
        }
      } catch { /* partial/tail-truncated line — skip */ }
    }
    return null;
  } finally { closeSync(fd); }
}

// ── 32x32 framebuffer → PNG → iDotMatrix DIY image upload ────────────────────
const DIY_ON = [0x05, 0x00, 0x04, 0x01, 0x01]; // enter DIY draw mode

// 5x7 bitmap glyphs (digits + labels) for the dense readout.
const GLYPHS = {
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00010','00100','01000','11111'],
  '3': ['11111','00010','00100','00010','00001','10001','01110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  '5': ['11111','10000','11110','00001','00001','10001','01110'],
  '6': ['00110','01000','10000','11110','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','00010','01100'],
  'C': ['01110','10001','10000','10000','10000','10001','01110'],
  'X': ['10001','10001','01010','00100','01010','10001','10001'],
  '-': ['00000','00000','00000','11111','00000','00000','00000'],
  '?': ['01110','10001','00010','00100','00100','00000','00100'],
};

function drawGlyph(set, gx, gy, ch, color) {
  const g = GLYPHS[ch];
  if (!g) return;
  for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (g[r][c] === '1') set(gx + c, gy + r, color);
}

function drawText(set, x, y, str, color) {
  let gx = x;
  for (const ch of str) { drawGlyph(set, gx, y, ch, color); gx += 6; }
}

// Dense per-service readout: dim label (C/X) + big % number + a full-width
// progress bar. Claude on the top half, Codex on the bottom; severity-colored.
function daysLeft(ms) {
  if (ms == null) return null;
  return Math.max(0, Math.ceil((ms - Date.now()) / 86400000));
}

// Dense 4-row readout: C5/C7/X5/X7 = Claude/Codex × 5-hour/weekly. Each row =
// dim label + % (severity color) + (5h: mini bar | weekly: days-to-reset, cyan).
function renderQuotaDetail(claude, codex, W = 32, H = 32) {
  const buf = Buffer.alloc(W * H * 3);
  const set = (x, y, color) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = (y * W + x) * 3; buf[i] = color[0]; buf[i + 1] = color[1]; buf[i + 2] = color[2];
  };
  const num2 = (p) => { const n = Math.round(clamp(p, 0, 100)); return String(n >= 100 ? 99 : n); };
  const row = (y0, label, win, weekly) => {
    if (!win) { drawText(set, 0, y0, label, [60, 60, 60]); drawText(set, 13, y0, '--', [60, 60, 60]); return; }
    const pct = weekly ? win.pWk : win.p5h;
    const col = severityColor(pct);
    drawText(set, 0, y0, label, [70, 70, 70]);   // label   cols 0-11
    drawText(set, 13, y0, num2(pct), col);        // percent cols 13-23
    if (weekly) {
      const d = daysLeft(win.rWk);
      drawText(set, 25, y0, d == null ? '?' : String(Math.min(d, 9)), [0, 170, 255]); // days to reset
    } else {
      const fill = Math.round(clamp(pct, 0, 100) / 100 * 7);
      for (let i = 0; i < 7; i++) for (let dy = 2; dy < 6; dy++) set(25 + i, y0 + dy, i < fill ? col : [22, 22, 22]);
    }
  };
  row(0, 'C5', claude, false);
  row(8, 'C7', claude, true);
  row(16, 'X5', codex, false);
  row(24, 'X7', codex, true);
  return buf;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

// Minimal PNG encoder (8-bit truecolor RGB) using built-in zlib — zero deps.
function encodePng(rgb, w = 32, h = 32) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // bit depth 8, color type 2 (RGB)
  const stride = 1 + w * 3;
  const raw = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) { raw[y * stride] = 0; rgb.copy(raw, y * stride + 1, y * w * 3, (y + 1) * w * 3); }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// iDotMatrix DIY framing: per ≤4096-byte PNG chunk, a 9-byte header
// [idk:2 LE][00 00][flag][png_len:4 LE]; flag 0x00 for first chunk, 0x02 after.
function frameImage(png) {
  const nchunks = Math.max(1, Math.ceil(png.length / 4096));
  const idk = png.length + nchunks;
  const parts = [];
  for (let ci = 0; ci < nchunks; ci++) {
    const chunk = png.subarray(ci * 4096, ci * 4096 + 4096);
    const header = Buffer.from([
      idk & 0xff, (idk >> 8) & 0xff, 0x00, 0x00, ci > 0 ? 0x02 : 0x00,
      png.length & 0xff, (png.length >> 8) & 0xff, (png.length >> 16) & 0xff, (png.length >> 24) & 0xff,
    ]);
    parts.push(header, chunk);
  }
  return Buffer.concat(parts);
}

// Terminal preview of a framebuffer for --dry-run.
function asciiPreview(rgb, w = 32, h = 32) {
  let out = '';
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3, m = Math.max(rgb[i], rgb[i + 1], rgb[i + 2]);
      row += m > 80 ? '#' : m > 0 ? '.' : ' ';
    }
    out += row + '\n';
  }
  return out;
}

// ── main orchestration ──────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = (...a) => console.error('[idm]', ...a);

  // Read current Claude + Codex per-window usage (5h + weekly % + reset times).
  async function fetchQuota() {
    const { usage, source } = await readClaudeUsage();
    const c5 = usage.five_hour, cw = usage.seven_day;
    const claude = {
      p5h: c5?.utilization ?? 0, pWk: cw?.utilization ?? 0,
      r5h: c5?.resets_at ? Date.parse(c5.resets_at) : null,
      rWk: cw?.resets_at ? Date.parse(cw.resets_at) : null,
    };
    const cx = readCodexUsage();
    const codex = cx ? { p5h: cx.p5h, pWk: cx.pWk, r5h: cx.r5h, rWk: cx.rWk } : null;
    log(`Claude 5h ${Math.round(claude.p5h)}%/7d ${Math.round(claude.pWk)}% [${source}]`
      + (cx ? `, Codex 5h ${Math.round(codex.p5h)}%/7d ${Math.round(codex.pWk)}% [${cx.plan || '?'}]` : ', Codex n/a'));
    return { claude, codex };
  }

  if (opts.dryRun) {
    if (opts.quota) {
      const { claude, codex } = await fetchQuota();
      const fb = renderQuotaDetail(claude, codex);
      const png = encodePng(fb);
      console.log(`png ${png.length}B, framed ${frameImage(png).length}B`);
      console.log('rows C5/C7/X5/X7 = Claude/Codex × 5h/weekly; weekly right digit = days to reset:');
      process.stdout.write(asciiPreview(fb));
    } else if (opts.off) {
      console.log(`char ${CHAR_WRITE}\nwrite ${toWriteArg(PROTO.screenOff())}`);
    } else {
      console.log(`char ${CHAR_WRITE}`);
      for (const c of [PROTO.screenOn(), PROTO.brightness(80), PROTO.fill(...hexToRgb(opts.color))]) {
        console.log(`write ${toWriteArg(c)}`);
      }
    }
    return;
  }

  const release = acquireLock();
  const bt = new BtCtl({ debug: opts.debug });
  let cleaned = false;
  const cleanup = () => { if (cleaned) return; cleaned = true; try { bt.stop(); } catch { /* */ } release(); };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  let mac = opts.mac;
  let alreadyConnected = false;
  try {
    bt.start();
    bt.send('power on');
    await delay(600);

    if (!mac) {
      const conn = await bt.connectedDevice(NAME_PREFIXES);
      if (conn) {
        log(`already connected: ${conn.name} @ ${conn.mac}`);
        mac = conn.mac;
        alreadyConnected = true;
      }
    }
    if (!mac) {
      log('scanning for iDotMatrix...');
      const dev = await bt.scanForDevice(NAME_PREFIXES, opts.timeout * 1000);
      log(`found ${dev.name} @ ${dev.mac}`);
      mac = dev.mac;
    }

    log(`connecting to ${mac}...`);
    await bt.connect(mac, opts.timeout * 1000, 2, alreadyConnected);
    log('connected; selecting characteristic...');
    const path = await bt.selectChar(CHAR_WRITE, opts.timeout * 1000);
    log(`selected ${path}`);

    if (!opts.off) { await bt.write(PROTO.screenOn()); await bt.write(PROTO.brightness(80)); }

    const showQuota = async () => {
      const { claude, codex } = await fetchQuota();
      const png = encodePng(renderQuotaDetail(claude, codex));
      const n = await bt.uploadImage(png);
      log(`dashboard uploaded (${png.length}B png, ${n}B framed)`);
    };

    if (opts.off) {
      await bt.write(PROTO.screenOff());
      log('✓ screen off');
    } else if (opts.quota) {
      await showQuota();
      // Live heartbeat: a top-right dot blinks to show real-time comms; data
      // refreshes every `refresh` seconds. --beats N runs N blinks then exits.
      const beatMs = 600;
      const refreshMs = (opts.watch > 0 ? opts.watch : 30) * 1000;
      const maxBeats = opts.beats > 0 ? opts.beats : Infinity;
      log(maxBeats === Infinity ? 'live — heartbeat blinking, Ctrl-C to stop' : `heartbeat ${opts.beats} beats`);
      let sinceRefresh = 0;
      for (let b = 0; b < maxBeats; b++) {
        const on = b % 2 === 0;
        await bt.writeNoWait(PROTO.setPixel(31, 0, ...(on ? [0, 200, 255] : [6, 6, 6])));
        await delay(beatMs);
        sinceRefresh += beatMs;
        if (sinceRefresh >= refreshMs) { sinceRefresh = 0; await showQuota(); }
      }
    } else {
      await bt.write(PROTO.fill(...hexToRgb(opts.color)));
      log('✓ done — the panel now reflects current usage');
    }

    if (mac && !opts.keep) await bt.disconnect(mac);
  } finally {
    cleanup();
  }
}

// Run main only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    if (err && err.code === 'ELOCKED') { console.error('[idm]', err.message); process.exit(3); }
    console.error('[idm] error:', err && err.message ? err.message : err);
    process.exit(1);
  });
}
