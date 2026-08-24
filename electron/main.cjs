const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

let mainWindow = null;

async function domainModule(name) {
  return import(`../dist/src/${name}.js`);
}

function watchlistPath() {
  return path.join(app.getPath('userData'), 'watchlist.json');
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

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
