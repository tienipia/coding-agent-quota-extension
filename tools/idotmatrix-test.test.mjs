import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import {
  PROTO, toWriteArg, CHAR_WRITE, NAME_PREFIXES, parseArgs, hexToRgb,
  stripAnsi, parseAnyDevice, parseDeviceLine, isConnected, isServicesResolved, parseCharPath,
  acquireLock, isAlive,
} from './idotmatrix-test.mjs';

test('CHAR_WRITE is the FA02 characteristic', () => {
  assert.equal(CHAR_WRITE, '0000fa02-0000-1000-8000-00805f9b34fb');
});
test('NAME_PREFIXES covers IDM- and IDF-', () => {
  assert.deepEqual(NAME_PREFIXES, ['IDM-', 'IDF-']);
});
test('screenOn bytes', () => assert.deepEqual(PROTO.screenOn(), [0x05,0x00,0x07,0x01,0x01]));
test('screenOff bytes', () => assert.deepEqual(PROTO.screenOff(), [0x05,0x00,0x07,0x01,0x00]));
test('brightness mid', () => assert.deepEqual(PROTO.brightness(50), [0x05,0x00,0x04,0x80,50]));
test('brightness clamps low to 5', () => assert.deepEqual(PROTO.brightness(0), [0x05,0x00,0x04,0x80,5]));
test('brightness clamps high to 100', () => assert.deepEqual(PROTO.brightness(150), [0x05,0x00,0x04,0x80,100]));
test('brightness rounds', () => assert.deepEqual(PROTO.brightness(49.6), [0x05,0x00,0x04,0x80,50]));
test('fill red bytes', () => assert.deepEqual(PROTO.fill(255,0,0), [0x07,0x00,0x02,0x02,255,0,0]));
test('fill clamps channels', () => assert.deepEqual(PROTO.fill(-5,300,0), [0x07,0x00,0x02,0x02,0,255,0]));
test('toWriteArg formats lowercase 0xNN', () => {
  assert.equal(toWriteArg([0x05,0x00,0x07,0x01,0x01]), '0x05 0x00 0x07 0x01 0x01');
});
test('toWriteArg pads single digit', () => assert.equal(toWriteArg([0x0a]), '0x0a'));

test('parseArgs defaults', () => {
  assert.deepEqual(parseArgs([]), {
    color: 'FF0000', off: false, keep: false, dryRun: false, debug: false, quota: false, watch: 0, beats: 0, mac: null, timeout: 20,
  });
});
test('parseArgs --watch with value', () => assert.equal(parseArgs(['--watch','60']).watch, 60));
test('parseArgs --watch bare defaults to 300', () => assert.equal(parseArgs(['--watch']).watch, 300));
test('parseArgs parses all flags', () => {
  const o = parseArgs(['--off','--keep','--dry-run','--debug','--quota','--color','00FF00','--mac','AA:BB:CC:DD:EE:FF','--timeout','5']);
  assert.equal(o.off, true);
  assert.equal(o.keep, true);
  assert.equal(o.dryRun, true);
  assert.equal(o.debug, true);
  assert.equal(o.quota, true);
  assert.equal(o.color, '00FF00');
  assert.equal(o.mac, 'AA:BB:CC:DD:EE:FF');
  assert.equal(o.timeout, 5);
});
test('parseArgs rejects unknown flag', () => assert.throws(() => parseArgs(['--nope']), /unknown arg/));
test('hexToRgb red', () => assert.deepEqual(hexToRgb('FF0000'), [255, 0, 0]));
test('hexToRgb green with hash', () => assert.deepEqual(hexToRgb('#00FF00'), [0, 255, 0]));
test('hexToRgb blue lowercase', () => assert.deepEqual(hexToRgb('0000ff'), [0, 0, 255]));
test('hexToRgb invalid throws', () => assert.throws(() => hexToRgb('xyz'), /invalid color/));
test('parseArgs rejects non-numeric --timeout', () => assert.throws(() => parseArgs(['--timeout','foo']), /--timeout/));

