import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('hide-sensitive-data starts enabled and masks sensitive renderer fields', async () => {
  const [html, renderer, styles] = await Promise.all([
    readFile(new URL('../../ui/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../../ui/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../../ui/styles.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="hide-sensitive-data"[^>]*checked/);
  assert.match(html, /id="settings-hot-wallet-secret"[^>]*type="password"/);
  assert.match(html, /id="remove-hot-wallet"/);
  assert.match(renderer, /sensitiveHidden:true/);
  assert.match(renderer, /\[data-field=contractAddress\],\[data-field=comment\]/);
  assert.match(renderer, /sensitive\?masked\(String\(value\)\)/);
  assert.match(renderer, /settings-profile.*type=.*password/);
  assert.match(renderer, /settings-rpc.*type=.*password/);
  assert.match(styles, /sensitive-mask/);
});

test('hot-wallet secret is write-only and signing remains disabled', async () => {
  const [main, preload, html] = await Promise.all([
    readFile(new URL('../../electron/main.cjs', import.meta.url), 'utf8'),
    readFile(new URL('../../electron/preload.cjs', import.meta.url), 'utf8'),
    readFile(new URL('../../ui/index.html', import.meta.url), 'utf8'),
  ]);
  assert.match(main, /hotWalletSecret/);
  assert.match(main, /safeStorage\.encryptString/);
  assert.match(main, /getHotWalletAddressFromSecret/);
  assert.match(main, /secureSettingsStatus.*hotWalletSecret/s);
  assert.match(preload, /removeHotWallet/);
  assert.match(html, /Signing disabled/);
  assert.doesNotMatch(preload, /loadHotWalletSecret|getHotWalletSecret/);
});
