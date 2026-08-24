import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, validateSettings } from '../src/settings-store.js';

test('missing settings use conservative mainnet defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-rental-settings-'));
  assert.deepEqual(await loadSettings(join(root, 'missing.json')), DEFAULT_SETTINGS);
});

test('settings require HTTP RPC and bounded refresh interval', () => {
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, rpcUrl: 'file:///secret' }), /HTTP or HTTPS/);
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, refreshIntervalSeconds: 5 }), /between 15 and 3600/);
});

test('settings persist atomically without exposing the RPC URL permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-rental-settings-'));
  const file = join(root, 'settings.json');
  await saveSettings(file, { ...DEFAULT_SETTINGS, walletAddress: 'wallet' });
  assert.equal((await loadSettings(file)).walletAddress, 'wallet');
  assert.match(await readFile(file, 'utf8'), /"version": 1/);
});
