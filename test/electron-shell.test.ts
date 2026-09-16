import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Electron shell keeps renderer sandboxed and limits automated signing to LCFS', async () => {
  const main = await readFile('electron/main.cjs', 'utf8');
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /readOnly:\s*false/);
  assert.match(main, /scheduleLcfsAttempts/);
  assert.match(main, /recordLcfsAttempt/);
  assert.match(main, /executeLcfsAttempt/);
  assert.match(main, /safeStorage\.encryptString/);
  assert.match(main, /safeStorage\.decryptString/);
  assert.match(main, /configureInstance/);
  assert.match(main, /requestSingleInstanceLock/);
  assert.match(main, /INSTANCE\.title/);
  assert.match(main, /icon:\s*INSTANCE\.icon/);
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
  assert.match(html, /class="nav-columns"/);
  assert.match(html, /id="column-options"/);
  assert.doesNotMatch(html, /id="columns-button"/);
  assert.doesNotMatch(html, /id="refresh-button"/);
  assert.match(html, /class="settings-drawer"/);
  assert.match(html, /Aephia API key/);
  assert.match(html, />Player Profile</);
  assert.doesNotMatch(html, /USTUR player profile/);
  assert.match(html, /id="profile-faction"/);
  assert.match(renderer, /getPlayerFaction/);
  assert.match(renderer, /Checking…/);
  assert.match(renderer, /Unknown/);
  assert.match(renderer, /nav-collapsed/);
  assert.match(renderer, /Status unavailable/);
  assert.doesNotMatch(renderer, /summary-locked|summary-defenses|summary-enabled|summary-refreshed/);
  assert.match(renderer, /Stored securely — enter a new value to replace/);
  assert.doesNotMatch(html, /Refresh interval seconds/);
  assert.match(html, /Shared across MUD \/ ONI \/ UST/);
  assert.match(html, /id="settings-rpc-rate"/);
  assert.doesNotMatch(html, /id="settings-use-limiter"/);
  assert.match(renderer, /getNextRefreshDelay/);
  assert.match(renderer, /refresh\(\[id\]\)/);
  assert.match(renderer, /loadCachedWatchlist/);
  assert.doesNotMatch(renderer, /setInterval/);
  assert.match(renderer, /Cached —/);
  assert.match(renderer, /Estimated net value \/ day/);
  assert.match(html, /id="add-rule-row-btn"/);
  assert.match(html, /id="rental-rules-body"/);
  assert.doesNotMatch(html, /class="settings-rail"/);
});

test('update control mirrors the established upper-right modal workflow', async () => {
  const [html, styles, renderer, preload, main] = await Promise.all([
    readFile('ui/index.html', 'utf8'),
    readFile('ui/styles.css', 'utf8'),
    readFile('ui/app.js', 'utf8'),
    readFile('electron/preload.cjs', 'utf8'),
    readFile('electron/main.cjs', 'utf8'),
  ]);
  assert.match(html, /class="panel-toolbar"[\s\S]*id="update-btn"/);
  assert.match(html, /id="update-modal"/);
  assert.match(html, /id="update-current-version"/);
  assert.match(html, /id="update-latest-version"/);
  assert.match(html, /id="update-confirm-btn"/);
  assert.match(styles, /\.update-btn\.update-available/);
  assert.match(renderer, /void checkForUpdates\(\)/);
  assert.match(renderer, /classList\.toggle\('update-available'/);
  assert.match(renderer, /downloadUpdateAndRestart/);
  assert.match(preload, /updates:check/);
  assert.match(preload, /updates:download-and-restart/);
  assert.match(preload, /update:progress/);
  assert.match(main, /releases\/latest/);
  assert.match(main, /PORTABLE_EXECUTABLE_FILE/);
  assert.match(main, /createHash\('sha256'\)/);
  assert.match(main, /confirmUpdateReadiness/);
  assert.match(main, /requireTrustedUpdaterRenderer/);
  assert.match(main, /senderFrame !== mainWindow\.webContents\.mainFrame/);
});

test('watchlist writes are exposed only through the validated IPC boundary', async () => {
  const preload = await readFile('electron/preload.cjs', 'utf8');
  const main = await readFile('electron/main.cjs', 'utf8');
  assert.match(preload, /saveWatchlist/);
  assert.doesNotMatch(preload, /require\(['"]node:fs/);
  assert.match(main, /saveWatchlist\(watchlistPath\(\), document\)/);
  assert.match(main, /refreshWatchlist\(selectedEntries, settings\)/);
  assert.match(main, /saveCachedRow/);
  assert.match(main, /mergeRefreshWithCache/);
  assert.match(main, /installLimitedRpcFetch/);
  assert.match(main, /withUrgentRpcPriority/);
  assert.match(main, /refresh:next-delay/);
  assert.match(preload, /watchlist:cached/);
  assert.match(preload, /watchlist:refresh', entryIds/);
  assert.match(main, /prepareReservationReview\(entry, settings\)/);
  assert.match(preload, /reservation:review/);
  assert.match(main, /simulateReservation\(entry, settings\)/);
  assert.match(preload, /reservation:simulate/);
  assert.match(preload, /getPlayerFaction/);
  assert.match(main, /profile:faction/);
});

test('Aephia access is a non-dismissible fail-closed application gate', async () => {
  const [html, styles, renderer, preload, main, access] = await Promise.all([
    readFile('ui/index.html', 'utf8'),
    readFile('ui/styles.css', 'utf8'),
    readFile('ui/app.js', 'utf8'),
    readFile('electron/preload.cjs', 'utf8'),
    readFile('electron/main.cjs', 'utf8'),
    readFile('src/aephia-access.ts', 'utf8'),
  ]);
  assert.match(html, /id="aephia-access-gate"/);
  assert.match(html, /First, enter your Aephia API key/);
  assert.match(html, /id="aephia-unlock-key"/);
  assert.doesNotMatch(html.match(/id="aephia-access-gate"[\s\S]*?<\/form>/)?.[0] ?? '', /RPC URL/i);
  assert.match(styles, /\.access-gate/);
  assert.match(renderer, /getAephiaAccessStatus/);
  assert.match(renderer, /verifyAephiaApiKey/);
  assert.match(renderer, /bootUnlocked/);
  assert.match(preload, /access:status/);
  assert.match(preload, /access:unlock/);
  assert.match(access, /https:\/\/api\.aephia\.com\/token\/validate/);
  assert.match(main, /requireAephiaAccess/);
  for (const channel of ['watchlist:load', 'watchlist:cached', 'watchlist:save', 'settings:load', 'settings:save', 'settings:remove-hot-wallet', 'profile:faction', 'rpc-limiter:status', 'refresh:next-delay', 'updates:check', 'updates:download-and-restart', 'watchlist:refresh', 'reservation:review', 'reservation:simulate']) {
    const start = main.indexOf(`ipcMain.handle('${channel}'`);
    assert.notEqual(start, -1, `${channel} handler must exist`);
    assert.match(main.slice(start, start + 220), /await requireAephiaAccess\(\)/, `${channel} must fail closed behind Aephia access`);
  }
  assert.match(main, /Aephia API key required/);
  assert.match(main, /Aephia API key validation required/);
  assert.match(main, /clearLcfsTimers/);
});
