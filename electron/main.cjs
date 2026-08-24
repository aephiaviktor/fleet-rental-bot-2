const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#07111a',
    title: 'Fleet Rental Bot 2',
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
  const { loadSettings } = await domainModule('settings-store');
  return loadSettings(settingsPath());
});

ipcMain.handle('settings:save', async (_event, settings) => {
  const { saveSettings } = await domainModule('settings-store');
  await saveSettings(settingsPath(), settings);
  return { ok: true };
});

ipcMain.handle('watchlist:refresh', async () => {
  const [{ loadWatchlist }, { loadSettings }, { refreshWatchlist }] = await Promise.all([
    domainModule('watchlist-store'), domainModule('settings-store'), domainModule('live-refresh'),
  ]);
  const [watchlist, settings] = await Promise.all([
    loadWatchlist(watchlistPath()), loadSettings(settingsPath()),
  ]);
  return refreshWatchlist(watchlist.entries, settings);
});

ipcMain.handle('reservation:review', async (_event, entryId) => {
  if (typeof entryId !== 'string' || !entryId) throw new Error('Watchlist entry ID is required');
  const [{ loadWatchlist }, { loadSettings }, { prepareReservationReview }] = await Promise.all([
    domainModule('watchlist-store'), domainModule('settings-store'), domainModule('reservation-review'),
  ]);
  const [watchlist, settings] = await Promise.all([
    loadWatchlist(watchlistPath()), loadSettings(settingsPath()),
  ]);
  const entry = watchlist.entries.find((candidate) => candidate.id === entryId);
  if (!entry) throw new Error('Watchlist entry not found');
  return prepareReservationReview(entry, settings);
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
