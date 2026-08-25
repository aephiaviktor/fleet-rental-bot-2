import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, validateSettings } from '../src/settings-store.js';

const profile = 'Erdrp29yxiCVyYJgJtZz2ZYAbxiDV5UUDLNEZJsxSL7';

test('missing settings use RPC limiter and conservative defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-rental-settings-'));
  assert.deepEqual(await loadSettings(join(root, 'missing.json')), DEFAULT_SETTINGS);
  assert.equal(DEFAULT_SETTINGS.useRpcLimiter, true);
});

test('settings require HTTP RPC and bounded refresh interval', () => {
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, rpcUrl: 'file:///secret' }), /HTTP or HTTPS/);
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, refreshIntervalSeconds: 5 }), /between 15 and 3600/);
});

test('USTUR player profile must be empty or a valid Solana address', () => {
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, usturPlayerProfile: 'profile' }), /valid Solana address/);
  assert.equal(validateSettings({ ...DEFAULT_SETTINGS, usturPlayerProfile: profile }).challengerProfileAddress, profile);
});

test('early version-one settings migrate the legacy SAGE profile into USTUR', () => {
  const legacy = { ...DEFAULT_SETTINGS, challengerProfileAddress: profile } as Partial<typeof DEFAULT_SETTINGS>;
  delete legacy.usturPlayerProfile;
  assert.equal(validateSettings(legacy).usturPlayerProfile, profile);
});

test('settings persist API and limiter controls atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-rental-settings-'));
  const file = join(root, 'settings.json');
  await saveSettings(file, { ...DEFAULT_SETTINGS, aephiaApiKey: 'api-key', usturPlayerProfile: profile, useRpcLimiter: false });
  const loaded = await loadSettings(file);
  assert.equal(loaded.aephiaApiKey, 'api-key');
  assert.equal(loaded.usturPlayerProfile, profile);
  assert.equal(loaded.useRpcLimiter, false);
  assert.match(await readFile(file, 'utf8'), /"version": 1/);
});