test('stripAnsi removes SGR color codes', () => {
  assert.equal(stripAnsi('\x1b[0;94mhi\x1b[0m'), 'hi');
});
test('parseAnyDevice extracts mac and trailing name', () => {
  assert.deepEqual(parseAnyDevice('[NEW] Device AA:BB:CC:DD:EE:FF IDM-1234'),
    { mac: 'AA:BB:CC:DD:EE:FF', name: 'IDM-1234' });
});
test('parseAnyDevice handles Name: form', () => {
  assert.deepEqual(parseAnyDevice('[CHG] Device AA:BB:CC:DD:EE:FF Name: IDF-19000F'),
    { mac: 'AA:BB:CC:DD:EE:FF', name: 'IDF-19000F' });
});
test('parseAnyDevice returns null for non-device line', () => {
  assert.equal(parseAnyDevice('[bluetooth]# scan on'), null);
});
test('parseDeviceLine matches wanted prefix', () => {
  assert.deepEqual(parseDeviceLine('[NEW] Device AA:BB:CC:DD:EE:FF IDM-1234', NAME_PREFIXES),
    { mac: 'AA:BB:CC:DD:EE:FF', name: 'IDM-1234' });
});
test('parseDeviceLine matches IDF prefix via Name:', () => {
  assert.deepEqual(parseDeviceLine('[CHG] Device 11:22:33:44:55:66 Name: IDF-19000F', NAME_PREFIXES),
    { mac: '11:22:33:44:55:66', name: 'IDF-19000F' });
});
test('parseDeviceLine ignores non-matching device', () => {
  assert.equal(parseDeviceLine('[NEW] Device 11:22:33:44:55:66 JBL-Speaker', NAME_PREFIXES), null);
});
test('isConnected detects success line (with ansi)', () => {
  assert.ok(isConnected('\x1b[0;94m[CHG]\x1b[0m Device AA:BB:CC:DD:EE:FF Connection successful'));
});
test('isConnected false otherwise', () => assert.ok(!isConnected('[CHG] Device AA: Connected: no')));
test('isServicesResolved detects yes', () => {
  assert.ok(isServicesResolved('[CHG] Device AA:BB:CC:DD:EE:FF ServicesResolved: yes'));
});
test('isServicesResolved false for no', () => {
  assert.ok(!isServicesResolved('[CHG] Device AA: ServicesResolved: no'));
});
test('parseCharPath finds FA02 object path', () => {
  const lines = [
    'Characteristic (Handle 0x000d)',
    '\t/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF/service000c/char000d',
    '\t0000fa02-0000-1000-8000-00805f9b34fb',
    '\tVendor specific',
  ];
  assert.equal(parseCharPath(lines, CHAR_WRITE),
    '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF/service000c/char000d');
});
test('parseCharPath returns null when uuid absent', () => {
  const lines = [
    '\t/org/bluez/hci0/dev_AA/service0001/char0002',
    '\t00002a00-0000-1000-8000-00805f9b34fb',
  ];
  assert.equal(parseCharPath(lines, CHAR_WRITE), null);
});

test('isAlive true for current process', () => assert.ok(isAlive(process.pid)));
test('isAlive false for impossible pid', () => assert.ok(!isAlive(2147480000)));

test('acquireLock creates lock then release removes it', () => {
  const p = join(tmpdir(), `idm-lock-basic-${process.pid}.lock`);
  rmSync(p, { force: true });
  const release = acquireLock(p);
  assert.ok(existsSync(p));
  release();
  assert.ok(!existsSync(p));
});

test('acquireLock throws ELOCKED when a live pid holds it', () => {
  const p = join(tmpdir(), `idm-lock-live-${process.pid}.lock`);
  writeFileSync(p, String(process.pid)); // our own pid = alive
  try {
    assert.throws(() => acquireLock(p), (e) => e.code === 'ELOCKED' && e.pid === process.pid);
  } finally {
    rmSync(p, { force: true });
  }
});

test('acquireLock steals a stale lock (dead pid)', () => {
  const p = join(tmpdir(), `idm-lock-stale-${process.pid}.lock`);
  writeFileSync(p, '2147480000'); // dead/impossible pid
  let release;
  try {
    release = acquireLock(p);
    assert.ok(existsSync(p));
  } finally {
    release?.();
    rmSync(p, { force: true });
  }
});

test('release is idempotent', () => {
  const p = join(tmpdir(), `idm-lock-idem-${process.pid}.lock`);
  rmSync(p, { force: true });
  const release = acquireLock(p);
  release();
  release(); // must not throw
  assert.ok(!existsSync(p));
});
