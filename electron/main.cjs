const path = require('node:path');
const fs = require('node:fs/promises');
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const { configureInstance } = require('./instance.cjs');
const { getHotWalletAddressFromSecret } = require('./wallet-secret.cjs');

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
  const { resolveRpcUrl } = await domainModule('rpc-limiter');
  const settings = await loadSettingsWithSecrets();
  const walletAddress = settings.hotWalletSecret
    ? getHotWalletAddressFromSecret(settings.hotWalletSecret)
    : settings.walletAddress;
  return { ...settings, walletAddress, rpcUrl: await resolveRpcUrl(settings.useRpcLimiter, settings.rpcUrl) };
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
  return {
    ...settings,
    aephiaApiKey: '',
    hotWalletSecret: '',
    hotWalletAddress: hotWalletAddress(settings),
    secureSettingsStatus: secureSettingsStatus(settings),
  };
});

ipcMain.handle('settings:save', async (_event, settings) => {
  const { saveSettings } = await domainModule('settings-store');
  const current = await loadSettingsWithSecrets();
  const replacementKey = String(settings?.aephiaApiKey || '').trim();
  const replacementWallet = String(settings?.hotWalletSecret || '').trim();
  const nextWallet = replacementWallet || current.hotWalletSecret;
  if (replacementWallet) getHotWalletAddressFromSecret(replacementWallet);
  const replacements = {};
  if (replacementKey) replacements.aephiaApiKey = replacementKey;
  if (replacementWallet) replacements.hotWalletSecret = replacementWallet;
  if (Object.keys(replacements).length) await writeSecureValues(replacements);
  await saveSettings(settingsPath(), { ...current, ...settings, aephiaApiKey: '', walletAddress: nextWallet ? getHotWalletAddressFromSecret(nextWallet) : current.walletAddress });
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
