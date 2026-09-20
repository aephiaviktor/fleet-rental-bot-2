const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fleetRentalBot', {
  openHistoryTransaction: (signature) => ipcRenderer.invoke('history:open-transaction', signature),
  openHistoryAccount: (address) => ipcRenderer.invoke('history:open-account', address),
  loadRentalHistory: (refresh = false) => ipcRenderer.invoke('history:load', refresh),
  getBootstrap: () => ipcRenderer.invoke('app:get-bootstrap'),
  getAephiaAccessStatus: () => ipcRenderer.invoke('access:status'),
  verifyAephiaApiKey: (apiKey) => ipcRenderer.invoke('access:unlock', apiKey),
  loadWatchlist: () => ipcRenderer.invoke('watchlist:load'),
  saveWatchlist: (document) => ipcRenderer.invoke('watchlist:save', document),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  removeHotWallet: () => ipcRenderer.invoke('settings:remove-hot-wallet'),
  getPlayerFaction: () => ipcRenderer.invoke('profile:faction'),
  getRpcLimiterStatus: () => ipcRenderer.invoke('rpc-limiter:status'),
  getRpcUsageDay: (utcDate) => ipcRenderer.invoke('rpc-usage:day', utcDate),
  loadCachedWatchlist: () => ipcRenderer.invoke('watchlist:cached'),
  refreshWatchlist: (entryIds) => ipcRenderer.invoke('watchlist:refresh', entryIds),
  getNextRefreshDelay: (endTimes) => ipcRenderer.invoke('refresh:next-delay', endTimes),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdateAndRestart: () => ipcRenderer.invoke('updates:download-and-restart'),
  onUpdateProgress: (listener) => {
    const wrapped = (_event, progress) => listener(progress);
    ipcRenderer.on('update:progress', wrapped);
    return () => ipcRenderer.removeListener('update:progress', wrapped);
  },
  prepareReservationReview: (entryId) => ipcRenderer.invoke('reservation:review', entryId),
  simulateReservation: (entryId) => ipcRenderer.invoke('reservation:simulate', entryId),
  onLcfsStatus: (listener) => ipcRenderer.on('lcfs:status', (_event, status) => listener(status)),
  onAephiaAccessStatus: (listener) => ipcRenderer.on('access:status', (_event, status) => listener(status)),
});
