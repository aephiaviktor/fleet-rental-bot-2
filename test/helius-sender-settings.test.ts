import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DEFAULT_SETTINGS, validateSettings } from '../src/settings-store.js';

test('basic Helius Sender settings use Fleet Rental Bot 1 normal-send defaults', () => {
  assert.equal(DEFAULT_SETTINGS.useHeliusSender, false);
  assert.equal(DEFAULT_SETTINGS.transactionPriorityFeeMicroLamports, 1_000);
  assert.equal(DEFAULT_SETTINGS.heliusSenderTipSol, 0.0002);
  assert.equal('aggressiveSendIntervalMs' in DEFAULT_SETTINGS, false);
  assert.equal('heliusPriorityFeeMaxMicroLamports' in DEFAULT_SETTINGS, false);
});

test('legacy settings default the newly added basic Helius Sender controls', () => {
  const legacy = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  delete legacy.useHeliusSender;
  delete legacy.transactionPriorityFeeMicroLamports;
  delete legacy.heliusSenderTipSol;
  const migrated = validateSettings(legacy);
  assert.equal(migrated.useHeliusSender, false);
  assert.equal(migrated.transactionPriorityFeeMicroLamports, 1_000);
  assert.equal(migrated.heliusSenderTipSol, 0.0002);
});

test('basic Helius Sender settings validate priority fee and minimum tip', () => {
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, transactionPriorityFeeMicroLamports: 1.5 }), /Transaction priority fee/);
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, useHeliusSender: true, heliusSenderTipSol: 0.0001 }), /at least 0.0002 SOL/);
  assert.equal(validateSettings({ ...DEFAULT_SETTINGS, useHeliusSender: false, heliusSenderTipSol: 0.0001 }).heliusSenderTipSol, 0.0001);
});

test('Settings UI exposes the Fleet Rental Bot 1 Helius Sender controls', async () => {
  const [html, renderer] = await Promise.all([
    readFile(new URL('../../ui/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../../ui/app.js', import.meta.url), 'utf8'),
  ]);
  for (const id of [
    'settings-use-helius-sender',
    'settings-transaction-priority-fee',
    'settings-helius-sender-tip',
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(renderer, /useHeliusSender/);
  assert.match(renderer, /heliusSenderTipSol/);
  assert.doesNotMatch(html, /settings-aggressive-send-interval|settings-helius-priority-fee-max/);
});
