const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const { configureInstance } = require('./instance.cjs');
const { getHotWalletAddressFromSecret } = require('./wallet-secret.cjs');
const { buildWindowsPortableUpdateScript, compareVersions, parseLatestRelease } = require('./update-policy.cjs');

const INSTANCE = configureInstance(app, process.argv);
const hasSingleInstanceLock = app.requestSingleInstanceLock({ instance: INSTANCE.instance });
let mainWindow = null;
const lcfsTimers = new Map();
let lcfsStateWrite = Promise.resolve();
const LATEST_RELEASE_URL = 'https://api.github.com/repos/aephiaviktor/fleet-rental-bot-2/releases/latest';

async function domainModule(name) {
  return import(`../dist/src/${name}.js`);
}

function emitUpdateProgress(phase, message) {
  if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('update:progress', { phase, message });
}

async function getLatestRelease() {
  const response = await fetch(`${LATEST_RELEASE_URL}?t=${Date.now()}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'Cache-Control': 'no-cache',
      'User-Agent': 'fleet-rental-bot-2-updater',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub Releases request failed: HTTP ${response.status}`);
  return parseLatestRelease(await response.json());
}

async function checkForUpdates() {
  const currentVersion = app.getVersion();
  const latest = await getLatestRelease();
  return {
    currentVersion,
    latestVersion: latest.version,
    updateAvailable: compareVersions(latest.version, currentVersion) > 0,
    releaseUrl: latest.releaseUrl,
    installSupported: app.isPackaged && process.platform === 'win32' && Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
  };
}

