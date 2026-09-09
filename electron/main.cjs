const path = require('node:path');
const fs = require('node:fs/promises');
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const { configureInstance } = require('./instance.cjs');

const INSTANCE = configureInstance(app, process.argv);
const hasSingleInstanceLock = app.requestSingleInstanceLock({ instance: INSTANCE.instance });
let mainWindow = null;

async function domainModule(name) {
  return import(`../dist/src/${name}.js`);
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

async function readSecureApiKey() {
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS safe storage is unavailable.');
    const document = JSON.parse(await fs.readFile(secureSettingsPath(), 'utf8'));
    return safeStorage.decryptString(Buffer.from(String(document.aephiaApiKey || ''), 'base64'));
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function writeSecureApiKey(value) {
  if (!String(value || '').trim()) return;
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS safe storage is unavailable; API key was not saved.');
  const filePath = secureSettingsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(`${filePath}.tmp`, `${JSON.stringify({ version: 1, aephiaApiKey: safeStorage.encryptString(String(value)).toString('base64') }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(`${filePath}.tmp`, filePath);
}

async function loadSettingsWithSecrets() {
  const { loadSettings, saveSettings } = await domainModule('settings-store');
  const settings = await loadSettings(settingsPath());
  let aephiaApiKey = await readSecureApiKey();
  if (!aephiaApiKey && settings.aephiaApiKey) {
    aephiaApiKey = settings.aephiaApiKey;
    await writeSecureApiKey(aephiaApiKey);
    await saveSettings(settingsPath(), { ...settings, aephiaApiKey: '' });
  }
  return { ...settings, aephiaApiKey };
}

async function loadRuntimeSettings() {
  const { resolveRpcUrl } = await domainModule('rpc-limiter');
  const settings = await loadSettingsWithSecrets();
  return { ...settings, rpcUrl: await resolveRpcUrl(settings.useRpcLimiter, settings.rpcUrl) };
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
  mainWindow.on('closed', () => { mainWindow = null; });
}

ipcMain.handle('app:get-bootstrap', async () => ({
  version: app.getVersion(),
  dataDirectory: app.getPath('userData'),
  readOnly: true,
  instance: INSTANCE.instance,
}));

ipcMain.handle('watchlist:load', async () => {
  const [{ loadWatchlist }, { COLUMN_DEFINITIONS }] = await Promise.all([
    domainModule('watchlist-store'),
    domainModule('columns'),
  ]);
  return { document: await loadWatchlist(watchlistPath()), columns: COLUMN_DEFINITIONS };
});

ipcMain.handle('watchlist:save', async (_event, document) => {
  const { saveWatchlist } = await domainModule('watchlist-store');
  await saveWatchlist(watchlistPath(), document);
  return { ok: true };
});

ipcMain.handle('settings:load', async () => {
  const settings = await loadSettingsWithSecrets();
  return { ...settings, aephiaApiKey: '', secureSettingsStatus: { aephiaApiKey: Boolean(settings.aephiaApiKey) } };
});

ipcMain.handle('settings:save', async (_event, settings) => {
  const { saveSettings } = await domainModule('settings-store');
  const current = await loadSettingsWithSecrets();
  const replacementKey = String(settings?.aephiaApiKey || '').trim();
  if (replacementKey) await writeSecureApiKey(replacementKey);
  await saveSettings(settingsPath(), { ...current, ...settings, aephiaApiKey: '' });
  return { ok: true, secureSettingsStatus: { aephiaApiKey: Boolean(replacementKey || current.aephiaApiKey) } };
});

ipcMain.handle('profile:faction', async () => {
  const settings = await loadSettingsWithSecrets();
  if (!settings.playerProfile) return { faction: null, profileFactionAddress: null };
  const [{ resolveRpcUrl }, { resolvePlayerFaction }] = await Promise.all([
    domainModule('rpc-limiter'), domainModule('profile-faction'),
  ]);
  const rpcUrl = await resolveRpcUrl(settings.useRpcLimiter, settings.rpcUrl);
  return resolvePlayerFaction(settings.playerProfile, rpcUrl);
});

ipcMain.handle('rpc-limiter:status', async () => {
  const { getRpcLimiterStatus } = await domainModule('rpc-limiter');
  return getRpcLimiterStatus();
});

ipcMain.handle('watchlist:refresh', async () => {
  const [{ loadWatchlist }, { refreshWatchlist }] = await Promise.all([
    domainModule('watchlist-store'), domainModule('live-refresh'),
  ]);
  const [watchlist, settings] = await Promise.all([
    loadWatchlist(watchlistPath()), loadRuntimeSettings(),
  ]);
  return refreshWatchlist(watchlist.entries, settings);
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
  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
