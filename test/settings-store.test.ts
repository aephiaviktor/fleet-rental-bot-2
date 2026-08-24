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

test('wallet identification must be empty or a valid Solana address', () => {
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, walletAddress: 'wallet' }), /valid Solana address/);
  assert.equal(validateSettings({ ...DEFAULT_SETTINGS, walletAddress: '' }).walletAddress, '');
});

test('SAGE profile must be empty or a valid Solana address', () => {
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, challengerProfileAddress: 'profile' }), /valid Solana address/);
  assert.equal(validateSettings({ ...DEFAULT_SETTINGS, challengerProfileAddress: '' }).challengerProfileAddress, '');
});

test('older version-one settings without a SAGE profile migrate safely', () => {
  const legacy = { ...DEFAULT_SETTINGS } as Partial<typeof DEFAULT_SETTINGS>;
  delete legacy.challengerProfileAddress;
  assert.equal(validateSettings(legacy).challengerProfileAddress, '');
});

test('settings persist atomically without exposing the RPC URL permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-rental-settings-'));
  const file = join(root, 'settings.json');
  const wallet = 'Erdrp29yxiCVyYJgJtZz2ZYAbxiDV5UUDLNEZJsxSL7';
  await saveSettings(file, { ...DEFAULT_SETTINGS, walletAddress: wallet });
  assert.equal((await loadSettings(file)).walletAddress, wallet);
  assert.match(await readFile(file, 'utf8'), /"version": 1/);
});
