import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, validateSettings, ownedWalletAddresses } from '../src/settings-store.js';

const profile = 'Erdrp29yxiCVyYJgJtZz2ZYAbxiDV5UUDLNEZJsxSL7';

test('missing settings use the dedicated five request-per-second default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-rental-settings-'));
  assert.deepEqual(await loadSettings(join(root, 'missing.json')), DEFAULT_SETTINGS);
  assert.equal(DEFAULT_SETTINGS.useRpcLimiter, false);
  assert.equal(DEFAULT_SETTINGS.rpcRequestsPerSecond, 5);
});

test('settings require HTTP RPC and a conservative dedicated request rate', () => {
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, rpcUrl: 'file:///secret' }), /HTTP or HTTPS/);
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, rpcRequestsPerSecond: 0 }), /between 1 and 10/);
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, rpcRequestsPerSecond: 11 }), /between 1 and 10/);
  assert.equal(validateSettings({ ...DEFAULT_SETTINGS, rpcRequestsPerSecond: undefined }).rpcRequestsPerSecond, 5);
});

test('player profile must be empty or a valid Solana address', () => {
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, playerProfile: 'profile' }), /valid Solana address/);
  const settings = validateSettings({ ...DEFAULT_SETTINGS, playerProfile: profile });
  assert.equal(settings.playerProfile, profile);
  assert.equal(settings.challengerProfileAddress, profile);
});

test('main and lancer wallet addresses must be empty or valid Solana addresses', () => {
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, mainWalletAddress: 'nope' }), /valid Solana address/);
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, lancerWalletAddress: 'nope' }), /valid Solana address/);
  const settings = validateSettings({
    ...DEFAULT_SETTINGS,
    walletAddress: 'E3Lh2ScF9c9ZZjoTAeNNApFZiQV1Q6GBmvgsKLh8xkL3',
    mainWalletAddress: profile,
    lancerWalletAddress: 'FiELMQBWWxRtv78dQQcpD2McCsrRZMhgbXETrH1EyMk7',
  });
  assert.equal(settings.walletAddress, 'E3Lh2ScF9c9ZZjoTAeNNApFZiQV1Q6GBmvgsKLh8xkL3');
  assert.equal(settings.mainWalletAddress, profile);
  assert.equal(settings.lancerWalletAddress, 'FiELMQBWWxRtv78dQQcpD2McCsrRZMhgbXETrH1EyMk7');
});

test('ownedWalletAddresses returns the unique signer, main, and lancer wallets', () => {
  assert.deepEqual(ownedWalletAddresses(DEFAULT_SETTINGS), []);
  assert.deepEqual(ownedWalletAddresses({
    ...DEFAULT_SETTINGS,
    walletAddress: 'E3Lh2ScF9c9ZZjoTAeNNApFZiQV1Q6GBmvgsKLh8xkL3',
  }), ['E3Lh2ScF9c9ZZjoTAeNNApFZiQV1Q6GBmvgsKLh8xkL3']);
  assert.deepEqual(ownedWalletAddresses({
    ...DEFAULT_SETTINGS,
    walletAddress: 'E3Lh2ScF9c9ZZjoTAeNNApFZiQV1Q6GBmvgsKLh8xkL3',
    mainWalletAddress: profile,
    lancerWalletAddress: 'FiELMQBWWxRtv78dQQcpD2McCsrRZMhgbXETrH1EyMk7',
  }), ['E3Lh2ScF9c9ZZjoTAeNNApFZiQV1Q6GBmvgsKLh8xkL3', profile, 'FiELMQBWWxRtv78dQQcpD2McCsrRZMhgbXETrH1EyMk7']);
  // Duplicate addresses are collapsed without repeating.
  assert.deepEqual(ownedWalletAddresses({
    ...DEFAULT_SETTINGS,
    walletAddress: profile,
    mainWalletAddress: profile,
  }), [profile]);
});

test('version-one settings migrate faction-specific and early profile fields', () => {
  const factionSpecific = { ...DEFAULT_SETTINGS, playerProfile: undefined, usturPlayerProfile: profile };
  assert.equal(validateSettings(factionSpecific).playerProfile, profile);

  const early = { ...DEFAULT_SETTINGS, playerProfile: undefined, challengerProfileAddress: profile };
  assert.equal(validateSettings(early).playerProfile, profile);
});

test('settings persist neutral player profile and omit the obsolete faction-specific field', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-rental-settings-'));
  const file = join(root, 'settings.json');
  await saveSettings(file, { ...DEFAULT_SETTINGS, aephiaApiKey: 'api-key', playerProfile: profile, useRpcLimiter: false });
  const loaded = await loadSettings(file);
  const persisted = await readFile(file, 'utf8');
  assert.equal(loaded.aephiaApiKey, 'api-key');
  assert.equal(loaded.playerProfile, profile);
  assert.equal(loaded.useRpcLimiter, false);
  assert.match(persisted, /"playerProfile":/);
  assert.doesNotMatch(persisted, /usturPlayerProfile/);
});