function commandLineValue(name) {
  const prefix = `${name}=`;
  const direct = process.argv.find((value) => String(value).startsWith(prefix));
  if (direct) return String(direct).slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

async function confirmUpdateReadiness() {
  const readyValue = commandLineValue('--update-ready-file');
  const token = commandLineValue('--update-token');
  if (!readyValue || !/^[a-f0-9-]{36}$/i.test(token)) return;
  const readyPath = path.resolve(readyValue);
  const tempRoot = path.resolve(app.getPath('temp'));
  const relative = path.relative(tempRoot, readyPath);
  const parentName = path.basename(path.dirname(readyPath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
      || path.basename(readyPath) !== 'ready.json' || !parentName.startsWith('fleet-rental-bot-2-update-')) return;
  await fs.writeFile(readyPath, JSON.stringify({ token, version: app.getVersion(), instance: INSTANCE.instance }), { mode: 0o600 });
}

function requireTrustedUpdaterRenderer(event) {
  const expectedUrl = pathToFileURL(path.join(__dirname, '..', 'ui', 'index.html')).href;
  if (!mainWindow || event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame?.url !== expectedUrl) {
    throw new Error('Untrusted updater request rejected.');
  }
}

async function downloadUpdateAndRestart() {
  if (!app.isPackaged || process.platform !== 'win32' || !process.env.PORTABLE_EXECUTABLE_FILE) {
    throw new Error('In-app installation is available only in the packaged Windows portable application.');
  }
  const currentVersion = app.getVersion();
  const latest = await getLatestRelease();
  if (compareVersions(latest.version, currentVersion) <= 0) {
    return { updated: false, currentVersion, latestVersion: latest.version };
  }

  const targetPath = path.resolve(process.env.PORTABLE_EXECUTABLE_FILE);
  const targetDirectory = path.dirname(targetPath);
  const writeProbe = path.join(targetDirectory, `.fleet-rental-bot-2-update-${process.pid}.tmp`);
  await fs.writeFile(writeProbe, '').then(() => fs.unlink(writeProbe)).catch(() => {
    throw new Error('The application folder is not writable; move the portable executable to a writable folder and try again.');
  });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-rental-bot-2-update-'));
  const stagedPath = path.join(tempDir, latest.asset.name);
  const readyPath = path.join(tempDir, 'ready.json');
  const backupPath = `${targetPath}.update-backup`;
  const token = crypto.randomUUID();
  try {
    emitUpdateProgress('downloading', `Downloading Fleet Rental Bot 2 v${latest.version}…`);
    const response = await fetch(latest.asset.downloadUrl, {
      headers: { 'User-Agent': 'fleet-rental-bot-2-updater' },
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) throw new Error(`Update download failed: HTTP ${response.status}`);
    const declaredSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > 0 && declaredSize !== latest.asset.size) {
      throw new Error('Update download size does not match the official release metadata.');
    }
    const contents = Buffer.from(await response.arrayBuffer());
    if (contents.length !== latest.asset.size) throw new Error('Downloaded update size does not match the official release asset.');
    if (contents[0] !== 0x4d || contents[1] !== 0x5a) throw new Error('Downloaded update is not a Windows executable.');
    const digest = crypto.createHash('sha256').update(contents).digest('hex');
    if (digest !== latest.asset.sha256) throw new Error('Downloaded update failed SHA-256 verification.');
    await fs.writeFile(stagedPath, contents, { mode: 0o700 });

    emitUpdateProgress('staging', 'Update verified. Preparing a safe restart…');
    const scriptPath = path.join(tempDir, 'install-update.ps1');
    await fs.writeFile(scriptPath, buildWindowsPortableUpdateScript({
      parentPid: process.pid,
      targetPath,
      stagedPath,
      backupPath,
      readyPath,
      token,
      instance: INSTANCE.instance,
    }), 'utf8');
    const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      cwd: tempDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      helper.once('spawn', resolve);
      helper.once('error', reject);
    });
    helper.unref();
    emitUpdateProgress('restarting', `Fleet Rental Bot 2 v${latest.version} verified. Restarting…`);
    setTimeout(() => app.quit(), 250);
    return { updated: true, currentVersion, latestVersion: latest.version, staged: true };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function watchlistPath() {
  return path.join(app.getPath('userData'), 'watchlist.json');
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function secureSettingsPath() {
  return path.join(app.getPath('userData'), 'secure-settings.json');
}

function lcfsStatePath() {
  return path.join(app.getPath('userData'), 'lcfs-state.json');
}

function sharedDatabasePath() {
  return path.join(path.dirname(path.dirname(INSTANCE.userData)), 'fleet-rental-bot-2.sqlite');
}

async function readLcfsState() {
  try {
    const value = JSON.parse(await fs.readFile(lcfsStatePath(), 'utf8'));
    return value && Array.isArray(value.attempts) ? value : { version: 1, attempts: [] };
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, attempts: [] };
    throw error;
  }
}

async function recordLcfsAttempt(key, status, detail = '') {
  let recorded = false;
  lcfsStateWrite = lcfsStateWrite.catch(() => {}).then(async () => {
    const state = await readLcfsState();
    const existing = state.attempts.find((attempt) => attempt.key === key);
    if (existing && status === 'started') return;
    if (existing) Object.assign(existing, { status, detail, updatedAt: new Date().toISOString() });
    else state.attempts.push({ key, status, detail, updatedAt: new Date().toISOString() });
    state.attempts = state.attempts.slice(-500);
    const filePath = lcfsStatePath();
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
    recorded = true;
  });
  await lcfsStateWrite;
  return recorded;
}

function emitLcfsStatus(entryId, status, detail) {
  if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('lcfs:status', { entryId, status, detail });
}

async function scheduleLcfsAttempts(watchlist, settings, results, refreshedEntryIds = null) {
  const [{ evaluateLcfsEligibility, executeLcfsAttempt, lcfsAttemptKey }, state] = await Promise.all([
    domainModule('lcfs'), readLcfsState(),
  ]);
  const attempted = new Set(state.attempts.map((attempt) => attempt.key));
  const eligibleKeys = new Set();
  if (!settings.useHeliusSender || !settings.hotWalletSecret) {
    for (const timer of lcfsTimers.values()) clearTimeout(timer);
    lcfsTimers.clear();
    return;
  }
  const nowMs = Date.now();
  for (const result of results) {
    if (!result.ok) continue;
    const entry = watchlist.entries.find((candidate) => candidate.id === result.id);
    if (!entry?.lcfs) continue;
    const decision = evaluateLcfsEligibility(entry, result.row.snapshot, result.row.position, settings.lcfsLeadTimeSeconds, nowMs);
    if (decision.kind === 'blocked') continue;
    const key = lcfsAttemptKey(entry.id, decision.plan.activeRentalEndsAtMs);
    eligibleKeys.add(key);
    if (attempted.has(key) || lcfsTimers.has(key)) continue;
    const delay = Math.max(0, decision.executeAtMs - nowMs);
    if (delay > 2_147_000_000) continue;
    const timer = setTimeout(async () => {
      lcfsTimers.delete(key);
      try {
        if (!await recordLcfsAttempt(key, 'started')) return;
        emitLcfsStatus(entry.id, 'sending', 'Re-checking live limits and submitting LCFS bid');
        const [latestWatchlist, latestSettings] = await Promise.all([
          (await domainModule('watchlist-store')).loadWatchlist(watchlistPath()), loadRuntimeSettings(),
        ]);
        const latestEntry = latestWatchlist.entries.find((candidate) => candidate.id === entry.id);
        if (!latestEntry) throw new Error('Watchlist entry no longer exists');
        if (latestEntry.contractAddress !== entry.contractAddress) throw new Error('Rental contract changed after this LCFS attempt was scheduled');
        const { withUrgentRpcPriority } = await domainModule('rpc-fetch-limiter');
        const outcome = await withUrgentRpcPriority(sharedDatabasePath(), () => executeLcfsAttempt(
          latestEntry, latestSettings, latestSettings.hotWalletSecret, undefined, {}, decision.plan.activeRentalEndsAtMs,
        ));
        if (outcome.kind === 'submitted') {
          await recordLcfsAttempt(key, 'submitted', outcome.signature);
          emitLcfsStatus(entry.id, 'submitted', `LCFS transaction submitted: ${outcome.signature}`);
        } else {
          await recordLcfsAttempt(key, 'blocked', outcome.reason);
          emitLcfsStatus(entry.id, 'blocked', outcome.reason);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await recordLcfsAttempt(key, 'failed', detail).catch(() => {});
        emitLcfsStatus(entry.id, 'failed', detail);
      }
    }, delay);
    lcfsTimers.set(key, timer);
    emitLcfsStatus(entry.id, 'scheduled', `LCFS bid scheduled for ${new Date(decision.executeAtMs).toLocaleTimeString()}`);
  }
  for (const [key, timer] of lcfsTimers) {
    if (refreshedEntryIds && ![...refreshedEntryIds].some((entryId) => key.startsWith(`${entryId}:`))) continue;
    if (!eligibleKeys.has(key)) { clearTimeout(timer); lcfsTimers.delete(key); }
  }
}

async function readSecureDocument() {
  try {
    const document = JSON.parse(await fs.readFile(secureSettingsPath(), 'utf8'));
    return document && typeof document === 'object' ? document : { version: 1 };
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1 };
    throw error;
  }
}

async function readSecureValue(key) {
  const document = await readSecureDocument();
  const encrypted = String(document[key] || '');
  if (!encrypted) return '';
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS safe storage is unavailable.');
  return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
}

async function writeSecureValues(replacements) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS safe storage is unavailable; secure settings were not changed.');
  const document = await readSecureDocument();
  for (const [key, value] of Object.entries(replacements)) {
    document[key] = value ? safeStorage.encryptString(String(value)).toString('base64') : '';
  }
  document.version = 1;
  const filePath = secureSettingsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

async function loadSettingsWithSecrets() {
  const { loadSettings, saveSettings } = await domainModule('settings-store');
  const settings = await loadSettings(settingsPath());
  let aephiaApiKey = await readSecureValue('aephiaApiKey');
  if (!aephiaApiKey && settings.aephiaApiKey) {
    aephiaApiKey = settings.aephiaApiKey;
    await writeSecureValues({ aephiaApiKey });
    await saveSettings(settingsPath(), { ...settings, aephiaApiKey: '' });
  }
  return { ...settings, aephiaApiKey, hotWalletSecret: await readSecureValue('hotWalletSecret') };
}

async function loadRuntimeSettings() {
  const { getRpcRequestsPerSecond } = await domainModule('fleet-database');
  const settings = await loadSettingsWithSecrets();
  const walletAddress = settings.hotWalletSecret
    ? getHotWalletAddressFromSecret(settings.hotWalletSecret)
    : settings.walletAddress;
  return { ...settings, walletAddress, rpcRequestsPerSecond: getRpcRequestsPerSecond(sharedDatabasePath()), rpcUrl: settings.rpcUrl };
}

function secureSettingsStatus(settings) {
  return {
    aephiaApiKey: Boolean(settings.aephiaApiKey),
    hotWalletSecret: Boolean(settings.hotWalletSecret),
  };
}

function hotWalletAddress(settings) {
  return settings.hotWalletSecret ? getHotWalletAddressFromSecret(settings.hotWalletSecret) : '';
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#07111a',
    title: INSTANCE.title,
    icon: INSTANCE.icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();
  void mainWindow.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  mainWindow.webContents.once('did-finish-load', () => { void confirmUpdateReadiness(); });
  mainWindow.on('closed', () => { mainWindow = null; });
}

ipcMain.handle('app:get-bootstrap', async () => ({
  version: app.getVersion(),
  dataDirectory: app.getPath('userData'),
  readOnly: false,
  instance: INSTANCE.instance,
}));

ipcMain.handle('watchlist:load', async () => {
  const [{ loadWatchlist }, { COLUMN_DEFINITIONS }] = await Promise.all([
    domainModule('watchlist-store'),
    domainModule('columns'),
  ]);
  return { document: await loadWatchlist(watchlistPath()), columns: COLUMN_DEFINITIONS };
});

ipcMain.handle('watchlist:cached', async () => {
  const [{ loadWatchlist }, { loadCachedRows }] = await Promise.all([
    domainModule('watchlist-store'), domainModule('fleet-database'),
  ]);
  const watchlist = await loadWatchlist(watchlistPath());
  const contracts = new Map(watchlist.entries.map((entry) => [entry.id, entry.contractAddress]));
  return loadCachedRows(sharedDatabasePath(), INSTANCE.instance)
    .filter((cached) => watchlist.entries.find((entry) => entry.id === cached.row.entry.id)?.enabled
      && contracts.get(cached.row.entry.id) === cached.row.entry.contractAddress)
    .map((cached) => ({
      id: cached.row.entry.id,
      ok: true,
      row: cached.row,
      source: 'cache',
      fetchedAtMs: cached.fetchedAtMs,
    }));
});

ipcMain.handle('watchlist:save', async (_event, document) => {
  const { saveWatchlist } = await domainModule('watchlist-store');
  await saveWatchlist(watchlistPath(), document);
  return { ok: true };
});

ipcMain.handle('settings:load', async () => {
  const [{ getRpcRequestsPerSecond }, settings] = await Promise.all([
    domainModule('fleet-database'), loadSettingsWithSecrets(),
  ]);
  return {
    ...settings,
    useRpcLimiter: false,
    rpcRequestsPerSecond: getRpcRequestsPerSecond(sharedDatabasePath()),
    aephiaApiKey: '',
    hotWalletSecret: '',
    hotWalletAddress: hotWalletAddress(settings),
    secureSettingsStatus: secureSettingsStatus(settings),
  };
});

ipcMain.handle('settings:save', async (_event, settings) => {
  const [{ saveSettings }, { setRpcRequestsPerSecond }] = await Promise.all([
    domainModule('settings-store'), domainModule('fleet-database'),
  ]);
  const current = await loadSettingsWithSecrets();
  const replacementKey = String(settings?.aephiaApiKey || '').trim();
  const replacementWallet = String(settings?.hotWalletSecret || '').trim();
  const nextWallet = replacementWallet || current.hotWalletSecret;
  if (replacementWallet) getHotWalletAddressFromSecret(replacementWallet);
  const replacements = {};
  if (replacementKey) replacements.aephiaApiKey = replacementKey;
  if (replacementWallet) replacements.hotWalletSecret = replacementWallet;
  if (Object.keys(replacements).length) await writeSecureValues(replacements);
  const nextSettings = { ...current, ...settings, useRpcLimiter: false, aephiaApiKey: '', walletAddress: nextWallet ? getHotWalletAddressFromSecret(nextWallet) : current.walletAddress };
  await saveSettings(settingsPath(), nextSettings);
  setRpcRequestsPerSecond(sharedDatabasePath(), nextSettings.rpcRequestsPerSecond);
  const next = { ...current, aephiaApiKey: replacementKey || current.aephiaApiKey, hotWalletSecret: nextWallet };
  return { ok: true, hotWalletAddress: hotWalletAddress(next), secureSettingsStatus: secureSettingsStatus(next) };
});

ipcMain.handle('settings:remove-hot-wallet', async () => {
  const { saveSettings } = await domainModule('settings-store');
  const current = await loadSettingsWithSecrets();
  await saveSettings(settingsPath(), { ...current, aephiaApiKey: '', walletAddress: '' });
  await writeSecureValues({ hotWalletSecret: '' });
  return { ok: true, hotWalletAddress: '', secureSettingsStatus: { hotWalletSecret: false } };
});

ipcMain.handle('profile:faction', async () => {
  const settings = await loadSettingsWithSecrets();
  if (!settings.playerProfile) return { faction: null, profileFactionAddress: null };
  const { resolvePlayerFaction } = await domainModule('profile-faction');
  return resolvePlayerFaction(settings.playerProfile, settings.rpcUrl);
});

ipcMain.handle('rpc-limiter:status', async () => {
  const { getRpcRequestsPerSecond } = await domainModule('fleet-database');
  return {
    stateFile: sharedDatabasePath(),
    enabled: true,
    activeUrl: 'Dedicated Fleet Rental Bot 2 RPC pacing',
    mainUrl: '',
    fallbackUrl: '',
    requestsPerSecond: getRpcRequestsPerSecond(sharedDatabasePath()),
    updatedAt: '',
  };
});

ipcMain.handle('refresh:next-delay', async (_event, endTimes) => {
  const { nextRefreshDelayMs } = await domainModule('refresh-schedule');
  const values = Array.isArray(endTimes)
    ? endTimes.map((value) => value === null || Number.isFinite(value) ? value : null)
    : [];
  return nextRefreshDelayMs(values);
});

ipcMain.handle('updates:check', async (event) => {
  requireTrustedUpdaterRenderer(event);
  return checkForUpdates();
});

ipcMain.handle('updates:download-and-restart', async (event) => {
  requireTrustedUpdaterRenderer(event);
  return downloadUpdateAndRestart();
});

ipcMain.handle('watchlist:refresh', async (_event, entryIds) => {
  const [{ loadWatchlist }, { refreshWatchlist, mergeRefreshWithCache }, { loadCachedRows, saveCachedRow }] = await Promise.all([
    domainModule('watchlist-store'), domainModule('live-refresh'), domainModule('fleet-database'),
  ]);
  const [watchlist, settings] = await Promise.all([
    loadWatchlist(watchlistPath()), loadRuntimeSettings(),
  ]);
  const requestedIds = Array.isArray(entryIds) ? new Set(entryIds.filter((value) => typeof value === 'string')) : null;
  const selectedEntries = requestedIds
    ? watchlist.entries.filter((entry) => requestedIds.has(entry.id))
    : watchlist.entries;
  const liveResults = await refreshWatchlist(selectedEntries, settings);
  for (const result of liveResults) {
    if (result.ok) saveCachedRow(sharedDatabasePath(), INSTANCE.instance, result.row, result.fetchedAtMs);
  }
  await scheduleLcfsAttempts(watchlist, settings, liveResults, new Set(selectedEntries.map((entry) => entry.id)));
  const expectedContracts = new Map(watchlist.entries.map((entry) => [entry.id, entry.contractAddress]));
  return mergeRefreshWithCache(liveResults, loadCachedRows(sharedDatabasePath(), INSTANCE.instance), expectedContracts);
});

ipcMain.handle('reservation:review', async (_event, entryId) => {
  if (typeof entryId !== 'string' || !entryId) throw new Error('Watchlist entry ID is required');
  const [{ loadWatchlist }, { prepareReservationReview }] = await Promise.all([
    domainModule('watchlist-store'), domainModule('reservation-review'),
  ]);
  const [watchlist, settings] = await Promise.all([
    loadWatchlist(watchlistPath()), loadRuntimeSettings(),
  ]);
  const entry = watchlist.entries.find((candidate) => candidate.id === entryId);
  if (!entry) throw new Error('Watchlist entry not found');
  return prepareReservationReview(entry, settings);
});

ipcMain.handle('reservation:simulate', async (_event, entryId) => {
  if (typeof entryId !== 'string' || !entryId) throw new Error('Watchlist entry ID is required');
  const [{ loadWatchlist }, { simulateReservation }] = await Promise.all([
    domainModule('watchlist-store'), domainModule('reservation-simulation'),
  ]);
  const [watchlist, settings] = await Promise.all([
    loadWatchlist(watchlistPath()), loadRuntimeSettings(),
  ]);
  const entry = watchlist.entries.find((candidate) => candidate.id === entryId);
  if (!entry) throw new Error('Watchlist entry not found');
  return simulateReservation(entry, settings);
});

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(async () => {
    const { installLimitedRpcFetch } = await domainModule('rpc-fetch-limiter');
    installLimitedRpcFetch(sharedDatabasePath());
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    for (const timer of lcfsTimers.values()) clearTimeout(timer);
    lcfsTimers.clear();
    if (process.platform !== 'darwin') app.quit();
  });
}
