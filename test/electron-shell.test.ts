import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Electron shell keeps renderer sandboxed and transaction mode read-only', async () => {
  const main = await readFile('electron/main.cjs', 'utf8');
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /readOnly:\s*true/);
});

test('renderer uses a restrictive content security policy', async () => {
  const html = await readFile('ui/index.html', 'utf8');
  assert.match(html, /default-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test('layout follows My Star Atlas with collapsible left navigation and settings drawer', async () => {
  const html = await readFile('ui/index.html', 'utf8');
  const renderer = await readFile('ui/app.js', 'utf8');
  assert.match(html, /class="left-nav"/);
  assert.match(html, /id="sidebar-toggle"/);
  assert.match(html, /id="open-settings"/);
  assert.match(html, /id="open-rpc-usage"/);
  assert.match(html, /class="settings-drawer"/);
  assert.match(html, /Aephia API key/);
  assert.match(html, /USTUR player profile/);
  assert.match(renderer, /nav-collapsed/);
  assert.match(html, /id="add-rule-row-btn"/);
  assert.match(html, /id="rental-rules-body"/);
  assert.doesNotMatch(html, /class="settings-rail"/);
});

test('watchlist writes are exposed only through the validated IPC boundary', async () => {
  const preload = await readFile('electron/preload.cjs', 'utf8');
  const main = await readFile('electron/main.cjs', 'utf8');
  assert.match(preload, /saveWatchlist/);
  assert.doesNotMatch(preload, /require\(['"]node:fs/);
  assert.match(main, /saveWatchlist\(watchlistPath\(\), document\)/);
  assert.match(main, /refreshWatchlist\(watchlist.entries, settings\)/);
  assert.match(main, /prepareReservationReview\(entry, settings\)/);
  assert.match(preload, /reservation:review/);
  assert.match(main, /simulateReservation\(entry, settings\)/);
  assert.match(preload, /reservation:simulate/);
});
