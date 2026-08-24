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

test('watchlist writes are exposed only through the validated IPC boundary', async () => {
  const preload = await readFile('electron/preload.cjs', 'utf8');
  const main = await readFile('electron/main.cjs', 'utf8');
  assert.match(preload, /saveWatchlist/);
  assert.doesNotMatch(preload, /require\(['"]node:fs/);
  assert.match(main, /saveWatchlist\(watchlistPath\(\), document\)/);
});
